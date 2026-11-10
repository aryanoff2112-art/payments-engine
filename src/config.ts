export interface FraudConfig {
  windowSec: number;
  fingerprintVelocityLimit: number;
  merchantVelocityLimit: number;
  largeAmount: number;
  anomalyMultiplier: number;
  anomalyMinSamples: number;
  cardTestingDeclines: number;
  cardTestingWindowSec: number;
  blockThreshold: number;
  reviewThreshold: number;
}

export interface Config {
  databaseUrl: string;
  redisUrl: string;
  port: number;
  feeBps: number;
  idempotencyCacheTtlSec: number;
  stuckPaymentSec: number;
  /** Operator secret for /v1/admin/*. Required in production; unset disables the admin API. */
  adminApiKey?: string;
  apiKeyRotationGraceSec: number;
  webhook: {
    timeoutMs: number;
    maxAttempts: number;
    backoffBaseMs: number;
    backoffMaxMs: number;
    leaseMs: number;
    pollIntervalMs: number;
    batchSize: number;
    /** DEV/TEST ONLY: allow http:// and private/loopback webhook targets. Default false. */
    allowPrivateTargets: boolean;
  };
  fraud: FraudConfig;
}

export type ConfigOverrides = Omit<Partial<Config>, 'webhook' | 'fraud'> & { webhook?: Partial<Config['webhook']>; fraud?: Partial<FraudConfig> };

const int = (v: string | undefined, d: number) => (v ? parseInt(v, 10) : d);

export function loadConfig(overrides: ConfigOverrides = {}): Config {
  const base: Config = {
    databaseUrl: process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/payments',
    redisUrl: process.env.REDIS_URL ?? 'redis://localhost:6379',
    port: int(process.env.PORT, 3000),
    feeBps: int(process.env.FEE_BPS, 290),
    idempotencyCacheTtlSec: 24 * 3600,
    stuckPaymentSec: 300,
    adminApiKey: process.env.ADMIN_API_KEY,
    apiKeyRotationGraceSec: int(process.env.API_KEY_ROTATION_GRACE_SEC, 24 * 3600),
    webhook: {
      timeoutMs: int(process.env.WEBHOOK_TIMEOUT_MS, 5000),
      maxAttempts: int(process.env.WEBHOOK_MAX_ATTEMPTS, 8),
      backoffBaseMs: int(process.env.WEBHOOK_BACKOFF_BASE_MS, 1000),
      backoffMaxMs: 3600 * 1000,
      leaseMs: 30_000,
      pollIntervalMs: int(process.env.WEBHOOK_POLL_MS, 1000),
      batchSize: 25,
      allowPrivateTargets: process.env.WEBHOOK_ALLOW_PRIVATE_TARGETS === 'true',
    },
    fraud: {
      windowSec: 60,
      fingerprintVelocityLimit: int(process.env.FRAUD_FP_VELOCITY, 5),
      merchantVelocityLimit: int(process.env.FRAUD_MERCHANT_VELOCITY, 300),
      largeAmount: 1_000_000,
      anomalyMultiplier: 10,
      anomalyMinSamples: 5,
      cardTestingDeclines: 3,
      cardTestingWindowSec: 600,
      blockThreshold: 80,
      reviewThreshold: 40,
    },
  };
  return {
    ...base,
    ...overrides,
    webhook: { ...base.webhook, ...(overrides.webhook ?? {}) },
    fraud: { ...base.fraud, ...(overrides.fraud ?? {}) },
  };
}
