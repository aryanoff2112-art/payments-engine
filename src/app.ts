import express, { NextFunction, Request, Response } from 'express';
import { ZodError, z } from 'zod';
import { randomBytes } from 'crypto';
import { HttpError } from './errors';
import { Ctx, createPayment, getBalance, getPayment, paymentSchema, refundPayment } from './payments/service';
import { reconcile } from './reconciliation/reconcile';
import { authenticateMerchant, issueApiKey, listApiKeys, requireAdmin, revokeApiKey, rotateApiKeys } from './auth/apiKeys';
import { UnsafeUrlError, assertSafeWebhookTarget } from './security/webhookUrl';

const wrap = (fn: (req: Request, res: Response) => Promise<void>) =>
  (req: Request, res: Response, next: NextFunction) => fn(req, res).catch(next);

function keyOf(req: Request): string {
  const k = req.header('idempotency-key');
  if (!k || k.length > 255) throw new HttpError(400, 'idempotency_key_required', 'Idempotency-Key header required (max 255 chars)');
  return k;
}

export function createApp(ctx: Ctx) {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '10kb' }));

  // The merchant is derived ONLY from the API key. No header or body field can name a merchant.
  const merchantOf = async (req: Request) => (await authenticateMerchant(ctx.pool, req)).merchantId;
  const admin = requireAdmin(ctx.cfg.adminApiKey);

  app.get('/health', wrap(async (_req, res) => { await ctx.pool.query('SELECT 1'); res.json({ ok: true }); }));

  app.post('/v1/payments', wrap(async (req, res) => {
    const merchant = await merchantOf(req); const key = keyOf(req);
    const body = paymentSchema.parse(req.body);
    const r = await createPayment(ctx, merchant, key, body);
    if (r.replayed) res.set('Idempotent-Replayed', 'true');
    res.status(r.status).json(r.body);
  }));

  app.get('/v1/payments/:id', wrap(async (req, res) => {
    const merchant = await merchantOf(req);
    const id = z.string().uuid().parse(req.params.id);
    res.json(await getPayment(ctx.pool, merchant, id));
  }));

  app.post('/v1/payments/:id/refund', wrap(async (req, res) => {
    const merchant = await merchantOf(req);          // authenticate before validating anything else
    const id = z.string().uuid().parse(req.params.id);
    const r = await refundPayment(ctx, merchant, keyOf(req), id);
    if (r.replayed) res.set('Idempotent-Replayed', 'true');
    res.status(r.status).json(r.body);
  }));

  app.get('/v1/balance', wrap(async (req, res) => { res.json({ balances: await getBalance(ctx.pool, await merchantOf(req)) }); }));

  app.put('/v1/webhook_endpoint', wrap(async (req, res) => {
    const merchant = await merchantOf(req);
    const { url } = z.object({ url: z.string().max(2048) }).strict().parse(req.body);
    try { await assertSafeWebhookTarget(url, { allowPrivateTargets: ctx.cfg.webhook.allowPrivateTargets }); }
    catch (e) { if (e instanceof UnsafeUrlError) throw new HttpError(400, 'unsafe_webhook_url', e.reason); throw e; }
    const secret = 'whsec_' + randomBytes(24).toString('hex');
    await ctx.pool.query(
      `INSERT INTO webhook_endpoints (merchant_id, url, secret) VALUES ($1,$2,$3)
       ON CONFLICT (merchant_id) DO UPDATE SET url = EXCLUDED.url, secret = EXCLUDED.secret`, [merchant, url, secret]);
    res.json({ url, secret });
  }));

  // ---- merchant self-service key management (authenticated with a current key) ----
  app.get('/v1/api_keys', wrap(async (req, res) => { res.json({ keys: await listApiKeys(ctx.pool, await merchantOf(req)) }); }));
  app.post('/v1/api_keys/rotate', wrap(async (req, res) => {
    const merchant = await merchantOf(req);
    const { grace_seconds } = z.object({ grace_seconds: z.number().int().min(0).max(30 * 86400).optional() }).strict().parse(req.body ?? {});
    res.status(201).json(await rotateApiKeys(ctx.pool, merchant, grace_seconds ?? ctx.cfg.apiKeyRotationGraceSec));
  }));
  app.delete('/v1/api_keys/:id', wrap(async (req, res) => {
    const merchant = await merchantOf(req);
    const id = z.string().uuid().parse(req.params.id);
    if (!(await revokeApiKey(ctx.pool, merchant, id))) throw new HttpError(404, 'key_not_found');
    res.status(204).end();
  }));

  // ---- operator-only ----
  app.post('/v1/admin/merchants/:merchantId/api_keys', admin, wrap(async (req, res) => {
    const merchantId = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/).parse(req.params.merchantId);
    res.status(201).json(await issueApiKey(ctx.pool, merchantId, 'issued by admin'));
  }));

  app.get('/v1/admin/reconciliation', admin, wrap(async (_req, res) => {
    const report = await reconcile(ctx.pool, { stuckAfterSec: ctx.cfg.stuckPaymentSec });
    res.status(report.ok ? 200 : 500).json(report);
  }));

  app.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof HttpError) return void res.status(err.status).json({ error: { code: err.code, message: err.message } });
    if (err instanceof ZodError) return void res.status(400).json({ error: { code: 'invalid_request', message: err.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') } });
    if (err?.type === 'entity.parse.failed') return void res.status(400).json({ error: { code: 'invalid_json', message: 'malformed JSON' } });
    console.error(err);
    res.status(500).json({ error: { code: 'internal_error', message: 'internal error' } });
  });
  return app;
}
