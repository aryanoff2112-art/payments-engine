import { loadConfig } from './config';
import { createPool, migrate } from './db';
(async () => { const pool = createPool(loadConfig().databaseUrl); await migrate(pool); await pool.end(); console.log('migrations applied'); })();
