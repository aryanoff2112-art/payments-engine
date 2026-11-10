# Verification status of this archive

`test-and-coverage.txt`, `bench.json` and `chaos.json` in this directory were produced BEFORE the API-key auth and
webhook-SSRF changes (63 tests / 9 suites; old bench format without `environment` or `accounting`).
They are stale and must not be cited for the current code.

Also changed since the last status: `last_used_at` updates are now throttled atomically in SQL (not executed against a DB).

Executed against the current code: only `tests/ssrf.test.ts` and `tests/apiKeyVerify.test.ts` (97 cases, DB-free, under a
Jest-compatible shim). NOT executed: `npm ci`, `npm run typecheck`, `npm run build`, the DB-backed suites, coverage,
`npm run bench`, `npm run chaos`, Docker.

To replace this file with real evidence, run on a machine with Node 22, Postgres 16 and Redis 7:

    npm ci && npm run typecheck && npm run build
    npm run test:coverage 2>&1 | tee docs/results/test-and-coverage.txt
    npm run bench && npm run chaos
