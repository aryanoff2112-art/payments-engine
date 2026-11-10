# Reliable Payments Processing Engine (a mini Stripe backend)

A TypeScript/Node.js backend that processes **simulated** payments reliably: idempotent requests, a double-entry
ledger enforced by the database, a transactional outbox with signed and retried webhooks, a payment state machine,
rule-based fraud scoring and a reconciliation engine. The goal is for it to be **proved** by tests, a load test and a
crash test. Those results are not yet established for the current code: see *Verification status* below.

## Verification status

| Evidence | Status for the current commit |
|---|---|
| `tests/ssrf.test.ts`, `tests/apiKeyVerify.test.ts` (DB-free) | Executed (97 cases) under a Jest-compatible shim, not under real Jest |
| Typecheck, build, DB-backed test suites, coverage | **Not yet run** |
| `npm run bench`, `npm run chaos` | **Not yet run** |
| Docker deployment | **Not yet run** |
| `docs/results/*` (63 tests, 92.82% coverage, old benchmark and chaos numbers) | **Historical**: measured before the API-key auth and SSRF changes. Not evidence for this version |

Every figure under "Measured results" below is historical in that sense. See `docs/results/STATUS.md` for the exact
commands that replace them. Until they are run and this table is updated, treat this project as **in progress**.

> **Simulated only.** Payment methods are test tokens (`tok_success`, `tok_decline`, ...). The API rejects anything
> that is not `tok_*`, so card numbers cannot be submitted or stored.

## Quick start

```bash
export ADMIN_API_KEY=$(openssl rand -base64 48)   # required: the container runs with NODE_ENV=production
docker compose up --build          # Postgres + Redis + API on :3000 (migrations run on boot)
# or locally:
npm ci && npm run build
DATABASE_URL=postgres://postgres:postgres@localhost:5432/payments REDIS_URL=redis://localhost:6379 npm start

npm test                           # needs Postgres (TEST_DATABASE_URL) and Redis (REDIS_URL)
npm run test:coverage              # enforces coverage thresholds
npm run bench                      # load test against a real server process
npm run chaos                      # kill -9 + webhook outage scenarios
npm run reconcile                  # run reconciliation from the CLI (exit 1 on discrepancy)
```

```bash
# 1. An operator issues a merchant's first API key (shown once, only its hash is stored)
curl -X POST localhost:3000/v1/admin/merchants/acme/api_keys -H "Authorization: Bearer $ADMIN_API_KEY"
# 2. The merchant uses it
curl -X POST localhost:3000/v1/payments \
  -H 'Authorization: Bearer sk_...' -H 'Idempotency-Key: order-1001' -H 'Content-Type: application/json' \
  -d '{"amount": 2500, "currency": "USD", "paymentMethod": "tok_success", "customerId": "cus_1"}'
```

| Endpoint | Purpose |
|---|---|
| `POST /v1/payments` | Create a payment (`Idempotency-Key` required). 201 succeeded, 402 declined/fraud, 502 processor outage |
| `GET /v1/payments/:id` | Fetch (own payments only) |
| `POST /v1/payments/:id/refund` | Full refund (idempotent, reverses the ledger) |
| `GET /v1/balance` | Merchant balance per currency |
| `PUT /v1/webhook_endpoint` | Register an `https://` URL, returns the signing secret. Private/internal targets are rejected (400 `unsafe_webhook_url`) |
| `GET /v1/api_keys` | List the merchant's keys (metadata only, never secrets) |
| `POST /v1/api_keys/rotate` | Issue a new key; old keys stay valid for `grace_seconds` (default 24 h, `0` = revoke now) |
| `DELETE /v1/api_keys/:id` | Revoke one key |
| `POST /v1/admin/merchants/:id/api_keys` | **Admin.** Issue a merchant's first key |
| `GET /v1/admin/reconciliation` | **Admin.** Run reconciliation (500 if any error-level discrepancy) |

## Security model

**Authentication.** Every `/v1/*` merchant endpoint requires `Authorization: Bearer sk_<id>_<secret>`. The merchant is
derived *only* from the key; `X-Merchant-Id` is ignored (and alone yields 401), so a caller cannot name another
merchant. Keys are 256-bit random values; only `SHA-256(secret)` is stored, looked up by the non-secret id and compared
in constant time. Unknown, expired/revoked and wrong-secret keys all return the same 401 and all run the same hash plus an equal-length (32-byte) constant-time comparison (a missing row is compared against a fixed dummy hash). The one remaining difference is the DB lookup itself, which returns a row or none; the secret comparison does not leak which. Keys can expire, be revoked, and
be rotated with a grace window so deploys need no downtime. `/v1/admin/*` uses a separate operator secret
(`ADMIN_API_KEY`, compared in constant time); a merchant key never grants admin, and with no admin key configured the
admin API is simply off. In production the server refuses to start without an `ADMIN_API_KEY` of 32+ characters.

