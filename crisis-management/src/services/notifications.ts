/** Notices for security administrators and auditors (console banner + optional SMS). */
import { config } from '../config.js';
import { one, pool, query } from '../db/pool.js';
import { apiIr } from '../integrations/apiir.js';
import { logger } from '../lib/logger.js';

export async function notifySecurity(kind: string, severity: 'info' | 'warning' | 'critical', message: string, details: Record<string, unknown> = {}) {
  // One open notice per kind: do not flood the console or the SMS channel.
  const open = await one('SELECT 1 FROM security_notifications WHERE kind = $1 AND acknowledged_at IS NULL', [kind]);
  if (open) return;
  await pool.query('INSERT INTO security_notifications (kind, severity, message, details) VALUES ($1,$2,$3,$4)', [kind, severity, message, details]);
  if (severity === 'info') return;
  // FAU_STG.3: also reach the people responsible over SMS (api.ir SendSms).
  const recipients = await query<{ mobile: string }>(
    `SELECT DISTINCT u.mobile FROM users u JOIN user_roles ur ON ur.user_id = u.id
      WHERE ur.role_key IN ('security_admin', 'security_auditor') AND u.status = 'active'`,
  );
  if (recipients.length === 0) return;
  const r = await apiIr.sendSms(recipients.map((x) => x.mobile), `سامانه مدیریت بحران — هشدار امنیتی: ${message}`);
  if (!r.ok) logger.warn({ kind, mode: config.APIIR_MODE }, 'security SMS not delivered');
}

export async function openNotifications() {
  return query(
    `SELECT id, at, kind, severity, message, details FROM security_notifications WHERE acknowledged_at IS NULL ORDER BY id DESC LIMIT 50`,
  );
}
