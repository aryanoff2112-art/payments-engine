import http from 'http';
import { randomUUID } from 'crypto';
import { Pool } from 'pg';
import { ConfigOverrides, loadConfig } from '../src/config';
import { createPool, migrate } from '../src/db';
import { Cache, NullCache, RedisCache } from '../src/cache';
import { Ctx, forgetProvisionedAccounts, Hooks, PaymentRequest } from '../src/payments/service';
import { simulateProcessor, Processor } from '../src/payments/processor';
import { issueApiKey } from '../src/auth/apiKeys';

export const TEST_DB = process.env.TEST_DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/payments_test';
export const TEST_ADMIN_KEY = 'test-admin-key-0123456789-0123456789-abcdef';
export const REDIS_URL = process.env.REDIS_URL ?? 'redis://localhost:6379';

export async function setup(overrides: ConfigOverrides = {}, opts: { cache?: Cache; hooks?: Hooks; processor?: Processor } = {}) {
  const cfg = loadConfig({ databaseUrl: TEST_DB, adminApiKey: TEST_ADMIN_KEY, ...overrides });
  // The local test receivers listen on 127.0.0.1, so private targets are allowed unless a test turns the guard back on.
  cfg.webhook = { ...cfg.webhook, allowPrivateTargets: true, ...(overrides.webhook ?? {}) };
  // Fraud velocity limits are raised by default so unrelated tests aren't affected by them.
  cfg.fraud = { ...cfg.fraud, fingerprintVelocityLimit: 10_000, merchantVelocityLimit: 10_000, ...(overrides.fraud ?? {}) };
  const pool = createPool(TEST_DB, 30);
  await migrate(pool);
  const ctx: Ctx = { pool, cache: opts.cache ?? new NullCache(), cfg, processor: opts.processor ?? simulateProcessor, hooks: opts.hooks };
  return ctx;
}

export async function resetDb(pool: Pool) {
  await pool.query(`TRUNCATE webhook_deliveries, outbox_events, webhook_endpoints, ledger_entries, ledger_transactions,
                    idempotency_keys, api_keys, payments, accounts RESTART IDENTITY CASCADE`);
  forgetProvisionedAccounts();
}

export const pay = (o: Partial<PaymentRequest> = {}): PaymentRequest =>
  ({ amount: 1000, currency: 'USD', paymentMethod: 'tok_success', customerId: randomUUID(), ...o });

export async function count(pool: Pool, table: string, where = 'true', params: unknown[] = []) {
  const { rows } = await pool.query(`SELECT COUNT(*)::int AS n FROM ${table} WHERE ${where}`, params);
  return rows[0].n as number;
}

/** Runs SQL with triggers bypassed, to simulate corruption that the app itself could never produce. */
export async function tamper(pool: Pool, sql: string, params: unknown[] = []) {
  const c = await pool.connect();
  try {
    await c.query(`SET session_replication_role = 'replica'`);
    await c.query(sql, params);
  } finally {
    await c.query(`SET session_replication_role = 'origin'`).catch(() => undefined);
    c.release();
  }
}

export async function merchantBalance(pool: Pool, merchant: string) {
  const { rows } = await pool.query(`SELECT balance FROM accounts WHERE owner_id=$1 AND type='merchant'`, [merchant]);
  return rows[0]?.balance as number;
}

export function makeRedisCache() { return new RedisCache(REDIS_URL); }

/** Local HTTP receiver whose response sequence is scripted, e.g. [500, 500, 200]. */
export async function receiver(script: (number | 'hang')[]) {
  const hits: { headers: http.IncomingHttpHeaders; body: string }[] = [];
  const hung: http.ServerResponse[] = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => (body += d));
    req.on('end', () => {
      hits.push({ headers: req.headers, body });
      const next = script[Math.min(hits.length - 1, script.length - 1)];
      if (next === 'hang') { hung.push(res); return; }
      res.statusCode = next; res.end('x');
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as any).port as number;
  return { url: `http://127.0.0.1:${port}/hook`, hits, close: () => { hung.forEach((r) => r.destroy()); server.closeAllConnections(); return new Promise<void>((r) => server.close(() => r())); } };
}

export const apiKeyFor = async (ctx: Ctx, merchant: string) => (await issueApiKey(ctx.pool, merchant, 'test')).key;
