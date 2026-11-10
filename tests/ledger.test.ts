import fc from 'fast-check';
import { Ctx, createPayment, refundPayment } from '../src/payments/service';
import { assertBalanced, postLedgerTransaction } from '../src/ledger/ledger';
import { reconcile } from '../src/reconciliation/reconcile';
import { count, merchantBalance, pay, resetDb, setup, tamper } from './helpers';

describe('double-entry ledger', () => {
  let ctx: Ctx;
  beforeAll(async () => { ctx = await setup(); });
  beforeEach(() => resetDb(ctx.pool));
  afterAll(() => ctx.pool.end());

  const allBalanced = async () => {
    const { rows } = await ctx.pool.query(
      `SELECT lt.id FROM ledger_transactions lt JOIN ledger_entries e ON e.ledger_tx_id=lt.id
        GROUP BY lt.id HAVING SUM(CASE e.direction WHEN 'debit' THEN e.amount ELSE -e.amount END) <> 0`);
    return rows.length === 0;
  };

  it('assertBalanced rejects unbalanced, single-leg and non-positive entries', () => {
    expect(() => assertBalanced([{ accountId: 'a', direction: 'debit', amount: 5 }, { accountId: 'b', direction: 'credit', amount: 4 }])).toThrow(/unbalanced/);
    expect(() => assertBalanced([{ accountId: 'a', direction: 'debit', amount: 5 }])).toThrow();
    expect(() => assertBalanced([{ accountId: 'a', direction: 'debit', amount: 0 }, { accountId: 'b', direction: 'credit', amount: 0 }])).toThrow();
  });

  it('the database itself rejects an unbalanced ledger transaction at COMMIT', async () => {
    const p = await createPayment(ctx, 'm1', 'k', pay({ amount: 1000 }));
    const { rows: [a] } = await ctx.pool.query(`SELECT id FROM accounts WHERE type='merchant'`);
    const c = await ctx.pool.connect();
    try {
      await c.query('BEGIN');
      const { rows: [{ id }] } = await c.query(`INSERT INTO ledger_transactions (payment_id, kind) VALUES ($1,'refund') RETURNING id`, [p.body.id]);
      await c.query(`INSERT INTO ledger_entries (ledger_tx_id, account_id, direction, amount) VALUES ($1,$2,'debit',100)`, [id, a.id]);
      await expect(c.query('COMMIT')).rejects.toThrow(/unbalanced ledger transaction/);
    } finally { await c.query('ROLLBACK').catch(() => undefined); c.release(); }
    expect(await count(ctx.pool, 'ledger_transactions', `kind='refund'`)).toBe(0);
  });

  it('application code refuses unbalanced postings before touching the DB', async () => {
    const c = await ctx.pool.connect();
    await expect(postLedgerTransaction(c, 'x', 'payment', [{ accountId: 'a', direction: 'debit', amount: 5 }])).rejects.toThrow(/unbalanced/);
    c.release();
  });

  it('ledger entries are append-only (UPDATE and DELETE are rejected)', async () => {
    await createPayment(ctx, 'm1', 'k', pay());
    await expect(ctx.pool.query(`DELETE FROM ledger_entries`)).rejects.toThrow(/append-only/);
    await expect(ctx.pool.query(`UPDATE ledger_entries SET amount = amount + 1`)).rejects.toThrow(/append-only/);
  });

  it('every completed ledger transaction balances, including fees and refunds', async () => {
    const rs = await Promise.all([1, 2, 3, 17, 999, 123456].map((a, i) => createPayment(ctx, 'm1', `k${i}`, pay({ amount: a }))));
    await refundPayment(ctx, 'm1', 'rf', rs[4].body.id);
    expect(await allBalanced()).toBe(true);
  });

  it('PROPERTY: any random sequence of payments/declines/refunds keeps all invariants', async () => {
    const op = fc.record({
      amount: fc.integer({ min: 1, max: 5_000_000 }),
      method: fc.constantFrom('tok_success', 'tok_success', 'tok_decline', 'tok_insufficient_funds'),
      merchant: fc.constantFrom('a', 'b', 'c'),
      refund: fc.boolean(),
    });
    await fc.assert(
      fc.asyncProperty(fc.array(op, { minLength: 1, maxLength: 12 }), async (ops) => {
        await resetDb(ctx.pool);
        const fee = (a: number) => Math.floor((a * ctx.cfg.feeBps) / 10_000);
        const expected: Record<string, number> = {};
        for (const [i, o] of ops.entries()) {
          const r = await createPayment(ctx, o.merchant, `k${i}`, pay({ amount: o.amount, paymentMethod: o.method, currency: 'USD' }));
          if (r.body.status === 'succeeded') {
            expected[o.merchant] = (expected[o.merchant] ?? 0) + o.amount - fee(o.amount);
            if (o.refund) { await refundPayment(ctx, o.merchant, `r${i}`, r.body.id); expected[o.merchant] -= o.amount - fee(o.amount); }
          }
        }
        expect(await allBalanced()).toBe(true);
        for (const m of Object.keys(expected)) expect(await merchantBalance(ctx.pool, m)).toBe(expected[m]);
        const { rows: [{ total }] } = await ctx.pool.query(`SELECT COALESCE(SUM(balance),0)::bigint AS total FROM accounts`);
        expect(total).toBe(0);
        expect((await reconcile(ctx.pool)).ok).toBe(true);
      }),
      { numRuns: 30 },
    );
  });

  it('tamper helper really bypasses triggers (sanity check for the reconciliation tests)', async () => {
    await createPayment(ctx, 'm1', 'k', pay());
    await tamper(ctx.pool, `DELETE FROM ledger_entries WHERE id = (SELECT MIN(id) FROM ledger_entries)`);
    expect(await count(ctx.pool, 'ledger_entries')).toBe(2);
  });
});
