-- API keys. Only a SHA-256 hash of the secret is stored; the plaintext is shown exactly once at creation.
-- Keys are 256-bit random values, so a fast hash is appropriate (no password-style stretching needed),
-- and lookup is by the non-secret key id so no hash comparison happens in SQL.
CREATE TABLE api_keys (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  merchant_id TEXT NOT NULL,
  key_hash TEXT NOT NULL,                 -- hex(sha256(secret))
  label TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ,                 -- set during rotation: old key keeps working until this instant
  revoked_at TIMESTAMPTZ,
  last_used_at TIMESTAMPTZ
);
CREATE INDEX api_keys_merchant ON api_keys (merchant_id);
