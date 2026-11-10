import { Pool } from 'pg';
import { z } from 'zod';
import { Config } from '../config';
import { Cache } from '../cache';
import { Tx } from '../db';
import { HttpError } from '../errors';
import { sha256, requestHash } from '../util';
import { assessFraud } from '../fraud/rules';
import { Entry, postLedgerTransaction } from '../ledger/ledger';
import { Processor } from './processor';
import { transition } from './stateMachine';

/** Fault-injection points used by tests to simulate crashes mid-transaction. */
export interface Hooks {
  afterLedger?: (paymentId: string) => Promise<void> | void;
  beforeCommit?: () => Promise<void> | void;
}

export interface Ctx { pool: Pool; cache: Cache; cfg: Config; processor: Processor; hooks?: Hooks }
export interface HttpResult { status: number; body: any; replayed?: boolean }

export const paymentSchema = z.object({
  amount: z.number().int().positive().max(100_000_000_000),
  currency: z.enum(['USD', 'EUR', 'GBP', 'INR']),
  // Simulated tokens only. Anything that looks like a card number cannot match this pattern.
  paymentMethod: z.string().regex(/^tok_[a-z0-9_]{1,40}$/, 'use a simulated tok_* payment method'),
  customerId: z.string().max(64).optional(),
  description: z.string().max(255).optional(),
}).strict();
export type PaymentRequest = z.infer<typeof paymentSchema>;

const publicPayment = (p: any) => ({
  id: p.id, status: p.status, amount: Number(p.amount), currency: p.currency.trim(), fee: Number(p.fee),
  failure_reason: p.failure_reason, flagged_for_review: p.flagged_for_review, fraud_score: p.fraud_score,
  created_at: p.created_at instanceof Date ? p.created_at.toISOString() : p.created_at,
});
export { publicPayment };

// ---------- accounts ----------
const provisioned = new Set<string>();
/** Idempotent, outside any request transaction, so concurrent first payments never contend on inserts. */
export async function ensureAccounts(pool: Pool, merchantId: string, currency: string) {
  const k = `${merchantId}:${currency}`;
  if (provisioned.has(k)) return;
  for (const [owner, type] of [['platform', 'clearing'], ['platform', 'platform_fees'], [merchantId, 'merchant']] as const) {
    await pool.query(`INSERT INTO accounts (owner_id, type, currency) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`, [owner, type, currency]);
  }
  provisioned.add(k);
}
export const forgetProvisionedAccounts = () => provisioned.clear();

async function getAccounts(tx: Tx, merchantId: string, currency: string) {
  const { rows } = await tx.query(
    `SELECT id, type FROM accounts WHERE currency=$2 AND
       ((owner_id='platform' AND type IN ('clearing','platform_fees')) OR (owner_id=$1 AND type='merchant'))`,
    [merchantId, currency]);
  const by = (t: string) => rows.find((r) => r.type === t)?.id as string;
  const out = { merchant: by('merchant'), clearing: by('clearing'), fees: by('platform_fees') };
  if (!out.merchant || !out.clearing || !out.fees) throw new Error('accounts not provisioned');
  return out;
}

// ---------- generic idempotent wrapper ----------
export async function withIdempotency(
  ctx: Ctx, merchantId: string, key: string, endpoint: string, body: unknown,
  work: (tx: Tx) => Promise<HttpResult>,
): Promise<HttpResult> {
  const hash = requestHash(endpoint, body);

  const cached = await ctx.cache.getIdem(merchantId, key);
  if (cached) {
    if (cached.hash !== hash) throw new HttpError(422, 'idempotency_key_reused', 'key reused with a different request');
    return { status: cached.status, body: cached.body, replayed: true };
  }

  const tx = await ctx.pool.connect();
  let open = false;
  try {
    await tx.query('BEGIN'); open = true;
    // Concurrent duplicates block on this insert until the first transaction commits or rolls back.
    const claim = await tx.query(
      `INSERT INTO idempotency_keys (merchant_id, key, request_hash) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING RETURNING 1`,
      [merchantId, key, hash]);

    if (claim.rowCount === 0) {
      const { rows } = await tx.query(
        `SELECT request_hash, status_code, response FROM idempotency_keys WHERE merchant_id=$1 AND key=$2`, [merchantId, key]);
      await tx.query('ROLLBACK'); open = false;
      const row = rows[0];
      if (row.request_hash !== hash) throw new HttpError(422, 'idempotency_key_reused', 'key reused with a different request');
      return { status: row.status_code, body: row.response, replayed: true };
    }

    const result = await work(tx);
    await tx.query(`UPDATE idempotency_keys SET status_code=$3, response=$4 WHERE merchant_id=$1 AND key=$2`,
      [merchantId, key, result.status, JSON.stringify(result.body)]);
    await ctx.hooks?.beforeCommit?.();
    await tx.query('COMMIT'); open = false;

    await ctx.cache.setIdem(merchantId, key, { hash, status: result.status, body: result.body }, ctx.cfg.idempotencyCacheTtlSec);
    await ctx.cache.publishWake();
    return result;
  } catch (e) {
    if (open) await tx.query('ROLLBACK').catch(() => undefined);
    throw e;
  } finally {
    tx.release();
  }
}

