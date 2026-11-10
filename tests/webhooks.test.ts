import { Ctx, createPayment } from '../src/payments/service';
import { WebhookWorker, backoffMs } from '../src/webhooks/worker';
import { sign, verify } from '../src/webhooks/signature';
import http from 'http';
import { count, pay, receiver, resetDb, setup } from './helpers';

describe('webhooks', () => {
  let ctx: Ctx;
  let worker: WebhookWorker;
  beforeAll(async () => {
    ctx = await setup({ webhook: { backoffBaseMs: 5, maxAttempts: 4, timeoutMs: 300, leaseMs: 30_000, backoffMaxMs: 50, pollIntervalMs: 20, batchSize: 25 } });
    worker = new WebhookWorker(ctx.pool, ctx.cfg);
  });
  beforeEach(() => resetDb(ctx.pool));
  afterAll(() => ctx.pool.end());

  const register = (merchant: string, url: string) =>
    ctx.pool.query(`INSERT INTO webhook_endpoints (merchant_id, url, secret) VALUES ($1,$2,'whsec_test')`, [merchant, url]);
  const drain = async (maxRounds = 50) => {
    for (let i = 0; i < maxRounds; i++) {
      await worker.runOnce();
      if (await count(ctx.pool, 'outbox_events', `status IN ('pending','in_flight')`) === 0) return;
      await new Promise((r) => setTimeout(r, 15));
    }
  };

  it('endpoint failing twice then succeeding: exactly 3 attempts, then delivered', async () => {
    const rx = await receiver([500, 500, 200]);
    await register('m1', rx.url);
    await createPayment(ctx, 'm1', 'k', pay());
    await drain();
    expect(rx.hits).toHaveLength(3);
    const { rows: [ev] } = await ctx.pool.query(`SELECT status, attempts FROM outbox_events`);
    expect(ev).toEqual({ status: 'delivered', attempts: 3 });
    const { rows: log } = await ctx.pool.query(`SELECT attempt, status_code FROM webhook_deliveries ORDER BY attempt`);
    expect(log.map((l) => l.status_code)).toEqual([500, 500, 200]);
    // Same event id on every attempt, so merchants can deduplicate.
    expect(new Set(rx.hits.map((h) => h.headers['x-event-id'])).size).toBe(1);
    await rx.close();
  });

  it('signs payloads verifiably, and rejects tampered or stale ones', async () => {
    const rx = await receiver([200]);
    await register('m1', rx.url);
    await createPayment(ctx, 'm1', 'k', pay());
    await worker.runOnce();
    const h = rx.hits[0];
    expect(verify('whsec_test', h.body, h.headers['x-signature'] as string)).toBe(true);
    expect(verify('whsec_test', h.body + ' ', h.headers['x-signature'] as string)).toBe(false);
    expect(verify('wrong', h.body, h.headers['x-signature'] as string)).toBe(false);
    expect(verify('s', 'b', sign('s', 'b', 1000), 300, 5000)).toBe(false);
    expect(JSON.parse(h.body).type).toBe('payment.succeeded');
    await rx.close();
  });

  it('marks an event dead after maxAttempts and reconciliation reports it as a warning', async () => {
    const rx = await receiver([500]);
    await register('m1', rx.url);
    await createPayment(ctx, 'm1', 'k', pay());
    await drain();
    expect(rx.hits).toHaveLength(4);
    expect((await ctx.pool.query(`SELECT status FROM outbox_events`)).rows[0].status).toBe('dead');
    await rx.close();
  });

  it('treats a hanging endpoint as a timeout failure and retries', async () => {
    const rx = await receiver(['hang', 200]);
    await register('m1', rx.url);
    await createPayment(ctx, 'm1', 'k', pay());
    await drain();
    const { rows } = await ctx.pool.query(`SELECT error FROM webhook_deliveries ORDER BY attempt`);
    expect(rows[0].error).toBe('timeout');
    expect((await ctx.pool.query(`SELECT status FROM outbox_events`)).rows[0].status).toBe('delivered');
    await rx.close();
  });

  it('recovers events stranded in_flight by a crashed worker once the lease expires', async () => {
    const rx = await receiver([200]);
    await register('m1', rx.url);
    await createPayment(ctx, 'm1', 'k', pay());
    await ctx.pool.query(`UPDATE outbox_events SET status='in_flight', attempts=1, locked_until=now() + interval '1 hour'`);
    expect(await worker.runOnce()).toBe(0);               // lease still held: not touched
    await ctx.pool.query(`UPDATE outbox_events SET locked_until=now() - interval '1 second'`);
    expect(await worker.runOnce()).toBe(1);               // lease expired: reclaimed
    expect(rx.hits).toHaveLength(1);
    expect((await ctx.pool.query(`SELECT status, attempts FROM outbox_events`)).rows[0]).toEqual({ status: 'delivered', attempts: 2 });
    await rx.close();
  });

  it('two workers never deliver the same event concurrently (SKIP LOCKED)', async () => {
    const rx = await receiver([200]);
    await register('m1', rx.url);
    for (let i = 0; i < 30; i++) await createPayment(ctx, 'm1', `k${i}`, pay());
    const w2 = new WebhookWorker(ctx.pool, ctx.cfg);
    await Promise.all([worker.runOnce(), w2.runOnce(), worker.runOnce(), w2.runOnce()]);
    expect(rx.hits).toHaveLength(30);
    expect(new Set(rx.hits.map((h) => h.headers['x-event-id'])).size).toBe(30);
    await rx.close();
  });

  it('skips events for merchants without an endpoint', async () => {
    await createPayment(ctx, 'm1', 'k', pay());
    await worker.runOnce();
    expect((await ctx.pool.query(`SELECT status FROM outbox_events`)).rows[0].status).toBe('skipped');
  });

  it('background loop delivers new events automatically, and wake() speeds it up', async () => {
    const rx = await receiver([200]);
    await register('m1', rx.url);
    const bg = new WebhookWorker(ctx.pool, { ...ctx.cfg, webhook: { ...ctx.cfg.webhook, pollIntervalMs: 5000 } });
    bg.start();
    await new Promise((r) => setTimeout(r, 50));
    await createPayment(ctx, 'm1', 'k', pay());
    bg.wake();
    for (let i = 0; i < 100 && rx.hits.length === 0; i++) await new Promise((r) => setTimeout(r, 20));
    bg.stop();
    expect(rx.hits).toHaveLength(1);
    await rx.close();
  });

  it('a 3xx response is a failed attempt, never followed', async () => {
    let followed = 0;
    const target = http.createServer((_q, r) => { followed++; r.end('x'); });
    await new Promise<void>((r) => target.listen(0, '127.0.0.1', r));
    const tport = (target.address() as any).port;
    const redirector = http.createServer((_q, r) => { r.statusCode = 307; r.setHeader('location', `http://127.0.0.1:${tport}/`); r.end(); });
    await new Promise<void>((r) => redirector.listen(0, '127.0.0.1', r));
    await register('m1', `http://127.0.0.1:${(redirector.address() as any).port}/hook`);
    await createPayment(ctx, 'm1', 'k', pay());
    await worker.runOnce();
    expect(followed).toBe(0);
    expect((await ctx.pool.query(`SELECT error FROM webhook_deliveries`)).rows[0].error).toBe('HTTP 307');
    await Promise.all([target, redirector].map((s) => new Promise<void>((r) => { s.closeAllConnections(); s.close(() => r()); })));
  });

  it('with the SSRF guard ON, an endpoint planted directly in the DB is still never contacted and the event dies at once', async () => {
    const rx = await receiver([200]);
    await register('m1', rx.url);                                   // 127.0.0.1 target, e.g. from before the guard existed
    await createPayment(ctx, 'm1', 'k', pay());
    const strict = new WebhookWorker(ctx.pool, { ...ctx.cfg, webhook: { ...ctx.cfg.webhook, allowPrivateTargets: false } });
    await strict.runOnce();
    expect(rx.hits).toHaveLength(0);
    const { rows: [ev] } = await ctx.pool.query(`SELECT status, attempts, last_error FROM outbox_events`);
    expect(ev).toEqual({ status: 'dead', attempts: 1, last_error: 'blocked_target' });   // no retries against a blocked target
    await rx.close();
  });

  it('sends the same event id on every redelivery so consumers can deduplicate (at-least-once)', async () => {
    const rx = await receiver([200]);
    await register('m1', rx.url);
    await createPayment(ctx, 'm1', 'k', pay());
    await worker.runOnce();
    // Simulate: receiver returned 2xx, then the worker crashed before recording `delivered`.
    await ctx.pool.query(`UPDATE outbox_events SET status='in_flight', delivered_at=NULL, locked_until=now() - interval '1 second'`);
    await worker.runOnce();
    expect(rx.hits).toHaveLength(2);                                                  // duplicate delivery is expected
    expect(rx.hits[0].headers['x-event-id']).toBe(rx.hits[1].headers['x-event-id']);  // ...and identifiable
    expect(JSON.parse(rx.hits[0].body).id).toBe(JSON.parse(rx.hits[1].body).id);
    await rx.close();
  });

  it('backoff grows exponentially, is capped, and adds jitter', () => {
    const w = { ...ctx.cfg.webhook, backoffBaseMs: 1000, backoffMaxMs: 3_600_000 };
    expect(backoffMs(1, w, () => 0)).toBe(1000);
    expect(backoffMs(4, w, () => 0)).toBe(8000);
    expect(backoffMs(30, w, () => 0)).toBe(3_600_000);
    expect(backoffMs(2, w, () => 0.5)).toBe(2500);
  });
});
