import { Pool, PoolClient, types } from 'pg';
import { readdirSync, readFileSync } from 'fs';
import path from 'path';

// BIGINT / COUNT / SUM-cast-to-bigint come back as numbers. Amounts are capped far below 2^53.
types.setTypeParser(20, (v) => Number(v));

export function createPool(databaseUrl: string, max = 20): Pool {
  return new Pool({ connectionString: databaseUrl, max });
}

export async function migrate(pool: Pool, dir = path.join(__dirname, '..', 'migrations')) {
  const client = await pool.connect();
  try {
    await client.query('SELECT pg_advisory_lock(727274)');
    await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
    const applied = new Set((await client.query('SELECT name FROM schema_migrations')).rows.map((r) => r.name));
    for (const f of readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()) {
      if (applied.has(f)) continue;
      await client.query('BEGIN');
      try {
        await client.query(readFileSync(path.join(dir, f), 'utf8'));
        await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [f]);
        await client.query('COMMIT');
      } catch (e) {
        await client.query('ROLLBACK');
        throw e;
      }
    }
  } finally {
    await client.query('SELECT pg_advisory_unlock(727274)').catch(() => undefined);
    client.release();
  }
}

export type Tx = PoolClient;
