import { randomBytes, timingSafeEqual } from 'crypto';
import { Pool } from 'pg';
import { NextFunction, Request, Response } from 'express';
import { HttpError } from '../errors';
import { sha256 } from '../util';

/** Key format: sk_<keyId>_<secret>. keyId is the DB row id (not secret); secret is 32 random bytes. */
const KEY_RE = /^sk_([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})_([A-Za-z0-9_-]{43})$/;

const safeEqualHex = (a: string, b: string) => {
  const x = Buffer.from(a, 'hex'); const y = Buffer.from(b, 'hex');
  return x.length === y.length && x.length > 0 && timingSafeEqual(x, y);
};

/** Valid-shaped stand-in (32 bytes) compared when no row exists, so a miss runs the SAME-LENGTH constant-time compare as a hit. */
export const DUMMY_KEY_HASH = sha256('api-key-dummy-hash-for-unknown-ids');

/** Constant-time secret check. `storedHash` undefined (unknown/expired/revoked key) still does a full 32-byte compare. */
export function verifySecret(secret: string, storedHash: string | undefined): boolean {
  const match = safeEqualHex(sha256(secret), storedHash ?? DUMMY_KEY_HASH);
  return storedHash !== undefined && match;
}

export interface IssuedKey { id: string; key: string; merchant_id: string; expires_at: string | null }

export async function issueApiKey(pool: Pool, merchantId: string, label?: string): Promise<IssuedKey> {
  const secret = randomBytes(32).toString('base64url');
  const { rows: [row] } = await pool.query(
    `INSERT INTO api_keys (merchant_id, key_hash, label) VALUES ($1, $2, $3) RETURNING id`,
    [merchantId, sha256(secret), label ?? null]);
  return { id: row.id, key: `sk_${row.id}_${secret}`, merchant_id: merchantId, expires_at: null };
}

/**
 * Rotation: issue a new key, and let the merchant's existing active keys keep working for graceSec so
 * they can deploy the new one without downtime. graceSec = 0 revokes the old keys immediately.
 */
export async function rotateApiKeys(pool: Pool, merchantId: string, graceSec: number, label?: string): Promise<IssuedKey> {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    // Serialise rotations per merchant. Without this, two concurrent rotations (grace 0) can each revoke the other's
    // brand-new key and leave the merchant with NO valid key. With it, the later rotation supersedes the earlier one.
    await c.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, ['api_keys:' + merchantId]);
    const secret = randomBytes(32).toString('base64url');
    const { rows: [row] } = await c.query(`INSERT INTO api_keys (merchant_id, key_hash, label) VALUES ($1,$2,$3) RETURNING id`,
      [merchantId, sha256(secret), label ?? null]);
    await c.query(
      `UPDATE api_keys
          SET expires_at = LEAST(COALESCE(expires_at, 'infinity'), now() + make_interval(secs => $3::float8)),
              revoked_at = CASE WHEN $3::float8 <= 0 THEN now() ELSE revoked_at END
        WHERE merchant_id=$1 AND id <> $2 AND revoked_at IS NULL`,
      [merchantId, row.id, graceSec]);
    await c.query('COMMIT');
    return { id: row.id, key: `sk_${row.id}_${secret}`, merchant_id: merchantId, expires_at: null };
  } catch (e) { await c.query('ROLLBACK').catch(() => undefined); throw e; } finally { c.release(); }
}

export async function revokeApiKey(pool: Pool, merchantId: string, keyId: string): Promise<boolean> {
  const r = await pool.query(`UPDATE api_keys SET revoked_at=now() WHERE id=$1 AND merchant_id=$2 AND revoked_at IS NULL`, [keyId, merchantId]);
  return (r.rowCount ?? 0) > 0;
}

export async function listApiKeys(pool: Pool, merchantId: string) {
  const { rows } = await pool.query(
    `SELECT id, label, created_at, expires_at, revoked_at, last_used_at FROM api_keys WHERE merchant_id=$1 ORDER BY created_at DESC`, [merchantId]);
  return rows;
}

const UNAUTH = () => new HttpError(401, 'invalid_api_key', 'valid API key required (Authorization: Bearer sk_...)');

function bearer(req: Request): string | null {
  const h = req.header('authorization');
  const m = h?.match(/^Bearer\s+(\S+)$/i);
  return m ? m[1] : null;
}

/** Returns the merchant that owns the presented key, or throws 401. The merchant is NEVER taken from the request. */
export async function authenticateMerchant(pool: Pool, req: Request): Promise<{ merchantId: string; keyId: string }> {
  const token = bearer(req);
  const m = token?.match(KEY_RE);
  if (!m) throw UNAUTH();
  const [, keyId, secret] = m;
  const { rows: [k] } = await pool.query(
    `SELECT merchant_id, key_hash, last_used_at FROM api_keys
      WHERE id=$1 AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > now())`, [keyId]);
  // The hash and the 32-byte constant-time compare run whether or not a row exists.
  if (!verifySecret(secret, k?.key_hash)) throw UNAUTH();
  if (!k.last_used_at || Date.now() - new Date(k.last_used_at).getTime() > 60_000) {
    // Best-effort, off the hot path. The WHERE clause makes the throttle atomic: requests racing across the 60 s boundary
    // all pass the cheap check above, but only the first UPDATE changes the row; the rest match nothing and write nothing.
    pool.query(`UPDATE api_keys SET last_used_at=now() WHERE id=$1 AND (last_used_at IS NULL OR last_used_at < now() - interval '60 seconds')`, [keyId]).catch(() => undefined);
  }
  return { merchantId: k.merchant_id, keyId };
}

/** Admin access uses a single operator secret from the environment, compared in constant time. */
export function requireAdmin(adminApiKey: string | undefined) {
  return (req: Request, _res: Response, next: NextFunction) => {
    const token = bearer(req);
    if (!adminApiKey || !token) return next(new HttpError(401, 'admin_auth_required', 'admin credentials required'));
    const a = Buffer.from(sha256(token), 'hex'); const b = Buffer.from(sha256(adminApiKey), 'hex');
    if (!timingSafeEqual(a, b)) return next(new HttpError(401, 'admin_auth_required', 'admin credentials required'));
    next();
  };
}
