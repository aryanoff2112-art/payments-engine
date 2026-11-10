import { Ctx, createPayment, refundPayment } from '../src/payments/service';
import { reconcile } from '../src/reconciliation/reconcile';
import { count, merchantBalance, pay, resetDb, setup } from './helpers';

describe('failed transactions never corrupt the ledger', () => {
  let ctx: Ctx;
  const hooks: any = {};
  beforeAll(async () => { ctx = await setup({}, { hooks }); });
  beforeEach(async () => { await resetDb(ctx.pool); delete hooks.afterLedger; delete hooks.beforeCommit; });
  afterAll(() => ctx.pool.end());

  it.each(['tok_decline', 'tok_insufficient_funds', 'tok_expired_card', 'tok_unknown'])('%s: failed payment has zero ledger rows', async (tok) => {
    const r = await createPayment(ctx, 'm1', 'k', pay({ paymentMethod: tok }));
    expect(r.status).toBe(402);
    expect(r.body.status).toBe('failed');
    expect(await count(ctx.pool, 'ledger_transactions')).toBe(0);
    expect(await count(ctx.pool, 'ledger_entries')).toBe(0);
    expect(await merchantBalance(ctx.pool, 'm1')).toBe(0);
    expect(await count(ctx.pool, 'outbox_events', `type='payment.failed'`)).toBe(1);
    expect((await reconcile(ctx.pool)).ok).toBe(true);
  });

  it('processor outage (502) persists nothing, and a retry with the same key succeeds exactly once', async () => {
    await expect(createPayment(ctx, 'm1', 'outage', pay({ paymentMethod: 'tok_error' }))).rejects.toMatchObject({ status: 502 });
    expect(await count(ctx.pool, 'payments')).toBe(0);
    expect(await count(ctx.pool, 'idempotency_keys')).toBe(0);
    const ok = await createPayment(ctx, 'm1', 'outage', pay({ paymentMethod: 'tok_success', amount: 1000 }));
    expect(ok.status).toBe(201);
    expect(await count(ctx.pool, 'payments')).toBe(1);
  });

  it('crash after the ledger write but before commit rolls back everything; retry is exactly-once', async () => {
    let boom = true;
    hooks.afterLedger = () => { if (boom) throw new Error('simulated crash'); };
    const body = pay();
    await expect(createPayment(ctx, 'm1', 'crash', body)).rejects.toThrow('simulated crash');
    for (const t of ['payments', 'ledger_transactions', 'ledger_entries', 'outbox_events', 'idempotency_keys']) expect(await count(ctx.pool, t)).toBe(0);
    expect(await merchantBalance(ctx.pool, 'm1')).toBe(0);

    boom = false;
    const r = await createPayment(ctx, 'm1', 'crash', body);
    expect(r.status).toBe(201);
    expect(await count(ctx.pool, 'ledger_transactions')).toBe(1);
    expect((await reconcile(ctx.pool)).ok).toBe(true);
  });

  it('crash right before COMMIT leaves no trace either', async () => {
    hooks.beforeCommit = () => { throw new Error('crash before commit'); };
    await expect(createPayment(ctx, 'm1', 'c2', pay())).rejects.toThrow();
    for (const t of ['payments', 'ledger_entries', 'idempotency_keys']) expect(await count(ctx.pool, t)).toBe(0);
  });

  it('a refund that would overdraw the merchant is rejected and leaves no ledger rows', async () => {
    const p = await createPayment(ctx, 'm1', 'p', pay({ amount: 10_000 }));
    await ctx.pool.query(`UPDATE accounts SET balance = 0 WHERE owner_id='m1' AND type='merchant'`); // simulate funds already paid out
    await expect(refundPayment(ctx, 'm1', 'r', p.body.id)).rejects.toMatchObject({ status: 409 });
    expect(await count(ctx.pool, 'ledger_transactions', `kind='refund'`)).toBe(0);
    expect((await ctx.pool.query(`SELECT status FROM payments`)).rows[0].status).toBe('succeeded');
  });
});