**Authorization.** All payment, refund, balance and webhook queries are scoped by the authenticated merchant id
(`WHERE merchant_id = $1`), idempotency keys are namespaced per merchant, and a merchant can only list/revoke its own keys.
`tests/api.test.ts` covers cross-merchant reads, refunds, key revocation and header spoofing.

**Webhook SSRF protection** (`src/security/`). Registration and every delivery enforce:
`https` only, port 443 only, no credentials in the URL, no `localhost`/`.local`/`.internal`/single-label hosts, and no
address in loopback, RFC 1918, link-local (incl. cloud metadata `169.254.169.254`), CGNAT, multicast, reserved,
IPv6 ULA/link-local, or IPv4-mapped/NAT64/6to4 forms of those. Decimal/hex/octal IPv4 spellings are normalised by the URL
parser and caught. **DNS rebinding:** registration-time DNS is only early feedback; the connection itself uses a custom
`lookup` that resolves, rejects the connection if *any* answer is non-public, and connects to that same answer, so
validation and connection can't diverge. **Redirects are never followed**: a 3xx is a failed attempt. Blocked targets
are marked `dead` immediately (no retries against them) with `last_error = blocked_target`. Responses are drained, not
buffered. `WEBHOOK_ALLOW_PRIVATE_TARGETS=true` exists for local dev/tests only and the server refuses to boot with it in production.
Defence in depth you should still add in deployment: an egress firewall/proxy for the worker.

## Architecture

```
client -> API (validate, Idempotency-Key) -> ONE Postgres transaction:
            claim key -> insert payment -> fraud score -> state: processing
            -> simulated processor -> ledger entries + balances -> state: succeeded|failed
            -> outbox event -> store response -> COMMIT
         -> (best effort) Redis: cache response for replays, wake the webhook worker
webhook worker: poll outbox (FOR UPDATE SKIP LOCKED, lease) -> signed POST -> backoff/retry/dead
reconciliation: SQL invariants over payments, ledger, balances and outbox
```

Key decisions (and why):

- **Money is `BIGINT` minor units.** No floats anywhere.
- **Postgres is the source of truth for idempotency**; `PRIMARY KEY (merchant_id, key)` is the real guard. Concurrent
  duplicates block on the insert until the first transaction finishes, then replay its stored response. Redis only
  caches the replay; if Redis is down nothing breaks (tested).
- **Everything for one payment commits atomically**: payment, ledger, outbox event and the stored idempotency response.
  A crash at any point leaves no partial state, and the client retries with the same key.
- **The ledger is append-only and balanced by the database.** A deferred constraint trigger rejects any ledger
  transaction that does not net to zero at COMMIT, and triggers forbid UPDATE/DELETE of ledger rows.
  `accounts.balance` is a cache that reconciliation checks against the entries.
- **State machine in two places**: a compare-and-set `UPDATE ... WHERE status = $from` in the app, and a trigger
  that rejects illegal transitions from any source (`pending -> processing -> succeeded|failed`, `succeeded -> refunded`).
- **Deadlock avoidance**: accounts are locked `ORDER BY id FOR UPDATE`.
- **Transactional outbox + at-least-once webhooks (not exactly-once)**: signed with `HMAC-SHA256(secret, "<ts>.<body>")`, with the
  event id in `X-Event-Id` for merchant-side dedup. Backoff `min(base*2^(n-1), 1h) + jitter`, 8 attempts, then
  `dead`. Rows are leased, so a crashed worker's events are reclaimed after the lease expires.
- **Ledger shape**: a payment debits `clearing` for the full amount and credits the merchant (amount - fee) and
  `platform_fees` (fee, default 2.9%). Balances are credit-normal, so the sum of all balances is always 0.
- **Fraud (advisory rules)**: fingerprint velocity, merchant velocity, large amount, amount vs rolling average, card
  testing (repeated declines). Score >= 80 is blocked (`fraud_suspected`, no ledger writes), >= 40 is flagged for review.

### Webhook delivery guarantee: at-least-once, so consumers must deduplicate

If the worker gets a 2xx and crashes before recording `delivered`, the lease expires and the **same event is sent again**.
That is inherent to HTTP delivery without a consumer-side ack protocol; exactly-once is not claimed. Every attempt of an
event carries the same id (JSON body `id` and the `X-Event-Id` header). **Merchants must treat that id as an idempotency key**:
store processed ids and ignore repeats. Events for different payments may also arrive out of order (use `created`
and the payload status). `tests/webhooks.test.ts` proves the redelivery carries an identical event id.

## Proof: the required engineering tests

