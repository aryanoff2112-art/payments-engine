import { Ctx, createPayment, refundPayment } from '../src/payments/service';
import { canTransition } from '../src/payments/stateMachine';
import { pay, resetDb, setup } from './helpers';

describe('transaction state machine', () => {
  let ctx: Ctx;
  beforeAll(async () => { ctx = await setup(); });
  beforeEach(() => resetDb(ctx.pool));
  afterAll(() => ctx.pool.end());

  it('allows only the documented transitions', () => {
    expect(canTransition('pending', 'processing')).toBe(true);
    expect(canTransition('processing', 'succeeded')).toBe(true);
    expect(canTransition('processing', 'failed')).toBe(true);
    expect(canTransition('succeeded', 'refunded')).toBe(true);
    for (const [a, b] of [['pending', 'succeeded'], ['failed', 'succeeded'], ['refunded', 'succeeded'], ['succeeded', 'failed'], ['failed', 'refunded']] as const)
      expect(canTransition(a, b)).toBe(false);
  });

  it('the database trigger rejects illegal transitions even from raw SQL', async () => {
    const r = await createPayment(ctx, 'm1', 'k', pay({ paymentMethod: 'tok_decline' }));
    await expect(ctx.pool.query(`UPDATE payments SET status='succeeded' WHERE id=$1`, [r.body.id])).rejects.toThrow(/illegal payment transition/);
    const s = await createPayment(ctx, 'm1', 'k2', pay());
    await expect(ctx.pool.query(`UPDATE payments SET status='pending' WHERE id=$1`, [s.body.id])).rejects.toThrow(/illegal payment transition/);
  });

  it('cannot refund a failed payment, or refund twice', async () => {
    const f = await createPayment(ctx, 'm1', 'f', pay({ paymentMethod: 'tok_decline' }));
    await expect(refundPayment(ctx, 'm1', 'r1', f.body.id)).rejects.toMatchObject({ status: 409 });
    const s = await createPayment(ctx, 'm1', 's', pay());
    await refundPayment(ctx, 'm1', 'r2', s.body.id);
    await expect(refundPayment(ctx, 'm1', 'r3', s.body.id)).rejects.toMatchObject({ status: 409 });
  });

  it("cannot refund another merchant's payment", async () => {
    const s = await createPayment(ctx, 'm1', 's', pay());
    await expect(refundPayment(ctx, 'm2', 'r', s.body.id)).rejects.toMatchObject({ status: 404 });
  });
});
