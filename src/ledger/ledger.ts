import { Tx } from '../db';
import { HttpError } from '../errors';

export type Direction = 'debit' | 'credit';
export interface Entry { accountId: string; direction: Direction; amount: number }

export function assertBalanced(entries: Entry[]) {
  const net = entries.reduce((s, e) => s + (e.direction === 'debit' ? e.amount : -e.amount), 0);
  if (entries.length < 2 || net !== 0) throw new Error(`unbalanced ledger transaction (net ${net})`);
  if (entries.some((e) => !Number.isSafeInteger(e.amount) || e.amount <= 0)) throw new Error('invalid ledger amount');
}

/**
 * Posts one balanced ledger transaction and updates cached balances.
 * Accounts are locked in a deterministic order (by id) to prevent deadlocks.
 * Balance convention: credit-normal (credit +, debit -).
 */
export async function postLedgerTransaction(
  tx: Tx, paymentId: string, kind: 'payment' | 'refund', entries: Entry[],
  opts: { nonNegative?: string[] } = {},
): Promise<string> {
  assertBalanced(entries);
  const ids = [...new Set(entries.map((e) => e.accountId))].sort();
  const locked = await tx.query(`SELECT id, balance FROM accounts WHERE id = ANY($1::uuid[]) ORDER BY id FOR UPDATE`, [ids]);
  if (locked.rowCount !== ids.length) throw new Error('ledger account missing');

  const delta = new Map<string, number>();
  for (const e of entries) delta.set(e.accountId, (delta.get(e.accountId) ?? 0) + (e.direction === 'credit' ? e.amount : -e.amount));
  for (const row of locked.rows) {
    if (opts.nonNegative?.includes(row.id) && row.balance + (delta.get(row.id) ?? 0) < 0) {
      throw new HttpError(409, 'insufficient_merchant_balance', 'merchant balance too low for this refund');
    }
  }

  const ltx = await tx.query(`INSERT INTO ledger_transactions (payment_id, kind) VALUES ($1,$2) RETURNING id`, [paymentId, kind]);
  const ltxId: string = ltx.rows[0].id;
  const values: unknown[] = [ltxId];
  const tuples = entries.map((e, i) => {
    values.push(e.accountId, e.direction, e.amount);
    return `($1,$${i * 3 + 2},$${i * 3 + 3},$${i * 3 + 4})`;
  });
  await tx.query(`INSERT INTO ledger_entries (ledger_tx_id, account_id, direction, amount) VALUES ${tuples.join(',')}`, values);
  for (const [accountId, d] of delta) await tx.query(`UPDATE accounts SET balance = balance + $2 WHERE id=$1`, [accountId, d]);
  return ltxId;
}