// ---------- create payment ----------
export async function createPayment(ctx: Ctx, merchantId: string, key: string, req: PaymentRequest): Promise<HttpResult> {
  await ensureAccounts(ctx.pool, merchantId, req.currency);
  return withIdempotency(ctx, merchantId, key, 'POST /v1/payments', req, async (tx) => {
    const accts = await getAccounts(tx, merchantId, req.currency);
    const fingerprint = sha256(`${req.paymentMethod}|${req.customerId ?? ''}`).slice(0, 16);

    const { rows: [pay] } = await tx.query(
      `INSERT INTO payments (merchant_id, amount, currency, status, payment_method, customer_id, description, fingerprint)
       VALUES ($1,$2,$3,'pending',$4,$5,$6,$7) RETURNING id`,
      [merchantId, req.amount, req.currency, req.paymentMethod, req.customerId ?? null, req.description ?? null, fingerprint]);
    const id: string = pay.id;

    const fraud = await assessFraud(tx, ctx.cfg.fraud, { merchantId, fingerprint, amount: req.amount, paymentId: id });
    await transition(tx, id, 'pending', 'processing');

    const outcome = fraud.decision === 'block'
      ? ({ ok: false, reason: 'fraud_suspected' } as const)
      : await ctx.processor(req.paymentMethod);   // throws on outage -> whole tx rolls back, client retries

    let fee = 0;
    if (outcome.ok) {
      fee = Math.floor((req.amount * ctx.cfg.feeBps) / 10_000);
      const entries: Entry[] = [
        { accountId: accts.clearing, direction: 'debit', amount: req.amount },
        { accountId: accts.merchant, direction: 'credit', amount: req.amount - fee },
      ];
      if (fee > 0) entries.push({ accountId: accts.fees, direction: 'credit', amount: fee });
      await postLedgerTransaction(tx, id, 'payment', entries);
      await ctx.hooks?.afterLedger?.(id);
    }

    const status = outcome.ok ? 'succeeded' : 'failed';
    await transition(tx, id, 'processing', status, {
      failureReason: outcome.ok ? null : outcome.reason, fee,
      fraudScore: fraud.score, fraudFlags: fraud.flags, flagged: fraud.decision === 'review',
    });

    const { rows: [final] } = await tx.query(`SELECT * FROM payments WHERE id=$1`, [id]);
    const body = publicPayment(final);
    await tx.query(`INSERT INTO outbox_events (merchant_id, payment_id, type, payload) VALUES ($1,$2,$3,$4)`,
      [merchantId, id, `payment.${status}`, JSON.stringify(body)]);
    return { status: outcome.ok ? 201 : 402, body };
  });
}

// ---------- refund ----------
export async function refundPayment(ctx: Ctx, merchantId: string, key: string, paymentId: string): Promise<HttpResult> {
  return withIdempotency(ctx, merchantId, key, `POST /v1/payments/${paymentId}/refund`, {}, async (tx) => {
    const { rows: [p] } = await tx.query(`SELECT * FROM payments WHERE id=$1 AND merchant_id=$2 FOR UPDATE`, [paymentId, merchantId]);
    if (!p) throw new HttpError(404, 'payment_not_found');
    if (p.status !== 'succeeded') throw new HttpError(409, 'not_refundable', `payment is ${p.status}`);

    const { rows: entries } = await tx.query(
      `SELECT e.account_id, e.direction, e.amount, a.type
         FROM ledger_transactions lt JOIN ledger_entries e ON e.ledger_tx_id = lt.id JOIN accounts a ON a.id = e.account_id
        WHERE lt.payment_id=$1 AND lt.kind='payment'`, [paymentId]);
    const reversed: Entry[] = entries.map((e) => ({
      accountId: e.account_id, direction: e.direction === 'debit' ? 'credit' : 'debit', amount: e.amount }));
    const merchantAcct = entries.find((e) => e.type === 'merchant')!.account_id as string;

    await transition(tx, paymentId, 'succeeded', 'refunded');
    await postLedgerTransaction(tx, paymentId, 'refund', reversed, { nonNegative: [merchantAcct] });
    await ctx.hooks?.afterLedger?.(paymentId);

    const { rows: [final] } = await tx.query(`SELECT * FROM payments WHERE id=$1`, [paymentId]);
    const body = publicPayment(final);
    await tx.query(`INSERT INTO outbox_events (merchant_id, payment_id, type, payload) VALUES ($1,$2,'payment.refunded',$3)`,
      [merchantId, paymentId, JSON.stringify(body)]);
    return { status: 200, body };
  });
}

export async function getPayment(pool: Pool, merchantId: string, id: string) {
  const { rows: [p] } = await pool.query(`SELECT * FROM payments WHERE id=$1 AND merchant_id=$2`, [id, merchantId]);
  if (!p) throw new HttpError(404, 'payment_not_found');
  return publicPayment(p);
}

export async function getBalance(pool: Pool, merchantId: string) {
  const { rows } = await pool.query(`SELECT currency, balance FROM accounts WHERE owner_id=$1 AND type='merchant'`, [merchantId]);
  return rows.map((r) => ({ currency: String(r.currency).trim(), balance: r.balance }));
}
