/**
 * Security audit trail (PP: FAU_GEN.1/2, FAU_SEL.1, FAU_STG.1–4, FCS_COP.1(1)).
 * Every record is chained to the previous one with HMAC-SHA256 so that any modification or removal
 * (outside a recorded archive) is detected by verifyAuditChain().
 */
import { appendFileSync } from 'node:fs';
import type { Request } from 'express';
import { config } from '../config.js';
import { one, pool, query, type Db } from '../db/pool.js';
import { getSettings } from '../security/settings.js';
import { hmac } from './crypto.js';
import { logger } from './logger.js';

export type Severity = 'info' | 'low' | 'medium' | 'high' | 'critical';

export interface AuditEntry {
  action: string;
  actorId?: string | null;
  targetType?: string;
  targetId?: string | null;
  outcome?: 'success' | 'failure' | 'denied';
  details?: Record<string, unknown>;
  ip?: string | null;
  channel?: string | null;
  userAgent?: string | null;
  severity?: Severity;
}

/**
 * Events that may be switched off by the auditor (FAU_SEL.1). Everything else — authentication, access control,
 * user/role/settings management, sessions, integrity and audit events — is always recorded.
 */
export const SELECTABLE_EVENTS = [
  'incident.view', 'incident.create', 'incident.update', 'task.assign', 'task.status', 'alert.publish',
] as const;

const SEVERITY_RULES: [RegExp, Severity][] = [
  [/^(integrity\.violation|audit\.(chain_broken|full|stop|archive)|session\.refresh_reuse|session\.hijack_suspected)/, 'critical'],
  [/^(account\.locked|shahkar\.mismatch|access\.denied|settings\.|role\.|user\.(roles|status|password_reset)|audit\.(config|export)|system\.error)/, 'high'],
  [/^(user\.|session\.|password\.|data\.export|incident\.(declare|closed)|alert\.publish)/, 'medium'],
  [/\.(login|signup|logout)|^(console|app)\./, 'low'],
];

export function severityOf(action: string, outcome: string): Severity {
  for (const [re, sev] of SEVERITY_RULES) if (re.test(action)) return outcome !== 'success' && sev === 'low' ? 'medium' : sev;
  return 'info';
}

/** Canonical form covered by the record's HMAC. */
export function canonical(r: {
  id: number | string; at: string | Date; actor_id: string | null; actor_name: string | null; action: string; target_type: string | null;
  target_id: string | null; outcome: string; severity: string; ip: string | null; channel: string | null; user_agent: string | null; details: unknown;
}): string {
  return JSON.stringify([
    String(r.id), new Date(r.at).toISOString(), r.actor_id, r.actor_name, r.action, r.target_type, r.target_id,
    r.outcome, r.severity, r.ip, r.channel, r.user_agent, sortKeys(r.details ?? {}),
  ]);
}

/** jsonb does not preserve key order, so the signed form sorts keys recursively. */
function sortKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === 'object' && !(v instanceof Date)) {
    return Object.fromEntries(Object.keys(v as object).sort().map((k) => [k, sortKeys((v as Record<string, unknown>)[k])]));
  }
  return v;
}

export function chainHash(prevHash: string | null, canon: string): string {
  return hmac(`${prevHash ?? 'GENESIS'}|${canon}`, config.AUDIT_KEY);
}

let rowsSinceCheck = 0;

