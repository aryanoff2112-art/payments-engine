import { randomUUID } from 'crypto';
import { Ctx, createPayment } from '../src/payments/service';
import { RedisCache } from '../src/cache';
import { count, makeRedisCache, pay, resetDb, setup } from './helpers';

describe('idempotency', () => {
  let ctx: Ctx;
  beforeAll(async () => { ctx = await setup(); });
  beforeEach(() => resetDb(ctx.pool));
  afterAll(() => ctx.pool.end());

  it('same key sent twice creates exactly one payment and one ledger tx, and replays the response', async () => {
    const body = pay();
    const a = await createPayment(ctx, 'm1', 'key-1', body);
    const b = await createPayment(ctx, 'm1', 'key-1', body);
    expect(a.status).toBe(201);
    expect(b.replayed).toBe(true);
    expect(b.body).toEqual(a.body);
    expect(await count(ctx.pool, 'payments')).toBe(1);
    expect(await count(ctx.pool, 'ledger_transactions')).toBe(1);
  });

  it('20 identical requests in parallel create exactly one payment and one ledger tx', async () => {
    const body = pay();
    const results = await Promise.all(Array.from({ length: 20 }, () => createPayment(ctx, 'm1', 'key-par', body)));
    expect(new Set(results.map((r) => r.body.id)).size).toBe(1);
    expect(results.filter((r) => !r.replayed)).toHaveLength(1);
    expect(await count(ctx.pool, 'payments')).toBe(1);
    expect(await count(ctx.pool, 'ledger_transactions')).toBe(1);
    expect(await count(ctx.pool, 'outbox_events')).toBe(1);
  });

  it('rejects reuse of a key with a different body (422) and creates nothing new', async () => {
    await createPayment(ctx, 'm1', 'key-2', pay({ amount: 1000, customerId: 'c' }));
    await expect(createPayment(ctx, 'm1', 'key-2', pay({ amount: 2000, customerId: 'c' }))).rejects.toMatchObject({ status: 422 });
    expect(await count(ctx.pool, 'payments')).toBe(1);
  });

  it('is body-key-order independent', async () => {
    const a = await createPayment(ctx, 'm1', 'key-3', { amount: 5, currency: 'USD', paymentMethod: 'tok_success', customerId: 'x' });
    const b = await createPayment(ctx, 'm1', 'key-3', { customerId: 'x', paymentMethod: 'tok_success', currency: 'USD', amount: 5 });
    expect(b.replayed).toBe(true);
    expect(b.body.id).toBe(a.body.id);
  });

  it('scopes keys per merchant', async () => {
    const body = pay();
    const a = await createPayment(ctx, 'm1', 'shared', body);
    const b = await createPayment(ctx, 'm2', 'shared', body);
    expect(a.body.id).not.toBe(b.body.id);
    expect(await count(ctx.pool, 'payments')).toBe(2);
  });

  it('replays declined payments too (a decline is a result, not an error)', async () => {
    const body = pay({ paymentMethod: 'tok_decline' });
    const a = await createPayment(ctx, 'm1', 'dk', body);
    const b = await createPayment(ctx, 'm1', 'dk', body);
    expect(a.status).toBe(402);
    expect(b.body).toEqual(a.body);
    expect(await count(ctx.pool, 'payments')).toBe(1);
  });

  describe('Redis fast path', () => {
    it('serves replays from Redis and stays correct', async () => {
      const cache = makeRedisCache();
      await new Promise((r) => setTimeout(r, 200));
      const c = { ...ctx, cache };
      const key = randomUUID();
      const body = pay();
      const a = await createPayment(c, 'mr', key, body);
      const b = await createPayment(c, 'mr', key, body);
      expect(b.replayed).toBe(true);
      expect(b.body).toEqual(a.body);
      await expect(createPayment(c, 'mr', key, pay({ amount: 7 }))).rejects.toMatchObject({ status: 422 });
      await cache.close();
    });

    it('is unaffected when Redis is down: Postgres still prevents duplicates', async () => {
      const dead = new RedisCache('redis://127.0.0.1:1');
      const c = { ...ctx, cache: dead };
      const body = pay();
      const results = await Promise.all(Array.from({ length: 10 }, () => createPayment(c, 'm1', 'no-redis', body)));
      expect(new Set(results.map((r) => r.body.id)).size).toBe(1);
      expect(await count(ctx.pool, 'payments')).toBe(1);
      await dead.close();
    });
  });
});
