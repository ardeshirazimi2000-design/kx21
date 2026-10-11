/** Audit trail capacity (FAU_STG.3 warning, FAU_STG.4 action when full). */
import { one } from '../db/pool.js';
import { audit } from '../lib/audit.js';
import { getSettings } from '../security/settings.js';
import { notifySecurity } from './notifications.js';

let full = false;

/** True while the trail is over capacity and the configured action is "block". */
export function auditBlocked(): boolean {
  return full;
}

export async function checkAuditCapacity(): Promise<{ rows: number; warn: boolean; full: boolean }> {
  const s = await getSettings();
  const rows = Number((await one<{ n: string }>('SELECT count(*) AS n FROM audit_log'))!.n);
  const warn = rows >= s['audit.warnRows'];
  const wasFull = full;
  full = rows >= s['audit.maxRows'] && s['audit.fullAction'] === 'block';
  if (warn) {
    await notifySecurity('audit.capacity', rows >= s['audit.maxRows'] ? 'critical' : 'warning',
      `حجم رکوردهای ممیزی به ${rows.toLocaleString('fa-IR')} از ظرفیت ${s['audit.maxRows'].toLocaleString('fa-IR')} رسیده است؛ خروجی و بایگانی لازم است`, { rows });
  }
  if (full && !wasFull) await audit({ action: 'audit.full', outcome: 'failure', details: { rows, max: s['audit.maxRows'] } });
  return { rows, warn, full };
}
