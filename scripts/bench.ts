import autocannon from 'autocannon';
import { randomUUID } from 'crypto';
import { writeFileSync, mkdirSync } from 'fs';
import { execSync } from 'child_process';
import os from 'os';
import path from 'path';
import Redis from 'ioredis';
import { Pool } from 'pg';
import { reconcile } from '../src/reconciliation/reconcile';
import { migrate } from '../src/db';
import { resetState, DB, exited, mintKeys, root, startServer, waitHealthy } from './lib';

const PORT = 3100;
const CONNECTIONS = Number(process.env.BENCH_CONNECTIONS ?? 32);
const DURATION = Number(process.env.BENCH_DURATION ?? 10);

type Scenario = { name: string; description: string; connections?: number; setup: (req: any) => any };
const body = (customerId: string) => JSON.stringify({ amount: 2500, currency: 'USD', paymentMethod: 'tok_success', customerId });
const REPLAY_KEY = randomUUID();
const MERCHANTS = 200;
let keys = new Map<string, string>();   // merchant id -> real API key, minted after the state reset
const bearer = (m: string) => `Bearer ${keys.get(m)}`;
const pick = () => 'm' + Math.floor(Math.random() * MERCHANTS);

const scenarios: Scenario[] = [
  { name: 'distinct_merchants_low_concurrency', description: 'Same as distinct_merchants but only 4 connections (latency with little queueing)', connections: 4,
    setup: (req) => { { const m = pick(); req.headers['authorization'] = bearer(m); } req.headers['idempotency-key'] = randomUUID(); req.body = body(randomUUID()); return req; } },
  { name: 'distinct_merchants', description: 'POST /v1/payments, unique key, 200 different merchants (no single hot account)',
    setup: (req) => { { const m = pick(); req.headers['authorization'] = bearer(m); } req.headers['idempotency-key'] = randomUUID(); req.body = body(randomUUID()); return req; } },
  { name: 'single_hot_merchant', description: 'POST /v1/payments, unique key, ONE merchant (every payment locks the same account rows)',
    setup: (req) => { req.headers['authorization'] = bearer('hot'); req.headers['idempotency-key'] = randomUUID(); req.body = body(randomUUID()); return req; } },
  { name: 'idempotent_replay', description: 'POST /v1/payments replaying one already-processed key (Redis fast path)',
    setup: (req) => { req.headers['authorization'] = bearer('replay'); req.headers['idempotency-key'] = REPLAY_KEY; req.body = body('fixed'); return req; } },
];


/**
 * Waits until the server has finished EVERYTHING it accepted: no backend of ours is running a query or holding an
 * open transaction, and the payment count has stopped moving for several consecutive polls.
 * autocannon stops counting at the deadline, but requests it already sent keep executing on the server and commit
 * afterwards. Comparing DB totals before this drain is what produced "payments > completed requests".
 */
