import crypto from 'node:crypto';
import type { Request } from 'express';
import { one, pool, query, type Db } from '../db/pool.js';
import { canonical } from './crypto.js';

const normalize = (v: unknown) => (v === undefined ? null : JSON.parse(JSON.stringify(v)));

export interface AuditEntry {
  action: string;
  entity: string;
  entityId?: string | null;
  before?: unknown;
  after?: unknown;
  reason?: string | null;
  /** Actor when there is no HTTP request (jobs, integration events). */
  userId?: string | null;
}

/**
 * Appends a tamper-evident audit record (hash = sha256(prev_hash + payload)); the table rejects UPDATE/DELETE.
 * Call inside the transaction of the audited change.
 */
export async function audit(db: Db, req: Request | null, e: AuditEntry): Promise<void> {
  await db.query(`SELECT pg_advisory_xact_lock(hashtext('audit'))`);
  const prev = await one<{ hash: string }>('SELECT hash FROM audit_logs ORDER BY id DESC LIMIT 1', [], db);
  const createdAt = new Date().toISOString();
  const userId = req?.user?.id ?? e.userId ?? null;
  const before = normalize(e.before);
  const after = normalize(e.after);
  const payload = canonical({ userId, action: e.action, entity: e.entity, entityId: e.entityId ?? null, before, after, reason: e.reason ?? null, createdAt });
  const hash = crypto.createHash('sha256').update((prev?.hash ?? '') + payload).digest('hex');
  await query(
    `INSERT INTO audit_logs (user_id, action, entity, entity_id, before, after, reason, ip, user_agent, created_at, prev_hash, hash)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
    [
      userId, e.action, e.entity, e.entityId ?? null,
      before === null ? null : JSON.stringify(before), after === null ? null : JSON.stringify(after),
      e.reason ?? null, req?.ip ?? null, req?.headers['user-agent']?.slice(0, 300) ?? null, createdAt, prev?.hash ?? null, hash,
    ],
    db,
  );
}

/** Recomputes the chain; returns the id of the first broken record or null when intact. */
export async function verifyAuditChain(): Promise<{ brokenAt: number | null; count: number }> {
  const rows = await query(`SELECT * FROM audit_logs ORDER BY id`, [], pool);
  let prev: string | null = null;
  for (const r of rows) {
    const payload = canonical({
      userId: r.user_id, action: r.action, entity: r.entity, entityId: r.entity_id, before: r.before, after: r.after, reason: r.reason,
      createdAt: new Date(r.created_at).toISOString(),
    });
    const hash = crypto.createHash('sha256').update((prev ?? '') + payload).digest('hex');
    if (r.prev_hash !== prev || r.hash !== hash) return { brokenAt: Number(r.id), count: rows.length };
    prev = r.hash;
  }
  return { brokenAt: null, count: rows.length };
}
