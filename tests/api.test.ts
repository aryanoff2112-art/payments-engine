import request from 'supertest';
import { createApp } from '../src/app';
import { Ctx } from '../src/payments/service';
import { sha256 } from '../src/util';
import { apiKeyFor, count, resetDb, setup, TEST_ADMIN_KEY } from './helpers';

describe('HTTP API', () => {
  let ctx: Ctx;
  let app: ReturnType<typeof createApp>;
  let k1: string;   // merchant m1's API key
  let k2: string;   // merchant m2's API key
  // Guard ON for this suite: webhook registration must reject private targets.
  beforeAll(async () => { ctx = await setup({ webhook: { allowPrivateTargets: false } }); app = createApp(ctx); });
  beforeEach(async () => { await resetDb(ctx.pool); k1 = await apiKeyFor(ctx, 'm1'); k2 = await apiKeyFor(ctx, 'm2'); });
  afterAll(() => ctx.pool.end());

  const auth = (key: string) => ({ Authorization: `Bearer ${key}` });
  const post = (key: string | null, body: any, bearer = k1) => {
    let r = request(app).post('/v1/payments').set(auth(bearer));
    if (key) r = r.set('Idempotency-Key', key);
    return r.send(body);
  };
  const valid = { amount: 2500, currency: 'USD', paymentMethod: 'tok_success' };

  it('creates, fetches and replays a payment', async () => {
    const a = await post('k1', valid).expect(201);
    expect(a.body).toMatchObject({ status: 'succeeded', amount: 2500, fee: 72 });
    const b = await post('k1', valid).expect(201);
    expect(b.headers['idempotent-replayed']).toBe('true');
    expect(b.body.id).toBe(a.body.id);
    await request(app).get(`/v1/payments/${a.body.id}`).set(auth(k1)).expect(200);
    const bal = await request(app).get('/v1/balance').set(auth(k1)).expect(200);
    expect(bal.body.balances).toEqual([{ currency: 'USD', balance: 2428 }]);
  });

  it('returns 402 for declines and 502 for processor outages', async () => {
    await post('d', { ...valid, paymentMethod: 'tok_decline' }).expect(402);
    await post('e', { ...valid, paymentMethod: 'tok_error' }).expect(502);
  });

  it('validates input and rejects anything that looks like real card data', async () => {
    await post(null, valid).expect(400);
    await post('v', { ...valid, amount: -5 }).expect(400);
    await post('v', { ...valid, amount: 1.5 }).expect(400);
    await post('v', { ...valid, currency: 'XXX' }).expect(400);
    await post('v', { ...valid, paymentMethod: '4242424242424242' }).expect(400);
    await post('v', { ...valid, cardNumber: '4242424242424242' }).expect(400);
    await request(app).post('/v1/payments').set(auth(k1)).set('Idempotency-Key', 'x').set('Content-Type', 'application/json').send('{bad').expect(400);
    expect(await count(ctx.pool, 'payments')).toBe(0);
  });

  it('returns 422 when a key is reused with a different body', async () => {
    await post('k', valid).expect(201);
    await post('k', { ...valid, amount: 1 }).expect(422);
  });

  it('refunds via the API', async () => {
    const p = await post('k', valid).expect(201);
    const r = await request(app).post(`/v1/payments/${p.body.id}/refund`).set(auth(k1)).set('Idempotency-Key', 'rf').expect(200);
    expect(r.body.status).toBe('refunded');
  });

  it('health check works without credentials', async () => { await request(app).get('/health').expect(200); });

  // ---------------- authentication ----------------
  describe('merchant authentication', () => {
    it('rejects missing, malformed, unknown and wrong-secret keys with the same 401', async () => {
      const [id, secret] = [k1.split('_')[1], k1.split('_')[2]];
      const bad = [
        undefined,
        'Bearer',
        'Bearer nonsense',
        `Bearer sk_${id}_${'A'.repeat(43)}`,                                   // right id, wrong secret
        `Bearer sk_00000000-0000-4000-8000-000000000000_${secret}`,            // unknown id
        `Basic ${Buffer.from('m1:x').toString('base64')}`,
      ];
      for (const h of bad) {
        const r = request(app).get('/v1/balance');
        const res = await (h ? r.set('Authorization', h) : r).expect(401);
        expect(res.body.error.code).toBe('invalid_api_key');
      }
    });

    it('the legacy X-Merchant-Id header grants nothing, and cannot be used to impersonate another merchant', async () => {
      await request(app).get('/v1/balance').set('X-Merchant-Id', 'm1').expect(401);
      const p = await post('k', valid, k1).expect(201);
      // m2 authenticates as m2 but claims to be m1 via header: still sees only m2's world.
      await request(app).get(`/v1/payments/${p.body.id}`).set(auth(k2)).set('X-Merchant-Id', 'm1').expect(404);
      const b = await request(app).get('/v1/balance').set(auth(k2)).set('X-Merchant-Id', 'm1').expect(200);
      expect(b.body.balances).toEqual([]);
    });

    it('stores only a hash of the key, never the secret', async () => {
      const secret = k1.split('_')[2];
      const { rows } = await ctx.pool.query(`SELECT key_hash, id FROM api_keys WHERE merchant_id='m1'`);
      expect(rows).toHaveLength(1);
      expect(rows[0].key_hash).toBe(sha256(secret));
      expect(JSON.stringify((await ctx.pool.query(`SELECT * FROM api_keys`)).rows)).not.toContain(secret);
    });

    it('revoked and expired keys stop working', async () => {
      const id = k1.split('_')[1];
      await request(app).get('/v1/balance').set(auth(k1)).expect(200);
      await ctx.pool.query(`UPDATE api_keys SET expires_at = now() - interval '1 second' WHERE id=$1`, [id]);
      await request(app).get('/v1/balance').set(auth(k1)).expect(401);
      await ctx.pool.query(`UPDATE api_keys SET expires_at = NULL, revoked_at = now() WHERE id=$1`, [id]);
      await request(app).get('/v1/balance').set(auth(k1)).expect(401);
    });
  });

  // ---------------- authorization (tenant isolation) ----------------
  describe('merchant authorization', () => {
    it("a merchant cannot read, refund or see another merchant's data", async () => {
      const p = await post('k', valid, k1).expect(201);
      await request(app).get(`/v1/payments/${p.body.id}`).set(auth(k2)).expect(404);
      await request(app).post(`/v1/payments/${p.body.id}/refund`).set(auth(k2)).set('Idempotency-Key', 'steal').expect(404);
      await request(app).get('/v1/payments/' + p.body.id).set(auth(k1)).expect(200);     // still intact and refundable by the owner
      expect((await request(app).get('/v1/balance').set(auth(k2)).expect(200)).body.balances).toEqual([]);
    });

    it('the same Idempotency-Key used by two merchants stays isolated', async () => {
      const a = await post('same', valid, k1).expect(201);
      const b = await post('same', valid, k2).expect(201);
      expect(a.body.id).not.toBe(b.body.id);
      expect(b.headers['idempotent-replayed']).toBeUndefined();
    });

    it("a merchant's webhook endpoint registration only affects that merchant", async () => {
      await request(app).put('/v1/webhook_endpoint').set(auth(k1)).send({ url: 'https://93.184.216.34/hook' }).expect(200);
      expect(await count(ctx.pool, 'webhook_endpoints', `merchant_id='m1'`)).toBe(1);
      expect(await count(ctx.pool, 'webhook_endpoints', `merchant_id='m2'`)).toBe(0);
    });

    it("one merchant cannot revoke another's key, and cannot list it", async () => {
      const k1id = k1.split('_')[1];
      await request(app).delete(`/v1/api_keys/${k1id}`).set(auth(k2)).expect(404);
      await request(app).get('/v1/balance').set(auth(k1)).expect(200);
      const list = await request(app).get('/v1/api_keys').set(auth(k2)).expect(200);
      expect(list.body.keys.map((k: any) => k.id)).not.toContain(k1id);
      expect(JSON.stringify(list.body)).not.toMatch(/key_hash|sk_/);
    });
  });

  // ---------------- key rotation ----------------
  describe('API key rotation', () => {
    it('old key keeps working during the grace window; new key works immediately', async () => {
      const r = await request(app).post('/v1/api_keys/rotate').set(auth(k1)).send({ grace_seconds: 3600 }).expect(201);
      expect(r.body.key).toMatch(/^sk_/);
      await request(app).get('/v1/balance').set(auth(r.body.key)).expect(200);
      await request(app).get('/v1/balance').set(auth(k1)).expect(200);
      // Grace window elapses.
      await ctx.pool.query(`UPDATE api_keys SET expires_at = now() - interval '1 second' WHERE id=$1`, [k1.split('_')[1]]);
      await request(app).get('/v1/balance').set(auth(k1)).expect(401);
      await request(app).get('/v1/balance').set(auth(r.body.key)).expect(200);
    });

    it('grace_seconds: 0 revokes the old key at once (compromised-key path)', async () => {
      const r = await request(app).post('/v1/api_keys/rotate').set(auth(k1)).send({ grace_seconds: 0 }).expect(201);
      await request(app).get('/v1/balance').set(auth(k1)).expect(401);
      await request(app).get('/v1/balance').set(auth(r.body.key)).expect(200);
    });

    it("rotation never touches another merchant's keys", async () => {
      await request(app).post('/v1/api_keys/rotate').set(auth(k1)).send({ grace_seconds: 0 }).expect(201);
      await request(app).get('/v1/balance').set(auth(k2)).expect(200);
    });

    it('simultaneous rotations never leave the merchant without a valid key', async () => {
      const rs = await Promise.all(Array.from({ length: 8 }, () => request(app).post('/v1/api_keys/rotate').set(auth(k1)).send({ grace_seconds: 0 })));
      const ok = rs.filter((r) => r.status === 201).map((r) => r.body.key as string);
      expect(ok.length).toBeGreaterThan(0);
      const { rows } = await ctx.pool.query(`SELECT id FROM api_keys WHERE merchant_id='m1' AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > now())`);
      expect(rows).toHaveLength(1);                                    // exactly one survivor
      const alive: number[] = [];
      for (const k of ok) alive.push((await request(app).get('/v1/balance').set(auth(k))).status);
      expect(alive.filter((s) => s === 200)).toHaveLength(1);          // and it is one of the keys we were handed
    });

    it('a merchant can revoke a key explicitly', async () => {
      const r = await request(app).post('/v1/api_keys/rotate').set(auth(k1)).send({ grace_seconds: 3600 }).expect(201);
      await request(app).delete(`/v1/api_keys/${k1.split('_')[1]}`).set(auth(r.body.key)).expect(204);
      await request(app).get('/v1/balance').set(auth(k1)).expect(401);
    });
  });

  // ---------------- admin ----------------
  describe('admin endpoints', () => {
    it('reconciliation requires the admin credential; merchant keys do not grant admin', async () => {
      await request(app).get('/v1/admin/reconciliation').expect(401);
      await request(app).get('/v1/admin/reconciliation').set(auth(k1)).expect(401);
      await request(app).get('/v1/admin/reconciliation').set(auth('wrong-admin-key')).expect(401);
      await request(app).get('/v1/admin/reconciliation').set('X-Merchant-Id', 'm1').expect(401);
      await request(app).get('/v1/admin/reconciliation').set(auth(TEST_ADMIN_KEY)).expect(200);
    });

    it('admin endpoints are disabled outright when no admin key is configured', async () => {
      const off = createApp({ ...ctx, cfg: { ...ctx.cfg, adminApiKey: undefined } });
      await request(off).get('/v1/admin/reconciliation').set(auth('')).expect(401);
      await request(off).get('/v1/admin/reconciliation').set(auth('undefined')).expect(401);
    });

    it('admin can issue the first key for a merchant; merchants cannot call the admin issuer', async () => {
      const r = await request(app).post('/v1/admin/merchants/newco/api_keys').set(auth(TEST_ADMIN_KEY)).expect(201);
      await request(app).get('/v1/balance').set(auth(r.body.key)).expect(200);
      await request(app).post('/v1/admin/merchants/newco/api_keys').set(auth(k1)).expect(401);
      await request(app).post('/v1/admin/merchants/bad%20id/api_keys').set(auth(TEST_ADMIN_KEY)).expect(400);
    });
  });

  // ---------------- webhook registration (SSRF) ----------------
  describe('webhook registration rejects SSRF targets', () => {
    const reg = (url: unknown) => request(app).put('/v1/webhook_endpoint').set(auth(k1)).send({ url });
    it.each([
      'http://example.com/hook', 'https://localhost/hook', 'https://127.0.0.1/hook', 'https://[::1]/hook',
      'https://169.254.169.254/latest/meta-data/', 'https://metadata.google.internal/', 'https://10.0.0.1/hook',
      'https://192.168.1.10/hook', 'https://2130706433/hook', 'https://[::ffff:127.0.0.1]/hook',
      'file:///etc/passwd', 'ftp://x', 'https://user:pw@example.com/', 'https://example.com:22/',
    ])('rejects %s', async (url) => {
      const r = await reg(url).expect(400);
      expect(r.body.error.code).toBe('unsafe_webhook_url');
    });
    it('rejects non-string and unknown fields', async () => {
      await reg(123).expect(400);
      await request(app).put('/v1/webhook_endpoint').set(auth(k1)).send({ url: 'https://93.184.216.34/h', extra: 1 }).expect(400);
    });
    it('nothing is stored for a rejected URL', async () => {
      await reg('https://127.0.0.1/hook').expect(400);
      expect(await count(ctx.pool, 'webhook_endpoints')).toBe(0);
    });
    it('accepts a public https URL and returns the signing secret', async () => {
      const r = await reg('https://93.184.216.34/hook').expect(200);
      expect(r.body.secret).toMatch(/^whsec_/);
    });
  });
});
