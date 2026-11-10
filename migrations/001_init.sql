-- Money is BIGINT minor units (cents). Balance convention: credit-normal,
-- balance = SUM(credits) - SUM(debits). Every ledger tx nets to zero, so SUM(all balances) = 0.

CREATE TABLE accounts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('merchant','clearing','platform_fees')),
  currency CHAR(3) NOT NULL,
  balance BIGINT NOT NULL DEFAULT 0,      -- cached; reconciled against ledger_entries
  UNIQUE (owner_id, type, currency)
);

CREATE TABLE payments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  merchant_id TEXT NOT NULL,
  amount BIGINT NOT NULL CHECK (amount > 0),
  currency CHAR(3) NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending','processing','succeeded','failed','refunded')),
  failure_reason TEXT,
  payment_method TEXT NOT NULL,           -- simulated token only (tok_*), never card data
  customer_id TEXT,
  description TEXT,
  fingerprint TEXT NOT NULL,
  fee BIGINT NOT NULL DEFAULT 0,
  fraud_score INT NOT NULL DEFAULT 0,
  fraud_flags JSONB NOT NULL DEFAULT '[]',
  flagged_for_review BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX payments_merchant_created ON payments (merchant_id, created_at DESC);
CREATE INDEX payments_fingerprint_created ON payments (merchant_id, fingerprint, created_at DESC);

-- Transaction state machine, enforced by the database as well as the app.
CREATE FUNCTION enforce_payment_transition() RETURNS trigger AS $$
BEGIN
  IF NEW.status = OLD.status THEN RETURN NEW; END IF;
  IF (OLD.status, NEW.status) IN (
       ('pending','processing'), ('processing','succeeded'),
       ('processing','failed'),  ('succeeded','refunded')) THEN
    NEW.updated_at = now();
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'illegal payment transition % -> %', OLD.status, NEW.status;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER payments_state_machine BEFORE UPDATE OF status ON payments
  FOR EACH ROW EXECUTE FUNCTION enforce_payment_transition();

CREATE TABLE idempotency_keys (
  merchant_id TEXT NOT NULL,
  key TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  status_code INT,
  response JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (merchant_id, key)          -- the real duplicate guard
);

CREATE TABLE ledger_transactions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  payment_id UUID NOT NULL REFERENCES payments(id),
  kind TEXT NOT NULL CHECK (kind IN ('payment','refund')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (payment_id, kind)               -- at most one payment tx and one refund tx per payment
);

CREATE TABLE ledger_entries (
  id BIGSERIAL PRIMARY KEY,
  ledger_tx_id UUID NOT NULL REFERENCES ledger_transactions(id),
  account_id UUID NOT NULL REFERENCES accounts(id),
  direction TEXT NOT NULL CHECK (direction IN ('debit','credit')),
  amount BIGINT NOT NULL CHECK (amount > 0)
);
CREATE INDEX ledger_entries_tx ON ledger_entries (ledger_tx_id);
CREATE INDEX ledger_entries_account ON ledger_entries (account_id);

-- Append-only ledger.
CREATE FUNCTION forbid_mutation() RETURNS trigger AS $$
BEGIN RAISE EXCEPTION '% on % is not allowed: ledger is append-only', TG_OP, TG_TABLE_NAME; END $$ LANGUAGE plpgsql;
CREATE TRIGGER ledger_entries_immutable BEFORE UPDATE OR DELETE ON ledger_entries
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER ledger_tx_immutable BEFORE UPDATE OR DELETE ON ledger_transactions
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- Every ledger transaction must balance at COMMIT, so app bugs cannot break the invariant.
CREATE FUNCTION assert_balanced() RETURNS trigger AS $$
BEGIN
  IF (SELECT COALESCE(SUM(CASE direction WHEN 'debit' THEN amount ELSE -amount END), 0)
        FROM ledger_entries WHERE ledger_tx_id = NEW.ledger_tx_id) <> 0 THEN
    RAISE EXCEPTION 'unbalanced ledger transaction %', NEW.ledger_tx_id;
  END IF;
  RETURN NULL;
END $$ LANGUAGE plpgsql;
CREATE CONSTRAINT TRIGGER ledger_balanced AFTER INSERT ON ledger_entries
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION assert_balanced();

-- Transactional outbox: written in the same tx as the state change.
CREATE TABLE outbox_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  merchant_id TEXT NOT NULL,
  payment_id UUID NOT NULL REFERENCES payments(id),
  type TEXT NOT NULL,
  payload JSONB NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','in_flight','delivered','dead','skipped')),
  attempts INT NOT NULL DEFAULT 0,
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  locked_until TIMESTAMPTZ,
  last_error TEXT,
  delivered_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX outbox_due ON outbox_events (status, next_attempt_at);
CREATE INDEX outbox_payment ON outbox_events (payment_id);

CREATE TABLE webhook_endpoints (
  merchant_id TEXT PRIMARY KEY,
  url TEXT NOT NULL,
  secret TEXT NOT NULL
);

CREATE TABLE webhook_deliveries (
  id BIGSERIAL PRIMARY KEY,
  event_id UUID NOT NULL REFERENCES outbox_events(id),
  attempt INT NOT NULL,
  status_code INT,
  error TEXT,
  duration_ms INT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX webhook_deliveries_event ON webhook_deliveries (event_id);
