import http from 'http';
import { writeFileSync, mkdirSync } from 'fs';
import path from 'path';
import { Pool } from 'pg';
import { reconcile } from '../src/reconciliation/reconcile';
import { migrate } from '../src/db';
import { resetState, DB, exited, mintKeys, root, sleep, startServer, waitHealthy } from './lib';

const PORT = 3200;
const RX_PORT = 3201;
const base = `http://127.0.0.1:${PORT}`;
const payload = (i: number) => JSON.stringify({ amount: 1000 + i, currency: 'USD', paymentMethod: 'tok_success', customerId: `c${i}` });
let keys = new Map<string, string>();   // merchant -> API key, minted after every state reset
const send = (merchant: string, key: string, i: number) =>
  fetch(`${base}/v1/payments`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${keys.get(merchant)}`, 'idempotency-key': key }, body: payload(i) });
const TRUNC = `TRUNCATE webhook_deliveries, outbox_events, webhook_endpoints, ledger_entries, ledger_transactions, idempotency_keys, api_keys, payments, accounts RESTART IDENTITY CASCADE`;

async function crashRecovery(pool: Pool) {
  await resetState(pool);
  keys = await mintKeys(pool, ['chaos']);
  const N = 600, KILL_AFTER = 200;
  let server = startServer(PORT, { FRAUD_MERCHANT_VELOCITY: '100000000' });
  await waitHealthy(PORT);

  const answered = new Map<string, string>();      // key -> payment id received before the crash
  let done = 0, killedAt = 0;
  const queue = Array.from({ length: N }, (_, i) => i);
  let killed = false;
  const worker = async () => {
    while (queue.length) {
      const i = queue.shift()!;
      try {
        const r = await send('chaos', `key-${i}`, i);
        const b: any = await r.json();
        answered.set(`key-${i}`, b.id);
        if (++done === KILL_AFTER && !killed) { killed = true; killedAt = Date.now(); server.kill('SIGKILL'); }
      } catch { /* connection reset by the crash: outcome unknown to the client */ }
    }
  };
  await Promise.all(Array.from({ length: 40 }, worker));
  await exited(server);

  const committedAtCrash = (await pool.query(`SELECT COUNT(*)::int n FROM payments`)).rows[0].n;
  server = startServer(PORT, { FRAUD_MERCHANT_VELOCITY: '100000000' });
  const restartMs = await waitHealthy(PORT);
  const recoveryMs = Date.now() - killedAt;

  // A client retries every request whose result it never saw, with the SAME key, plus re-sends the rest.
  const unknown = Array.from({ length: N }, (_, i) => i).filter((i) => !answered.has(`key-${i}`));
  let replayed = 0, createdOnRetry = 0, idMismatch = 0;
  await Promise.all(unknown.map(async (i) => {
    const r = await send('chaos', `key-${i}`, i);
    const b: any = await r.json();
    if (r.headers.get('idempotent-replayed')) replayed++; else createdOnRetry++;
    answered.set(`key-${i}`, b.id);
  }));
  // Re-send everything that WAS answered: must replay with identical ids.
  await Promise.all([...answered.entries()].filter(([k]) => !unknown.includes(Number(k.slice(4)))).map(async ([k, id]) => {
    const r = await send('chaos', k, Number(k.slice(4))); const b: any = await r.json();
    if (b.id !== id) idMismatch++;
  }));

  const q = async (sql: string) => (await pool.query(sql)).rows[0];
  const payments = (await q(`SELECT COUNT(*)::int n, COUNT(DISTINCT id)::int d FROM payments`));
  const ledgerTx = (await q(`SELECT COUNT(*)::int n FROM ledger_transactions`)).n;
  const report = await reconcile(pool);
  server.kill('SIGTERM'); await exited(server);
  return {
    requests_planned: N, killed_with_sigkill_after_responses: KILL_AFTER, requests_with_unknown_outcome: unknown.length,
    payments_committed_at_crash: committedAtCrash,
    unknown_outcome_retries: { already_committed_replayed: replayed, not_committed_created_on_retry: createdOnRetry },
    replay_id_mismatches: idMismatch,
    final: { payments: payments.n, distinct_payment_ids: payments.d, ledger_transactions: ledgerTx, duplicates: payments.n - N },
    process_restart_to_healthy_ms: restartMs, kill_to_healthy_ms: recoveryMs,
    reconciliation_ok: report.ok, reconciliation_discrepancies: report.discrepancies.length,
  };
}

async function webhookOutage(pool: Pool) {
  await resetState(pool);
  keys = await mintKeys(pool, ['wh']);
  const server = startServer(PORT, { WEBHOOK_ALLOW_PRIVATE_TARGETS: 'true', WEBHOOK_BACKOFF_BASE_MS: '200', WEBHOOK_POLL_MS: '100', WEBHOOK_TIMEOUT_MS: '1000', WEBHOOK_MAX_ATTEMPTS: '10' });
  await waitHealthy(PORT);
  const ep: any = await (await fetch(`${base}/v1/webhook_endpoint`, { method: 'PUT', headers: { 'content-type': 'application/json', authorization: `Bearer ${keys.get('wh')}` }, body: JSON.stringify({ url: `http://127.0.0.1:${RX_PORT}/hook` }) })).json();
  const N = 50;
  for (let i = 0; i < N; i++) await send('wh', `w${i}`, i);     // receiver is DOWN (nothing listening)

  await sleep(2500);
  const during = (await pool.query(`SELECT COUNT(*) FILTER (WHERE status='delivered')::int delivered, COALESCE(MAX(attempts),0)::int max_attempts, COUNT(*) FILTER (WHERE status='dead')::int dead FROM outbox_events`)).rows[0];

  const seen = new Map<string, number>(); let badSig = 0;
  const { verify } = await import('../src/webhooks/signature');
  const rx = http.createServer((req, res) => {
    let b = ''; req.on('data', (d) => (b += d));
    req.on('end', () => {
      if (!verify(ep.secret, b, String(req.headers['x-signature']))) badSig++;
      const id = String(req.headers['x-event-id']); seen.set(id, (seen.get(id) ?? 0) + 1);
      res.end('ok');
    });
  });
  await new Promise<void>((r) => rx.listen(RX_PORT, '127.0.0.1', r));
  const upAt = Date.now();
  let drainedMs = -1;
  while (Date.now() - upAt < 60_000) {
    const n = (await pool.query(`SELECT COUNT(*)::int n FROM outbox_events WHERE status IN ('pending','in_flight')`)).rows[0].n;
    if (n === 0) { drainedMs = Date.now() - upAt; break; }
    await sleep(100);
  }
  const after = (await pool.query(`SELECT COUNT(*) FILTER (WHERE status='delivered')::int delivered, COUNT(*) FILTER (WHERE status='dead')::int dead, MAX(attempts)::int max_attempts, SUM(attempts)::int total_attempts FROM outbox_events`)).rows[0];
  const report = await reconcile(pool);
  rx.close(); rx.closeAllConnections(); server.kill('SIGTERM'); await exited(server);
  return {
    events: N, during_outage_after_2_5s: during, after_receiver_restored: after,
    time_to_drain_after_receiver_restored_ms: drainedMs,
    unique_events_received: seen.size, duplicate_deliveries: [...seen.values()].reduce((s, c) => s + c - 1, 0), invalid_signatures: badSig,
    reconciliation_ok: report.ok,
  };
}

(async () => {
  const pool = new Pool({ connectionString: DB });
  await migrate(pool);
  const crash = await crashRecovery(pool); console.log('crash recovery:', JSON.stringify(crash, null, 2));
  const hooks = await webhookOutage(pool); console.log('webhook outage:', JSON.stringify(hooks, null, 2));
  const dir = path.join(root, 'docs', 'results'); mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'chaos.json'), JSON.stringify({ when: new Date().toISOString(), crash_recovery: crash, webhook_outage: hooks }, null, 2));
  await pool.end();
})();
