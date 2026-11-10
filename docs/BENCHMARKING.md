# Benchmarking: method, accounting and reproduction

## Why payment counts exceeded completed requests

autocannon reports `requests.total` = responses it **received** before its deadline. At the deadline it stops counting, but
up to one request per connection has already been written to a socket and is still executing on the server. Those requests
commit *after* the client stopped counting, so a database count taken right after the run (or after a fixed sleep) can exceed
`requests.total` by up to `connections`. The old harness waited a fixed 1.5 s, which is a guess, not a guarantee.

## What the harness does now (`scripts/bench.ts`)

1. **Drains deterministically** after each scenario: polls until no backend of the benchmark database is `active` or
   `idle in transaction` and the payment count is unchanged for 4 consecutive 250 ms polls. It throws if that takes > 60 s.
2. **Asserts the accounting invariant** and fails the run if it is violated:
   - create scenarios: `client_completed <= payments_created <= client_sent`, with `non2xx == 0` and `errors == 0`
     (every completed request was a 2xx create, so each created exactly one payment; requests in flight at the cutoff may or may not have committed);
   - replay scenario: `payments_created == 0`.
3. **Records the accounting** per scenario under `accounting` in `docs/results/bench.json`: `client_completed`, `client_sent`,
   `in_flight_at_cutoff`, `committed_after_cutoff`, `payments_created_after_drain`, `drain_ms`, `holds`.
   (`client_sent` comes from autocannon's `requests.sent`; if the installed version does not provide it, it is `null` and the
   check falls back to `committed_after_cutoff <= connections`.)
4. **Captures the environment** under `environment`: CPU model and logical CPU count, cgroup CPU limit, RAM, kernel, Node and
   autocannon versions, git commit and dirty flag, Postgres version and key settings (`shared_buffers`, `max_connections`,
   `synchronous_commit`, `fsync`, `wal_level`), Redis version, app pool size and benchmark parameters, topology, and the exact commands.
5. Uses real API keys (one minted per benchmark merchant), so the numbers include authentication cost.

## Reproduce

```bash
# Postgres 16 and Redis 7 running locally (or: docker compose up -d postgres redis)
npm ci && npm run build
DATABASE_URL=postgres://postgres:postgres@localhost:5432/payments \
REDIS_URL=redis://localhost:6379 \
BENCH_CONNECTIONS=32 BENCH_DURATION=10 \
npm run bench            # writes docs/results/bench.json, exits non-zero if accounting or reconciliation fails
npm run chaos            # writes docs/results/chaos.json
```

CI: the manual `load-and-chaos` workflow runs the same commands and uploads `docs/results`.

## Reporting rules

- Quote results together with the `environment` block from the same JSON file. Numbers from a host where the load generator,
  API, Postgres and Redis share cores are a baseline for that host, not a capacity claim.
- Report p50/p97.5/p99 with the connection count; latency at 32 connections on a small machine is mostly queueing.
- Never compare a database count to a client count without the drain and the invariant above.
