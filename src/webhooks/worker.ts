import { Pool } from 'pg';
import { Config } from '../config';
import { sign } from './signature';
import { UnsafeUrlError, safePost } from '../security/webhookUrl';

/** Injectable transport (tests). The default is SSRF-safe: see security/webhookUrl.ts. */
export type Fetcher = (url: string, init: { headers: Record<string, string>; body: string; timeoutMs: number }) => Promise<{ status: number }>;

export function backoffMs(attempts: number, cfg: Config['webhook'], rand = Math.random) {
  const exp = Math.min(cfg.backoffBaseMs * 2 ** (attempts - 1), cfg.backoffMaxMs);
  return Math.round(exp + rand() * cfg.backoffBaseMs); // jitter up to one base interval
}

/**
 * Delivers outbox events AT-LEAST-ONCE (never exactly-once): if the process dies after the receiver returned
 * 2xx but before `delivered` is recorded, the lease expires and the event is sent again. Every attempt carries the
 * same event id (body `id` and `X-Event-Id`), which is the deduplication key merchants MUST use.
 * Delivery is SSRF-hardened: targets are validated, DNS is pinned to a validated address, redirects are not followed.
 *
 * Claiming marks rows in_flight with a lease, so a worker
 * that crashes mid-delivery leaves rows that are reclaimed once the lease expires.
 * Attempts are counted at claim time, so crashes consume attempts and retries are always bounded.
 */
export class WebhookWorker {
  private timer?: NodeJS.Timeout;
  private running = false;
  private wakeRequested = false;

  private fetcher: Fetcher;
  constructor(private pool: Pool, private cfg: Config, fetcher?: Fetcher) {
    this.fetcher = fetcher ?? ((url, init) => safePost(url, init, { allowPrivateTargets: cfg.webhook.allowPrivateTargets }));
  }

  async runOnce(): Promise<number> {
    const w = this.cfg.webhook;
    const { rows } = await this.pool.query(
      `UPDATE outbox_events SET status='in_flight', attempts = attempts + 1,
              locked_until = now() + make_interval(secs => $2::float8 / 1000)
        WHERE id IN (
          SELECT id FROM outbox_events
           WHERE (status='pending' AND next_attempt_at <= now()) OR (status='in_flight' AND locked_until < now())
           ORDER BY next_attempt_at, created_at LIMIT $1 FOR UPDATE SKIP LOCKED)
        RETURNING id, merchant_id, type, payload, attempts, created_at`,
      [w.batchSize, w.leaseMs]);
    await Promise.all(rows.map((r) => this.deliver(r)));
    return rows.length;
  }

  private async deliver(ev: any) {
    const w = this.cfg.webhook;
    const { rows: [ep] } = await this.pool.query(`SELECT url, secret FROM webhook_endpoints WHERE merchant_id=$1`, [ev.merchant_id]);
    if (!ep) {
      await this.pool.query(`UPDATE outbox_events SET status='skipped', last_error='no webhook endpoint' WHERE id=$1 AND status='in_flight'`, [ev.id]);
      return;
    }
    const body = JSON.stringify({ id: ev.id, type: ev.type, created: ev.created_at, data: ev.payload });
    const started = Date.now();
    let statusCode: number | null = null;
    let error: string | null = null;
    let blocked = false;
    try {
      const res = await this.fetcher(ep.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-event-id': ev.id, 'x-signature': sign(ep.secret, body) },
        body,
        timeoutMs: w.timeoutMs,
      });
      statusCode = res.status;
      if (res.status < 200 || res.status >= 300) error = `HTTP ${res.status}`;
    } catch (e: any) {
      error = e instanceof UnsafeUrlError || e?.code === 'EBLOCKED' ? 'blocked_target'
        : e?.name === 'TimeoutError' ? 'timeout' : String(e?.cause?.code ?? e?.code ?? e?.message ?? e);
      blocked = error === 'blocked_target';
    }
    await this.pool.query(
      `INSERT INTO webhook_deliveries (event_id, attempt, status_code, error, duration_ms) VALUES ($1,$2,$3,$4,$5)`,
      [ev.id, ev.attempts, statusCode, error, Date.now() - started]);

    if (!error) {
      await this.pool.query(`UPDATE outbox_events SET status='delivered', delivered_at=now(), last_error=NULL WHERE id=$1 AND status='in_flight'`, [ev.id]);
    } else if (blocked) {
      // A blocked target is not transient: retrying cannot help and would keep probing it.
      await this.pool.query(`UPDATE outbox_events SET status='dead', last_error=$2 WHERE id=$1 AND status='in_flight'`, [ev.id, error]);
    } else if (ev.attempts >= w.maxAttempts) {
      await this.pool.query(`UPDATE outbox_events SET status='dead', last_error=$2 WHERE id=$1 AND status='in_flight'`, [ev.id, error]);
    } else {
      await this.pool.query(
        `UPDATE outbox_events SET status='pending', last_error=$2, locked_until=NULL,
                next_attempt_at = now() + make_interval(secs => $3::float8 / 1000)
          WHERE id=$1 AND status='in_flight'`,
        [ev.id, error, backoffMs(ev.attempts, w)]);
    }
  }

  wake() { this.wakeRequested = true; if (this.running && !this.busy) this.schedule(0); }
  private busy = false;
  private schedule(ms: number) {
    if (!this.running) return;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.tick(), ms);
  }
  private async tick() {
    this.busy = true;
    try {
      this.wakeRequested = false;
      const n = await this.runOnce();
      this.busy = false;
      this.schedule(n >= this.cfg.webhook.batchSize || this.wakeRequested ? 0 : this.cfg.webhook.pollIntervalMs);
    } catch (e) {
      this.busy = false;
      console.error('webhook worker error', e);
      this.schedule(this.cfg.webhook.pollIntervalMs);
    }
  }
  start() { this.running = true; this.schedule(0); }
  stop() { this.running = false; clearTimeout(this.timer); }
}
