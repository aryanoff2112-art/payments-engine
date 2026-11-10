import { createHmac, timingSafeEqual } from 'crypto';

export function sign(secret: string, body: string, ts = Math.floor(Date.now() / 1000)) {
  const v1 = createHmac('sha256', secret).update(`${ts}.${body}`).digest('hex');
  return `t=${ts},v1=${v1}`;
}

/** For merchants: verify the X-Signature header and reject stale timestamps (replay protection). */
export function verify(secret: string, body: string, header: string, toleranceSec = 300, now = Math.floor(Date.now() / 1000)) {
  const parts = Object.fromEntries(header.split(',').map((kv) => kv.split('=') as [string, string]));
  const ts = Number(parts.t);
  if (!ts || !parts.v1 || Math.abs(now - ts) > toleranceSec) return false;
  const expected = createHmac('sha256', secret).update(`${ts}.${body}`).digest();
  const given = Buffer.from(parts.v1, 'hex');
  return given.length === expected.length && timingSafeEqual(given, expected);
}
