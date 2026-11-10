import { HttpError } from '../errors';

export type ProcessorResult = { ok: true } | { ok: false; reason: string };
export type Processor = (paymentMethod: string) => Promise<ProcessorResult>;

/**
 * Simulated card processor. Only test tokens exist; no real card data is ever accepted.
 *   tok_success, tok_slow (250ms), tok_decline, tok_insufficient_funds, tok_expired_card,
 *   tok_error (processor outage -> 502, nothing persisted, client may retry with the same key)
 */
export const simulateProcessor: Processor = async (pm) => {
  switch (pm) {
    case 'tok_success': return { ok: true };
    case 'tok_slow': await new Promise((r) => setTimeout(r, 250)); return { ok: true };
    case 'tok_decline': return { ok: false, reason: 'card_declined' };
    case 'tok_insufficient_funds': return { ok: false, reason: 'insufficient_funds' };
    case 'tok_expired_card': return { ok: false, reason: 'expired_card' };
    case 'tok_error': throw new HttpError(502, 'processor_unavailable', 'simulated processor outage');
    default: return { ok: false, reason: 'invalid_payment_method' };
  }
};
