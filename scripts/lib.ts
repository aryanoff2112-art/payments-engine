import { ChildProcess, spawn } from 'child_process';
import path from 'path';
import Redis from 'ioredis';
import { Pool } from 'pg';
import { issueApiKey } from '../src/auth/apiKeys';

export const DB = process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/payments';
export const root = path.join(__dirname, '..');

export function startServer(port: number, env: Record<string, string> = {}): ChildProcess {
  return spawn('node', ['dist/server.js'], {
    cwd: root, stdio: ['ignore', 'ignore', 'inherit'],
    env: { ...process.env, DATABASE_URL: DB, PORT: String(port), ...env },
  });
}

export async function waitHealthy(port: number, timeoutMs = 20_000) {
  await new Promise((r) => setTimeout(r, 150)); // let a just-killed predecessor release the port
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try { if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) return Date.now() - t0; } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error('server did not become healthy');
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
export const exited = (p: ChildProcess) => new Promise<void>((r) => ((p.exitCode !== null || p.signalCode !== null) ? r() : p.once('exit', () => r())));

const TRUNC = `TRUNCATE webhook_deliveries, outbox_events, webhook_endpoints, ledger_entries, ledger_transactions, idempotency_keys, api_keys, payments, accounts RESTART IDENTITY CASCADE`;
/** Wipes DB state AND the Redis idempotency cache (a cache that outlives a wiped database would replay stale answers). */
export async function resetState(pool: Pool) {
  await pool.query(TRUNC);
  const r = new Redis(process.env.REDIS_URL ?? 'redis://localhost:6379');
  const keys = await r.keys('idem:*');
  if (keys.length) await r.del(...keys);
  r.disconnect();
}

/** Issues one real API key per merchant id; returns merchantId -> bearer token. */
export async function mintKeys(pool: Pool, merchants: string[]): Promise<Map<string, string>> {
  const m = new Map<string, string>();
  for (const id of merchants) m.set(id, (await issueApiKey(pool, id, 'script')).key);
  return m;
}
