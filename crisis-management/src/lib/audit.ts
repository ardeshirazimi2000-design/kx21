import type { Request } from 'express';
import { pool, type Db } from '../db/pool.js';
import { logger } from './logger.js';

export interface AuditEntry {
  action: string;
  actorId?: string | null;
  targetType?: string;
  targetId?: string | null;
  outcome?: 'success' | 'failure' | 'denied';
  details?: Record<string, unknown>;
  ip?: string | null;
  channel?: string | null;
}

export async function audit(e: AuditEntry, db: Db = pool): Promise<void> {
  try {
    await db.query(
      `INSERT INTO audit_log (actor_id, action, target_type, target_id, outcome, ip, channel, details)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [e.actorId ?? null, e.action, e.targetType ?? null, e.targetId ?? null, e.outcome ?? 'success', e.ip ?? null, e.channel ?? null, e.details ?? {}],
    );
  } catch (err) {
    // An audit failure must never be silent.
    logger.error({ err, action: e.action }, 'audit write failed');
    throw err;
  }
}

/** Audit helper bound to the current request (actor, IP, channel). */
export function auditReq(req: Request, e: Omit<AuditEntry, 'ip' | 'channel' | 'actorId'> & { actorId?: string | null }, db?: Db) {
  return audit({ ...e, actorId: e.actorId === undefined ? (req.user?.id ?? null) : e.actorId, ip: req.ip ?? null, channel: req.user?.channel ?? null }, db);
}
