import { Ctx, createPayment, refundPayment } from '../src/payments/service';
import { reconcile } from '../src/reconciliation/reconcile';
import { pay, resetDb, setup, tamper } from './helpers';

describe('reconciliation identifies deliberately introduced discrepancies', () => {
  let ctx: Ctx;
  let paymentId: string;
  beforeAll(async () => { ctx = await setup(); });
  afterAll(() => ctx.pool.end());
  beforeEach(async () => {
    await resetDb(ctx.pool);
    const a = await createPayment(ctx, 'm1', 'a', pay({ amount: 10_000 }));
    await createPayment(ctx, 'm1', 'b', pay({ amount: 2_000 }));
    await createPayment(ctx, 'm1', 'c', pay({ paymentMethod: 'tok_decline' }));
    const r = await createPayment(ctx, 'm1', 'd', pay({ amount: 3_000 }));
    await refundPayment(ctx, 'm1', 'e', r.body.id);
    paymentId = a.body.id;
  });
  const checks = async () => (await reconcile(ctx.pool)).discrepancies.map((d) => d.check);

  it('a clean system reports no discrepancies', async () => {
    const r = await reconcile(ctx.pool);
    expect(r.ok).toBe(true);
    expect(r.discrepancies).toEqual([]);
  });

  it('detects a cached balance that drifted by 1 cent', async () => {
    await ctx.pool.query(`UPDATE accounts SET balance = balance + 1 WHERE type='merchant'`);
    const r = await reconcile(ctx.pool);
    expect(r.ok).toBe(false);
    expect(r.discrepancies.map((d) => d.check)).toEqual(expect.arrayContaining(['account_balance_mismatch', 'global_balance_nonzero']));
    expect(r.discrepancies.find((d) => d.check === 'account_balance_mismatch')!.detail).toMatchObject({ computed: expect.any(Number), balance: expect.any(Number) });
  });

  it('detects a deleted ledger entry', async () => {
    await tamper(ctx.pool, `DELETE FROM ledger_entries WHERE id = (SELECT MIN(id) FROM ledger_entries)`);
    expect(await checks()).toEqual(expect.arrayContaining(['unbalanced_ledger_transaction', 'account_balance_mismatch']));
  });

  it('detects a ledger entry whose amount was altered', async () => {
    await tamper(ctx.pool, `UPDATE ledger_entries SET amount = amount + 5 WHERE id = (SELECT MIN(id) FROM ledger_entries)`);
    expect(await checks()).toContain('unbalanced_ledger_transaction');
  });

  it('detects a succeeded payment with no ledger transaction', async () => {
    await tamper(ctx.pool, `INSERT INTO payments (merchant_id, amount, currency, status, payment_method, fingerprint) VALUES ('m1', 500, 'USD', 'succeeded', 'tok_success', 'x')`);
    const c = await checks();
    expect(c).toContain('payment_ledger_mismatch');
    expect(c).toContain('missing_outbox_event');
  });

  it('detects a failed payment that has a ledger transaction', async () => {
    const { rows: [f] } = await ctx.pool.query(`SELECT id FROM payments WHERE status='failed'`);
    const { rows: [m] } = await ctx.pool.query(`SELECT id FROM accounts WHERE type='merchant'`);
    const { rows: [k] } = await ctx.pool.query(`SELECT id FROM accounts WHERE type='clearing'`);
    await tamper(ctx.pool, `WITH t AS (INSERT INTO ledger_transactions (payment_id, kind) VALUES ($1,'payment') RETURNING id)
                            INSERT INTO ledger_entries (ledger_tx_id, account_id, direction, amount) SELECT id,$2::uuid,'credit',100 FROM t UNION ALL SELECT id,$3::uuid,'debit',100 FROM t`, [f.id, m.id, k.id]);
    expect(await checks()).toEqual(expect.arrayContaining(['payment_ledger_mismatch', 'ledger_amount_mismatch', 'account_balance_mismatch']));
  });

  it('detects a payment whose ledger amount differs from the payment amount', async () => {
    await tamper(ctx.pool, `UPDATE payments SET amount = amount + 100 WHERE id=$1`, [paymentId]);
    expect(await checks()).toContain('ledger_amount_mismatch');
  });

  it('detects a missing outbox event', async () => {
    await ctx.pool.query(`DELETE FROM outbox_events WHERE payment_id=$1`, [paymentId]);
    expect(await checks()).toContain('missing_outbox_event');
  });

  it('detects a payment stuck in processing', async () => {
    await tamper(ctx.pool, `INSERT INTO payments (merchant_id, amount, currency, status, payment_method, fingerprint, created_at) VALUES ('m1', 5, 'USD', 'processing', 'tok_success', 'x', now() - interval '1 hour')`);
    expect(await checks()).toContain('stuck_payment');
  });

  it('reports dead webhooks as warnings without failing the run', async () => {
    await ctx.pool.query(`UPDATE outbox_events SET status='dead', attempts=8 WHERE payment_id=$1`, [paymentId]);
    const r = await reconcile(ctx.pool);
    expect(r.ok).toBe(true);
    expect(r.discrepancies.map((d) => d.check)).toEqual(['dead_webhook_event']);
  });
});