async function drain(pool: Pool, timeoutMs = 60_000): Promise<{ drainMs: number; settledCount: number }> {
  const t0 = Date.now();
  let last = -1, stable = 0;
  while (Date.now() - t0 < timeoutMs) {
    const busy = (await pool.query(
      `SELECT COUNT(*)::int n FROM pg_stat_activity
        WHERE datname = current_database() AND pid <> pg_backend_pid() AND state IN ('active','idle in transaction')`)).rows[0].n;
    const count = (await pool.query(`SELECT COUNT(*)::int n FROM payments`)).rows[0].n;
    stable = busy === 0 && count === last ? stable + 1 : 0;
    last = count;
    if (stable >= 4) return { drainMs: Date.now() - t0, settledCount: count };
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error('benchmark did not drain: server still busy after ' + timeoutMs + ' ms');
}

const sh = (cmd: string) => { try { return execSync(cmd, { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim(); } catch { return null; } };

/** Everything needed to interpret (or reproduce) the numbers, captured from the machine that produced them. */
async function captureEnvironment(pool: Pool) {
  const pg = async (name: string) => (await pool.query(`SHOW ${name}`)).rows[0][name];
  const redis = new Redis(process.env.REDIS_URL ?? 'redis://localhost:6379');
  const redisInfo = await redis.info('server').catch(() => '');
  redis.disconnect();
  const cpus = os.cpus();
  return {
    host: { platform: os.platform(), kernel: os.release(), arch: os.arch(), cpu_model: cpus[0]?.model ?? null, logical_cpus: cpus.length, total_mem_mb: Math.round(os.totalmem() / 1048576), loadavg_at_start: os.loadavg(), container: sh('cat /proc/1/cgroup | head -1'), cpu_limit_cgroup: sh('cat /sys/fs/cgroup/cpu.max') },
    runtime: { node: process.version, autocannon: require('autocannon/package.json').version, git_commit: sh('git rev-parse --short HEAD'), git_dirty: sh('git status --porcelain') ? true : false },
    postgres: { version: (await pool.query('SELECT version()')).rows[0].version, shared_buffers: await pg('shared_buffers'), max_connections: await pg('max_connections'), synchronous_commit: await pg('synchronous_commit'), fsync: await pg('fsync'), wal_level: await pg('wal_level'), config_is_default: 'verify: compare the values above with stock Postgres defaults' },
    redis: { version: /redis_version:(\S+)/.exec(redisInfo)?.[1] ?? null },
    app: { pool_max_connections: 20, fee_bps: process.env.FEE_BPS ?? '290 (default)', fraud_merchant_velocity: '100000000 (effectively disabled for the run)', webhook_worker: 'enabled, no endpoints registered (events are marked skipped)' },
    topology: 'load generator, Node API, Postgres and Redis all on this one host (they compete for the same CPU)',
    parameters: { connections_default: CONNECTIONS, duration_s: DURATION, merchants: MERCHANTS, drain: 'wait for idle DB backends and a stable payment count (4 polls x 250 ms) before comparing totals' },
    commands: ['npm ci && npm run build', 'DATABASE_URL=' + DB.replace(/:[^:@/]*@/, ':***@') + ' REDIS_URL=' + (process.env.REDIS_URL ?? 'redis://localhost:6379') + ' BENCH_CONNECTIONS=' + CONNECTIONS + ' BENCH_DURATION=' + DURATION + ' npm run bench'],
  };
}

(async () => {
  const pool = new Pool({ connectionString: DB });
  await migrate(pool);
  await resetState(pool);
  keys = await mintKeys(pool, [...Array.from({ length: MERCHANTS }, (_, i) => 'm' + i), 'hot', 'replay']);
  const server = startServer(PORT, { FRAUD_MERCHANT_VELOCITY: '100000000' });
  await waitHealthy(PORT);
  // prime the replay key
  await fetch(`http://127.0.0.1:${PORT}/v1/payments`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: bearer('replay'), 'idempotency-key': REPLAY_KEY }, body: body('fixed') });

  const environment = await captureEnvironment(pool);
  const results: any[] = [];
  for (const s of scenarios) {
    const before = (await pool.query(`SELECT COUNT(*)::int n FROM payments`)).rows[0].n;
    const r = await autocannon({
      url: `http://127.0.0.1:${PORT}`, connections: s.connections ?? CONNECTIONS, duration: DURATION,
      requests: [{ method: 'POST', path: '/v1/payments', headers: { 'content-type': 'application/json' }, setupRequest: s.setup }],
    });
    const drained = await drain(pool);          // deterministic: no fixed sleep, no in-flight work left
    const after = drained.settledCount;
    const completed = r.requests.total;          // responses autocannon received before its deadline
    const sent = (r.requests as any).sent ?? null; // requests autocannon wrote to sockets (completed + still in flight at the deadline)
    const created = after - before;
    const isReplay = s.name === 'idempotent_replay';
    // Accounting invariant. A request counted as completed created exactly one payment (every one was a 2xx create).
    // A request sent but unanswered at the deadline may or may not have committed. So: completed <= created <= sent.
    const inFlightAtCutoff = sent === null ? null : sent - completed;
    const committedAfterCutoff = created - completed;
    const accountingOk = isReplay ? created === 0
      : r.non2xx === 0 && r.errors === 0 && created >= completed && (sent === null ? committedAfterCutoff <= (s.connections ?? CONNECTIONS) : created <= sent);
    if (!accountingOk) throw new Error(`benchmark accounting violated in ${s.name}: completed=${completed} sent=${sent} created=${created} non2xx=${r.non2xx} errors=${r.errors}`);
    const row = {
      scenario: s.name, description: s.description, connections: s.connections ?? CONNECTIONS, duration_s: DURATION,
      requests_per_sec_avg: r.requests.average, total_requests: completed,
      latency_ms: { avg: r.latency.average, p50: r.latency.p50, p90: r.latency.p90, p97_5: r.latency.p97_5, p99: r.latency.p99, max: r.latency.max },
      http_2xx: r['2xx'], errors: r.errors, timeouts: r.timeouts, non2xx: r.non2xx,
      accounting: {
        client_completed: completed, client_sent: sent, in_flight_at_cutoff: inFlightAtCutoff,
        payments_created_after_drain: created, committed_after_cutoff: isReplay ? 0 : committedAfterCutoff, drain_ms: drained.drainMs,
        invariant: isReplay ? 'payments_created == 0' : 'client_completed <= payments_created <= client_sent',
        holds: accountingOk,
      },
      payments_created: created,
    };
    results.push(row);
    console.log(JSON.stringify(row));
  }

  const replayPayments = (await pool.query(`SELECT COUNT(*)::int n FROM payments WHERE merchant_id='replay'`)).rows[0].n;
  const report = await reconcile(pool);
  const out = { when: new Date().toISOString(), environment, results, payments_for_replayed_key: replayPayments, reconciliation_after_load: { ok: report.ok, discrepancies: report.discrepancies.length } };
  const dir = path.join(root, 'docs', 'results'); mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'bench.json'), JSON.stringify(out, null, 2));
  console.log('reconciliation after load:', report.ok ? 'OK' : report.discrepancies.slice(0, 3));
  server.kill('SIGTERM'); await exited(server); await pool.end();
})();
