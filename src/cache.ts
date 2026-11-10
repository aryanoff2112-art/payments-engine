import Redis from 'ioredis';

export interface CachedResponse { hash: string; status: number; body: unknown }

/**
 * Redis is a best-effort fast path only. Postgres remains the source of truth for idempotency,
 * so every method swallows errors: if Redis is down, correctness is unaffected.
 */
export interface Cache {
  getIdem(merchantId: string, key: string): Promise<CachedResponse | null>;
  setIdem(merchantId: string, key: string, v: CachedResponse, ttlSec: number): Promise<void>;
  publishWake(): Promise<void>;
  onWake(cb: () => void): Promise<void>;
  close(): Promise<void>;
}

export class NullCache implements Cache {
  async getIdem() { return null; }
  async setIdem() {}
  async publishWake() {}
  async onWake() {}
  async close() {}
}

export class RedisCache implements Cache {
  private r: Redis;
  private sub?: Redis;
  constructor(private url: string) {
    this.r = this.make();
  }
  private make() {
    const c = new Redis(this.url, {
      lazyConnect: false, enableOfflineQueue: false, maxRetriesPerRequest: 1,
      commandTimeout: 150, retryStrategy: (n) => Math.min(n * 200, 2000),
    });
    c.on('error', () => undefined);
    return c;
  }
  async getIdem(m: string, k: string) {
    try {
      const v = await this.r.get(`idem:${m}:${k}`);
      return v ? (JSON.parse(v) as CachedResponse) : null;
    } catch { return null; }
  }
  async setIdem(m: string, k: string, v: CachedResponse, ttl: number) {
    try { await this.r.set(`idem:${m}:${k}`, JSON.stringify(v), 'EX', ttl); } catch { /* best effort */ }
  }
  async publishWake() {
    try { await this.r.publish('outbox:wake', '1'); } catch { /* polling covers it */ }
  }
  async onWake(cb: () => void) {
    this.sub = this.make();
    this.sub.on('message', cb);
    this.sub.on('ready', () => { this.sub?.subscribe('outbox:wake').catch(() => undefined); });
  }
  async close() {
    this.r.disconnect();
    this.sub?.disconnect();
  }
}
