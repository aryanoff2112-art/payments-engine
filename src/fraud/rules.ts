import { Tx } from '../db';
import { FraudConfig } from '../config';

export interface FraudInput { merchantId: string; fingerprint: string; amount: number; paymentId: string }
export interface FraudAssessment { score: number; flags: string[]; decision: 'allow' | 'review' | 'block' }

export const SCORES = { fingerprint_velocity: 40, merchant_velocity: 30, large_amount: 50, amount_anomaly: 30, card_testing: 50 } as const;

/**
 * Rule-based anomaly score. Reads committed data only, so under heavy concurrency counts can lag
 * slightly behind in-flight payments; fraud rules are advisory signals, not a correctness guarantee.
 */
export async function assessFraud(tx: Tx, cfg: FraudConfig, p: FraudInput): Promise<FraudAssessment> {
  const flags: string[] = [];
  let score = 0;
  const add = (flag: keyof typeof SCORES) => { flags.push(flag); score += SCORES[flag]; };

  const { rows: [v] } = await tx.query(
    `SELECT COUNT(*) FILTER (WHERE fingerprint = $2) AS fp,
            COUNT(*) AS merchant
       FROM payments
      WHERE merchant_id = $1 AND id <> $3 AND created_at > now() - make_interval(secs => $4)`,
    [p.merchantId, p.fingerprint, p.paymentId, cfg.windowSec]);
  if (v.fp >= cfg.fingerprintVelocityLimit) add('fingerprint_velocity');
  if (v.merchant >= cfg.merchantVelocityLimit) add('merchant_velocity');

  if (p.amount >= cfg.largeAmount) add('large_amount');

  const { rows: [a] } = await tx.query(
    `SELECT COUNT(*) AS n, COALESCE(AVG(amount), 0)::float8 AS avg
       FROM (SELECT amount FROM payments WHERE merchant_id=$1 AND status='succeeded'
              ORDER BY created_at DESC LIMIT 50) s`, [p.merchantId]);
  if (a.n >= cfg.anomalyMinSamples && p.amount > a.avg * cfg.anomalyMultiplier) add('amount_anomaly');

  const { rows: [d] } = await tx.query(
    `SELECT COUNT(*) AS n FROM payments
      WHERE merchant_id=$1 AND fingerprint=$2 AND status='failed'
        AND failure_reason <> 'fraud_suspected'
        AND created_at > now() - make_interval(secs => $3)`,
    [p.merchantId, p.fingerprint, cfg.cardTestingWindowSec]);
  if (d.n >= cfg.cardTestingDeclines) add('card_testing');

  const decision = score >= cfg.blockThreshold ? 'block' : score >= cfg.reviewThreshold ? 'review' : 'allow';
  return { score, flags, decision };
}
