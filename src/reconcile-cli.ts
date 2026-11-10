import { loadConfig } from './config';
import { createPool } from './db';
import { reconcile } from './reconciliation/reconcile';
(async () => {
  const pool = createPool(loadConfig().databaseUrl);
  const report = await reconcile(pool);
  console.log(JSON.stringify(report, null, 2));
  await pool.end();
  process.exit(report.ok ? 0 : 1);
})();
