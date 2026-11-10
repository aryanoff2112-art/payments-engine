import { loadConfig } from './config';
import { createPool, migrate } from './db';
import { RedisCache } from './cache';
import { simulateProcessor } from './payments/processor';
import { createApp } from './app';
import { WebhookWorker } from './webhooks/worker';

async function main() {
  const cfg = loadConfig();
  if (process.env.NODE_ENV === 'production') {
    if (!cfg.adminApiKey || cfg.adminApiKey.length < 32) throw new Error('ADMIN_API_KEY (>= 32 chars) is required in production');
    if (cfg.webhook.allowPrivateTargets) throw new Error('WEBHOOK_ALLOW_PRIVATE_TARGETS must not be enabled in production');
  }
  const pool = createPool(cfg.databaseUrl);
  await migrate(pool);
  const cache = new RedisCache(cfg.redisUrl);
  const worker = new WebhookWorker(pool, cfg);
  await cache.onWake(() => worker.wake());
  worker.start();

  const server = createApp({ pool, cache, cfg, processor: simulateProcessor }).listen(cfg.port, () =>
    console.log(`payments-engine listening on :${cfg.port}`));

  const shutdown = async () => {
    worker.stop();
    server.close(async () => { await cache.close(); await pool.end(); process.exit(0); });
    setTimeout(() => process.exit(1), 10_000).unref();
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}
main().catch((e) => { console.error(e); process.exit(1); });
