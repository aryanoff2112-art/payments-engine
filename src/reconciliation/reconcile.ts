import { Pool } from 'pg';

export interface Discrepancy { check: string; severity: 'error' | 'warning'; detail: Record<string, unknown> }
export interface ReconciliationReport { ok: boolean; checkedAt: string; discrepancies: Discrepancy[] }

const NET = `SUM(CASE e.direction WHEN 'debit' THEN e.amount ELSE -e.amount END)`;

const CHECKS: { check: string; severity: 'error' | 'warning'; sql: string }[] = [
  { check: 'unbalanced_ledger_transaction', severity: 'error', sql: `
    SELECT lt.id AS ledger_tx_id, COALESCE(${NET},0)::bigint AS net, COUNT(e.id)::int AS entries
      FROM ledger_transactions lt LEFT JOIN ledger_entries e ON e.ledger_tx_id = lt.id
     GROUP BY lt.id HAVING COALESCE(${NET},0) <> 0 OR COUNT(e.id) < 2` },
  { check: 'account_balance_mismatch', severity: 'error', sql: `
    SELECT a.id AS account_id, a.type, a.balance, COALESCE(SUM(CASE e.direction WHEN 'credit' THEN e.amount ELSE -e.amount END),0)::bigint AS computed
      FROM accounts a LEFT JOIN ledger_entries e ON e.account_id = a.id
     GROUP BY a.id HAVING a.balance <> COALESCE(SUM(CASE e.direction WHEN 'credit' THEN e.amount ELSE -e.amount END),0)` },
  { check: 'global_balance_nonzero', severity: 'error', sql: `
    SELECT SUM(balance)::bigint AS total FROM accounts HAVING SUM(balance) <> 0` },
  { check: 'payment_ledger_mismatch', severity: 'error', sql: `
    SELECT p.id AS payment_id, p.status,
           COUNT(*) FILTER (WHERE lt.kind='payment')::int AS payment_txs, COUNT(*) FILTER (WHERE lt.kind='refund')::int AS refund_txs
      FROM payments p LEFT JOIN ledger_transactions lt ON lt.payment_id = p.id
     GROUP BY p.id, p.status
    HAVING COUNT(*) FILTER (WHERE lt.kind='payment') <> (CASE WHEN p.status IN ('succeeded','refunded') THEN 1 ELSE 0 END)
        OR COUNT(*) FILTER (WHERE lt.kind='refund')  <> (CASE WHEN p.status = 'refunded' THEN 1 ELSE 0 END)` },
  { check: 'ledger_amount_mismatch', severity: 'error', sql: `
    SELECT lt.id AS ledger_tx_id, p.id AS payment_id, p.amount,
           SUM(CASE WHEN e.direction='debit' THEN e.amount ELSE 0 END)::bigint AS debits
      FROM ledger_transactions lt JOIN payments p ON p.id = lt.payment_id JOIN ledger_entries e ON e.ledger_tx_id = lt.id
     GROUP BY lt.id, p.id, p.amount
    HAVING SUM(CASE WHEN e.direction='debit' THEN e.amount ELSE 0 END) <> p.amount` },
  { check: 'missing_outbox_event', severity: 'error', sql: `
    SELECT p.id AS payment_id, p.status, 'payment.' || p.status AS expected FROM payments p
     WHERE p.status IN ('succeeded','failed','refunded')
       AND NOT EXISTS (SELECT 1 FROM outbox_events o WHERE o.payment_id = p.id AND o.type = 'payment.' || p.status)
    UNION ALL
    SELECT p.id, p.status, 'payment.succeeded' FROM payments p
     WHERE p.status = 'refunded'
       AND NOT EXISTS (SELECT 1 FROM outbox_events o WHERE o.payment_id = p.id AND o.type = 'payment.succeeded')` },
  { check: 'stuck_payment', severity: 'error', sql: `
    SELECT id AS payment_id, status, created_at FROM payments
     WHERE status IN ('pending','processing') AND created_at < now() - make_interval(secs => $1)` },
  { check: 'dead_webhook_event', severity: 'warning', sql: `
    SELECT id AS event_id, payment_id, type, attempts, last_error FROM outbox_events WHERE status = 'dead'` },
];

export async function reconcile(pool: Pool, opts: { stuckAfterSec?: number } = {}): Promise<ReconciliationReport> {
  const discrepancies: Discrepancy[] = [];
  for (const c of CHECKS) {
    const params = c.sql.includes('$1') ? [opts.stuckAfterSec ?? 300] : [];
    const { rows } = await pool.query(c.sql, params);
    for (const r of rows) discrepancies.push({ check: c.check, severity: c.severity, detail: r });
  }
  return { ok: !discrepancies.some((d) => d.severity === 'error'), checkedAt: new Date().toISOString(), discrepancies };
}