`npm test` runs the suites below against real Postgres and Redis (no mocks for the database). The SSRF suite (`ssrf.test.ts`) is DB-free. The test counts and coverage figures in this README were last measured *before* the auth/SSRF changes (63 tests, 9 suites); re-run `npm run test:coverage` for current numbers.

| Requirement | Test(s) |
|---|---|
| Same request twice must not double charge | `idempotency.test.ts`: sequential replay; **20 parallel identical requests -> 1 payment, 1 ledger tx, 1 outbox event**; key reuse with a different body -> 422; Redis down |
| Concurrent requests must not corrupt balances | `concurrency.test.ts`: **100 parallel payments to one merchant -> balances exactly equal the sum of net amounts / fees / clearing**; 60 payments across 6 merchants (no deadlocks); 20 parallel refunds -> exactly one wins |
| Failed transaction produces no ledger entry | `failures.test.ts`: declines, insufficient funds, unknown token -> zero ledger rows; processor outage persists nothing and a retry succeeds once; **injected crash after the ledger write and right before COMMIT -> everything rolls back**; overdrawing refund rejected |
| Webhook failure triggers retries | `webhooks.test.ts`: endpoint returns 500, 500, 200 -> **exactly 3 attempts then delivered**; timeouts; dead after max attempts; crashed-worker lease recovery; two workers never double-deliver; signature verification |
| Every completed ledger tx balances | `ledger.test.ts`: DB rejects an unbalanced tx at COMMIT; append-only enforcement; **fast-check property test (30 random runs of payments/declines/refunds across 3 merchants) asserts balanced txs, exact merchant balances, global sum 0 and clean reconciliation** |
| Reconciliation finds introduced discrepancies | `reconciliation.test.ts`: balance off by 1 cent, deleted entry, altered entry, succeeded payment without ledger, failed payment with ledger, amount mismatch, missing outbox event, stuck payment; each is detected by name |

Also: `fraud.test.ts`, `stateMachine.test.ts` (including raw-SQL illegal transitions) and `api.test.ts` (validation, card-number rejection, 401/404/422, replay header).

## Measured results (HISTORICAL: pre-auth/SSRF code)

> **Status of the benchmark numbers.** The tables below were recorded by the *previous* `bench.ts`, which (a) waited a fixed
> 1.5 s before counting, (b) did not capture the machine/config, and (c) ran without authentication. The harness has since
> been fixed (see [`docs/BENCHMARKING.md`](docs/BENCHMARKING.md)): it drains deterministically, asserts an accounting
> invariant, uses real API keys, and writes an `environment` block into `docs/results/bench.json`. **The figures below have
> not been regenerated with the new harness**; treat them as indicative until `npm run bench` is re-run. Authentication adds a
> key lookup to every request, so expect slightly different throughput.

Environment for **every number below**: a single-vCPU Linux sandbox (Node 22, PostgreSQL 16 and Redis installed
via apt, default Postgres config, client load generator, Node server, Postgres and Redis all sharing that one core).
Treat them as a baseline for *this* machine, not as capacity claims. Re-run `npm run bench` on your hardware, or
trigger the `load-and-chaos` CI job. Docker was not available in the sandbox, so the Dockerfile, compose file
and GitHub Actions workflow were written but **not executed** there.

### Test coverage (`npm run test:coverage`; figures below are from the last full run, before the auth/SSRF change: 9 suites, 63 tests)

| Statements | Branches | Functions | Lines |
|---|---|---|---|
| 92.82% | 88.20% | 91.20% | 95.16% |

Excluded from coverage: `server.ts` and the two CLI entry points (exercised by the bench/chaos scripts, which run the
compiled server). The weakest files are `db.ts` (the migration error path) and `cache.ts` (subscriber wiring).
Full table: `docs/results/test-and-coverage.txt`. CI enforces thresholds of 90/85/85/90.

### Latency and throughput (`npm run bench`, autocannon, 10 s per scenario, 0 errors, 0 non-2xx)

| Scenario | Connections | Req/s | p50 | p97.5 | p99 |
|---|---|---|---|---|---|
| New payment, 200 merchants, low concurrency | 4 | 103.6 | 35 ms | 81 ms | 98 ms |
| New payment, 200 merchants | 32 | 134.9 | 182 ms | 634 ms | 779 ms |
| New payment, **one hot merchant** | 32 | 117.0 | 245 ms | 598 ms | 691 ms |
| Replay of an already-processed key (Redis fast path) | 32 | 2,876 | 9 ms | 27 ms | 37 ms |

What this shows:

- A new payment is about a dozen queries in one transaction, so on a shared single core throughput saturates near
  100-135 req/s and latency at 32 connections is mostly queueing.
