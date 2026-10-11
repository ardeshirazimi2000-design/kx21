/** Integrity of stored records (FDP_SDI.2) with HMAC-SHA256 seals (FCS_COP.1(1)). */
import { config } from '../config.js';
import { one, pool, query, type Db } from '../db/pool.js';
import { audit, verifyAuditChain } from '../lib/audit.js';
import { hmac } from '../lib/crypto.js';
import { logger } from '../lib/logger.js';
import { getSettings } from '../security/settings.js';
import { notifySecurity } from './notifications.js';

const SEALED = `id, title, type, severity, status, description, district_id, address, lat, lng, source, reported_by, declared_by, declared_at, closed_by, closed_at, created_at`;

function incidentMac(r: Record<string, unknown>): string {
  const fields = SEALED.split(', ').map((k) => {
    const v = r[k];
    return v instanceof Date ? v.toISOString() : (v ?? null);
  });
  return hmac(JSON.stringify(fields), config.INTEGRITY_KEY);
}

/** Recomputes the seal after an authorised change. Call inside the same transaction as the change. */
export async function sealIncident(id: string, db: Db = pool): Promise<void> {
  const r = await one<Record<string, unknown>>(`SELECT ${SEALED} FROM incidents WHERE id = $1`, [id], db);
  if (r) await db.query('UPDATE incidents SET integrity_mac = $2, integrity_ok = true WHERE id = $1', [id, incidentMac(r)]);
}

export interface IntegrityReport {
  incidents: { checked: number; violations: string[] };
  audit: { ok: boolean; checked: number; firstBrokenId: string | null };
}

/** Full check; on a violation: mark the record, notify, and audit (FDP_SDI.2.2). */
export async function runIntegrityCheck(actorId: string | null = null): Promise<IntegrityReport> {
  const rows = await query<Record<string, unknown> & { id: string; integrity_mac: string | null; integrity_ok: boolean }>(
    `SELECT ${SEALED}, integrity_mac, integrity_ok FROM incidents`,
  );
  const violations: string[] = [];
  for (const r of rows) {
    if (r.integrity_mac !== incidentMac(r)) {
      violations.push(r.id);
      if (r.integrity_ok) await pool.query('UPDATE incidents SET integrity_ok = false WHERE id = $1', [r.id]);
    }
  }
  const chain = await verifyAuditChain();
  const report: IntegrityReport = { incidents: { checked: rows.length, violations }, audit: chain };
  const ok = violations.length === 0 && chain.ok;
  await audit({ action: ok ? 'integrity.check' : 'integrity.violation', actorId, outcome: ok ? 'success' : 'failure', details: { incidents: rows.length, violations: violations.slice(0, 20), auditOk: chain.ok, firstBrokenId: chain.firstBrokenId } });
  if (violations.length) await notifySecurity('integrity.incidents', 'critical', `تغییر غیرمجاز در ${violations.length} رکورد حادثه تشخیص داده شد`, { ids: violations.slice(0, 20) });
  if (!chain.ok) await notifySecurity('integrity.audit', 'critical', `زنجیره صحت رکوردهای ممیزی از رکورد ${chain.firstBrokenId} شکسته است`, { firstBrokenId: chain.firstBrokenId });
  return report;
}

let timer: NodeJS.Timeout | null = null;

export function startIntegrityMonitor(): void {
  const tick = async () => {
    try {
      await runIntegrityCheck();
    } catch (err) {
      logger.error({ err }, 'integrity check failed');
    }
    const minutes = (await getSettings().catch(() => null))?.['integrity.checkMinutes'] ?? 60;
    timer = setTimeout(tick, minutes * 60_000);
    timer.unref();
  };
  timer = setTimeout(tick, 60_000);
  timer.unref();
}
