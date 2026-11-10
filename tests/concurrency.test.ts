import { Ctx, createPayment, refundPayment } from '../src/payments/service';
import { reconcile } from '../src/reconciliation/reconcile';
import { count, merchantBalance, pay, resetDb, setup } from './helpers';

describe('concurrency', () => {
  let ctx: Ctx;
  beforeAll(async () => { ctx = await setup(); });
  beforeEach(() => resetDb(ctx.pool));
  afterAll(() => ctx.pool.end());

  it('100 parallel payments to one merchant leave balances exactly correct', async () => {
    const amounts = Array.from({ length: 100 }, (_, i) => 100 + i * 7);
    const results = await Promise.all(amounts.map((a, i) => createPayment(ctx, 'hot', `k${i}`, pay({ amount: a }))));
    expect(results.every((r) => r.status === 201)).toBe(true);

    const fee = (a: number) => Math.floor((a * ctx.cfg.feeBps) / 10_000);
    const expectedNet = amounts.reduce((s, a) => s + a - fee(a), 0);
    const expectedFees = amounts.reduce((s, a) => s + fee(a), 0);
    expect(await merchantBalance(ctx.pool, 'hot')).toBe(expectedNet);
    const { rows } = await ctx.pool.query(`SELECT type, balance FROM accounts WHERE owner_id='platform'`);
    expect(rows.find((r) => r.type === 'platform_fees').balance).toBe(expectedFees);
    expect(rows.find((r) => r.type === 'clearing').balance).toBe(-amounts.reduce((s, a) => s + a, 0));
    expect(await count(ctx.pool, 'ledger_transactions')).toBe(100);
    expect((await reconcile(ctx.pool)).ok).toBe(true);
  });

  it('parallel payments across many merchants do not interfere (no deadlocks)', async () => {
    const jobs = Array.from({ length: 60 }, (_, i) => createPayment(ctx, `m${i % 6}`, `k${i}`, pay({ amount: 1000 })));
    const results = await Promise.all(jobs);
    expect(results.every((r) => r.status === 201)).toBe(true);
    expect((await reconcile(ctx.pool)).ok).toBe(true);
  });

  it('20 parallel refunds of one payment (different keys): exactly one wins', async () => {
    const p = await createPayment(ctx, 'm1', 'orig', pay({ amount: 5000 }));
    const settled = await Promise.allSettled(Array.from({ length: 20 }, (_, i) => refundPayment(ctx, 'm1', `r${i}`, p.body.id)));
    expect(settled.filter((s) => s.status === 'fulfilled')).toHaveLength(1);
    expect(settled.filter((s) => s.status === 'rejected').every((s: any) => s.reason.status === 409)).toBe(true);
    expect(await count(ctx.pool, 'ledger_transactions', `kind='refund'`)).toBe(1);
    expect(await merchantBalance(ctx.pool, 'm1')).toBe(0);
    expect((await reconcile(ctx.pool)).ok).toBe(true);
  });

  it('mixed concurrent payments and refunds stay reconciled', async () => {
    const first = await Promise.all(Array.from({ length: 10 }, (_, i) => createPayment(ctx, 'm1', `p${i}`, pay({ amount: 999 }))));
    await Promise.all([
      ...first.map((r, i) => refundPayment(ctx, 'm1', `rf${i}`, r.body.id)),
      ...Array.from({ length: 10 }, (_, i) => createPayment(ctx, 'm1', `q${i}`, pay({ amount: 500 }))),
    ]);
    expect((await reconcile(ctx.pool)).ok).toBe(true);
  });
});