- The hot-merchant case is only modestly slower here because CPU is the bottleneck on this machine. On multi-core
  hardware, expect per-merchant throughput to be capped by serialization on the merchant, clearing and fee account rows
  (every payment locks the shared `clearing` and `platform_fees` rows too). Sharding the platform accounts is the known next step.
- Replays are about 20x faster than creating a payment because they skip the transaction entirely.
- Exactly-once under load: after ~28,700 replays of one key, there is **1** payment for it. After the whole run reconciliation
  reported **0 discrepancies**. (Payment-row counts were a few higher than autocannon's "requests" because requests already sent but unanswered at the
  deadline still commit afterwards. The new harness drains them and asserts `completed <= payments <= sent`; see BENCHMARKING.md.)

### Failure recovery (`npm run chaos`)

**`kill -9` of the API mid-load.** 600 payments with unique keys, 40 concurrent, SIGKILL after 200 responses, restart, then
the client retries every request whose result it never saw, using the same keys, and re-sends the 200 it did see.

| Metric | Result |
|---|---|
| Requests with unknown outcome after the crash | 400 |
| Payments committed at crash time | 200 |
| Final payments / distinct ids / ledger transactions | **600 / 600 / 600 (0 duplicates, 0 missing)** |
| Re-sent already-answered requests returning a different id | 0 |
| Process start to healthy / kill to healthy | 377 ms / 835 ms |
| Reconciliation afterwards | 0 discrepancies |

Honest limitation: in this run none of the ~40 in-flight requests had committed when the process died (they were queued on
shared row locks), so the "committed but response lost, retry replays" path was not hit by this script. That path *is* covered
deterministically by `idempotency.test.ts` and by the injected-crash tests in `failures.test.ts`, which crash exactly before COMMIT.

**Webhook receiver outage.** 50 events created while the merchant endpoint was down (connection refused), backoff base 200 ms.

| Metric | Result |
|---|---|
| After 2.5 s of outage | 0 delivered, 0 dead, up to 4 attempts per event |
| Time from receiver restored to all 50 delivered | 1.4 s |
| Events received / duplicates / invalid signatures | 50 / 0 / 0 |
| Dead events | 0 |

Raw output: `docs/results/chaos.json`, `docs/results/bench.json`.

## Known limitations (deliberate scope cuts)

- The simulated processor runs *inside* the DB transaction. With a real processor you would split this into
  reserve -> call -> finalize so no connection or lock is held across a network call.
- Failed requests (4xx validation errors, 502 outages) are not stored under the idempotency key; they roll back and may be retried.
  Declines (402) *are* stored and replayed.
- Fraud counts read committed rows, so under heavy concurrency they can lag slightly behind in-flight payments.
- Full refunds only, single currency per account, and webhook ordering between events is not guaranteed
  (use `created` and the payload status).
- The Redis replay cache lives 24 h. If you wipe the database, also flush `idem:*` keys (the bench/chaos scripts do).
- Hot account rows serialize payments per merchant (see above).
- Auth has no rate limiting or lockout on failed attempts, and there is one shared operator admin secret (no per-operator
  identity or audit trail). Webhook signing secrets are stored in plaintext because HMAC needs them. All reasonable next steps.

## Project layout

```
migrations/001_init.sql          schema, triggers (state machine, append-only ledger, balance check), outbox
migrations/002_api_keys.sql      hashed API keys
src/payments/                    service (idempotency, create, refund), state machine, simulated processor
src/ledger/ledger.ts             balanced double-entry posting with ordered row locks
src/fraud/rules.ts               rule-based scoring
src/webhooks/                    worker (lease, backoff, dead-letter) and HMAC signing/verification
src/reconciliation/reconcile.ts  8 invariant checks
src/auth/apiKeys.ts              API-key issue/rotate/revoke, merchant + admin authentication
src/security/                    webhook SSRF guard (IP policy, URL policy, DNS-pinned safe POST)
src/app.ts, server.ts            Express API and bootstrap
tests/                           10 suites (Jest, supertest, fast-check); ssrf.test.ts needs no database
scripts/bench.ts, chaos.ts       load test and failure-recovery scenarios
```

## Six-week roadmap mapping

| Week | Where it lives |
|---|---|
| 1 API design, schema, payment creation | `migrations/`, `src/app.ts`, `payments/service.ts` |
| 2 Idempotency + state machine | `withIdempotency`, `stateMachine.ts`, DB trigger |
| 3 Double-entry ledger + validation | `ledger/ledger.ts`, balance constraint trigger |
| 4 Webhooks, retries, failure handling | `webhooks/`, outbox |
| 5 Fraud, reconciliation, edge cases | `fraud/`, `reconciliation/`, refunds |
| 6 Tests, Docker, CI, docs | `tests/`, `Dockerfile`, `.github/workflows/ci.yml`, this README |