export async function audit(e: AuditEntry, db: Db = pool): Promise<void> {
  const outcome = e.outcome ?? 'success';
  try {
    if ((SELECTABLE_EVENTS as readonly string[]).includes(e.action)) {
      const s = await getSettings();
      if (s['audit.disabledEvents'].includes(e.action)) return;
    }
    const actorName = e.actorId
      ? ((await one<{ name: string }>(`SELECT COALESCE(username, first_name || ' ' || last_name) AS name FROM users WHERE id = $1`, [e.actorId], db))?.name ?? null)
      : null;
    // Serialise writers so the chain is linear; the lock is released when the surrounding transaction ends.
    const client = 'release' in db ? db : await pool.connect();
    const own = client !== db;
    try {
      if (own) await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock(727274)');
      const prev = await one<{ hash: string | null }>('SELECT hash FROM audit_log ORDER BY id DESC LIMIT 1', [], client);
      const lastArchive = prev ? null : await one<{ last_hash: string }>('SELECT last_hash FROM audit_archives ORDER BY id DESC LIMIT 1', [], client);
      const prevHash = prev?.hash ?? lastArchive?.last_hash ?? null;
      const row = {
        id: (await one<{ id: string }>(`SELECT nextval('audit_log_id_seq') AS id`, [], client))!.id,
        at: new Date().toISOString(),
        actor_id: e.actorId ?? null,
        actor_name: actorName,
        action: e.action,
        target_type: e.targetType ?? null,
        target_id: e.targetId ?? null,
        outcome,
        severity: e.severity ?? severityOf(e.action, outcome),
        ip: e.ip ?? null,
        channel: e.channel ?? null,
        user_agent: e.userAgent?.slice(0, 300) ?? null,
        details: JSON.parse(JSON.stringify(e.details ?? {})) as Record<string, unknown>,
      };
      await client.query(
        `INSERT INTO audit_log (id, at, actor_id, actor_name, action, target_type, target_id, outcome, severity, ip, channel, user_agent, details, prev_hash, hash)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
        [row.id, row.at, row.actor_id, row.actor_name, row.action, row.target_type, row.target_id, row.outcome, row.severity, row.ip, row.channel,
          row.user_agent, row.details, prevHash, chainHash(prevHash, canonical(row))],
      );
      if (own) await client.query('COMMIT');
    } catch (err) {
      if (own) await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      if (own) (client as { release: () => void }).release();
    }
    if (++rowsSinceCheck >= 200) {
      rowsSinceCheck = 0;
      void import('../services/auditStorage.js').then((m) => m.checkAuditCapacity()).catch(() => undefined);
    }
  } catch (err) {
    // FRU_FLT.1: keep a local record when the audit store is unavailable; the operation itself still fails (FPT_FLS.1).
    writeFallback(e, err);
    throw err;
  }
}

function writeFallback(e: AuditEntry, err: unknown) {
  logger.error({ err, action: e.action }, 'audit write failed');
  if (!config.AUDIT_FALLBACK_FILE) return;
  try {
    appendFileSync(config.AUDIT_FALLBACK_FILE, `${JSON.stringify({ at: new Date().toISOString(), ...e, error: String(err) })}\n`, { mode: 0o600 });
  } catch (fileErr) {
    logger.error({ err: fileErr }, 'audit fallback write failed');
  }
}

/** Audit helper bound to the current request (actor, IP, channel, user agent). */
export function auditReq(req: Request, e: Omit<AuditEntry, 'ip' | 'channel' | 'actorId' | 'userAgent'> & { actorId?: string | null }, db?: Db) {
  return audit(
    { ...e, actorId: e.actorId === undefined ? (req.user?.id ?? null) : e.actorId, ip: req.ip ?? null, channel: req.user?.channel ?? null, userAgent: req.get('user-agent') ?? null },
    db,
  );
}

export interface ChainVerification {
  ok: boolean;
  checked: number;
  firstBrokenId: string | null;
}

/** Recomputes the HMAC chain over the whole trail (FAU_STG.1.2, FDP_SDI.2.1). */
export async function verifyAuditChain(): Promise<ChainVerification> {
  const archive = await one<{ last_hash: string; last_id: string }>('SELECT last_hash, last_id FROM audit_archives ORDER BY id DESC LIMIT 1');
  let prevHash: string | null = archive?.last_hash ?? null;
  let lastId = archive ? Number(archive.last_id) : 0;
  let checked = 0;
  const batch = 2000;
  for (;;) {
    const rows = await query<{
      id: string; at: Date; actor_id: string | null; actor_name: string | null; action: string; target_type: string | null; target_id: string | null;
      outcome: string; severity: string; ip: string | null; channel: string | null; user_agent: string | null; details: unknown; prev_hash: string | null; hash: string | null;
    }>(`SELECT * FROM audit_log WHERE id > $1 ORDER BY id LIMIT $2`, [lastId, batch]);
    if (rows.length === 0) break;
    for (const r of rows) {
      checked++;
      if (r.prev_hash !== prevHash || r.hash !== chainHash(prevHash, canonical(r))) return { ok: false, checked, firstBrokenId: r.id };
      prevHash = r.hash;
      lastId = Number(r.id);
    }
  }
  return { ok: true, checked, firstBrokenId: null };
}
