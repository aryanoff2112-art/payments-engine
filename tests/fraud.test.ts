import { Ctx, createPayment } from '../src/payments/service';
import { count, pay, resetDb, setup } from './helpers';

describe('fraud signals', () => {
  let ctx: Ctx;
  beforeAll(async () => { ctx = await setup({ fraud: { fingerprintVelocityLimit: 3, merchantVelocityLimit: 8 } as any }); });
  beforeEach(() => resetDb(ctx.pool));
  afterAll(() => ctx.pool.end());
  const same = { customerId: 'cust-1' };

  it('flags for review (still processes) when one fingerprint exceeds the velocity limit', async () => {
    for (let i = 0; i < 3; i++) await createPayment(ctx, 'm1', `k${i}`, pay(same));
    const r = await createPayment(ctx, 'm1', 'k3', pay(same));
    expect(r.status).toBe(201);
    expect(r.body.flagged_for_review).toBe(true);
    expect(r.body.fraud_score).toBe(40);
  });

  it('blocks payments whose combined score reaches the block threshold, with no ledger writes', async () => {
    for (let i = 0; i < 3; i++) await createPayment(ctx, 'm1', `k${i}`, pay(same));
    const before = await count(ctx.pool, 'ledger_transactions');
    const r = await createPayment(ctx, 'm1', 'huge', pay({ ...same, amount: 5_000_000 })); // velocity 40 + large 50
    expect(r.status).toBe(402);
    expect(r.body.failure_reason).toBe('fraud_suspected');
    expect(await count(ctx.pool, 'ledger_transactions')).toBe(before);
  });

  it('flags a large amount alone for review', async () => {
    const r = await createPayment(ctx, 'm1', 'k', pay({ amount: 1_500_000 }));
    expect(r.status).toBe(201);
    expect(r.body.flagged_for_review).toBe(true);
  });

  it('detects card testing: repeated declines on one fingerprint', async () => {
    for (let i = 0; i < 3; i++) await createPayment(ctx, 'm1', `d${i}`, pay({ ...same, paymentMethod: 'tok_decline' }));
    const r = await createPayment(ctx, 'm1', 'then-success', pay({ ...same, paymentMethod: 'tok_decline' }));
    expect(r.body.fraud_score).toBeGreaterThanOrEqual(50);
    const s = await createPayment(ctx, 'm1', 'real', pay({ ...same, paymentMethod: 'tok_decline' }));
    expect(s.body.failure_reason).toBe('fraud_suspected'); // card_testing (50) + fingerprint velocity (40)
  });

  it('detects an amount far above the merchant rolling average', async () => {
    for (let i = 0; i < 5; i++) await createPayment(ctx, 'm2', `k${i}`, pay({ amount: 1000 }));
    const r = await createPayment(ctx, 'm2', 'spike', pay({ amount: 50_000 }));
    expect(r.body.fraud_score).toBe(30);
  });

  it('does not penalise normal traffic', async () => {
    const r = await createPayment(ctx, 'm3', 'k', pay());
    expect(r.body).toMatchObject({ fraud_score: 0, flagged_for_review: false });
  });
});
