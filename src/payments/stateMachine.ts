import { Tx } from '../db';
import { HttpError } from '../errors';

export type PaymentStatus = 'pending' | 'processing' | 'succeeded' | 'failed' | 'refunded';

const TRANSITIONS: Record<PaymentStatus, PaymentStatus[]> = {
  pending: ['processing'],
  processing: ['succeeded', 'failed'],
  succeeded: ['refunded'],
  failed: [],
  refunded: [],
};

export const canTransition = (from: PaymentStatus, to: PaymentStatus) => TRANSITIONS[from].includes(to);

/** Atomic compare-and-set: UPDATE ... WHERE id=$1 AND status=$2. Zero rows means someone else moved it. */
export async function transition(
  tx: Tx, paymentId: string, from: PaymentStatus, to: PaymentStatus,
  extra: { failureReason?: string | null; fee?: number; fraudScore?: number; fraudFlags?: string[]; flagged?: boolean } = {},
) {
  if (!canTransition(from, to)) throw new HttpError(409, 'illegal_transition', `${from} -> ${to}`);
  const r = await tx.query(
    `UPDATE payments SET status=$3,
        failure_reason = COALESCE($4, failure_reason),
        fee = COALESCE($5, fee),
        fraud_score = COALESCE($6, fraud_score),
        fraud_flags = COALESCE($7::jsonb, fraud_flags),
        flagged_for_review = COALESCE($8, flagged_for_review)
      WHERE id=$1 AND status=$2`,
    [paymentId, from, to, extra.failureReason ?? null, extra.fee ?? null, extra.fraudScore ?? null,
     extra.fraudFlags ? JSON.stringify(extra.fraudFlags) : null, extra.flagged ?? null],
  );
  if (r.rowCount !== 1) throw new HttpError(409, 'state_conflict', `payment ${paymentId} not in state ${from}`);
}
