import crypto from 'node:crypto';
import type { Request } from 'express';
import { one, pool, query, type Db } from '../db/pool.js';

/** JSON with recursively sorted keys, so the hash survives jsonb's key reordering. */
function canonical(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v ?? null);
  if (v instanceof Date) return JSON.stringify(v.toISOString());
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o)
    .filter((k) => o[k] !== undefined)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`)
    .join(',')}}`;
}

/** Normalise values the way they will look after a jsonb round-trip. */
const normalize = (v: unknown) => (v === undefined ? null : JSON.parse(JSON.stringify(v)));

export interface AuditEntry {
  chamberId: string | null;
  action: string;
  entity: string;
  entityId?: string | null;
  before?: unknown;
  after?: unknown;
  reason?: string | null;
}

/**
 * Append a tamper-evident audit record. Records are hash-chained per chamber
 * (hash = sha256(prev_hash + payload)), and the table rejects UPDATE/DELETE via trigger.
 * Call inside the same transaction as the change being audited.
 */
export async function audit(db: Db, req: Request | null, e: AuditEntry): Promise<void> {
  const chainKey = e.chamberId ?? 'global';
  await db.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`audit:${chainKey}`]);
  const prev = await one<{ hash: string }>(
    'SELECT hash FROM audit_logs WHERE chamber_id IS NOT DISTINCT FROM $1 ORDER BY id DESC LIMIT 1',
    [e.chamberId],
    db,
  );
  const createdAt = new Date().toISOString();
  const before = normalize(e.before);
  const after = normalize(e.after);
  const payload = canonical({
    chamberId: e.chamberId,
    userId: req?.user?.id ?? null,
    action: e.action,
    entity: e.entity,
    entityId: e.entityId ?? null,
    before,
    after,
    reason: e.reason ?? null,
    createdAt,
  });
  const hash = crypto.createHash('sha256').update((prev?.hash ?? '') + payload).digest('hex');
  await query(
    `INSERT INTO audit_logs (chamber_id, user_id, action, entity, entity_id, before, after, reason, ip, user_agent, created_at, prev_hash, hash)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
    [
      e.chamberId,
      req?.user?.id ?? null,
      e.action,
      e.entity,
      e.entityId ?? null,
      before === null ? null : JSON.stringify(before),
      after === null ? null : JSON.stringify(after),
      e.reason ?? null,
      req?.ip ?? null,
      req?.headers['user-agent']?.slice(0, 300) ?? null,
      createdAt,
      prev?.hash ?? null,
      hash,
    ],
    db,
  );
}

/** Recompute the hash chain of a chamber; returns the id of the first broken record, or null if intact. */
export async function verifyAuditChain(chamberId: string | null): Promise<number | null> {
  const rows = await query(
    `SELECT id, chamber_id, user_id, action, entity, entity_id, before, after, reason, created_at, prev_hash, hash
       FROM audit_logs WHERE chamber_id IS NOT DISTINCT FROM $1 ORDER BY id`,
    [chamberId],
    pool,
  );
  let prev: string | null = null;
  for (const r of rows) {
    const payload = canonical({
      chamberId: r.chamber_id,
      userId: r.user_id,
      action: r.action,
      entity: r.entity,
      entityId: r.entity_id,
      before: r.before,
      after: r.after,
      reason: r.reason,
      createdAt: new Date(r.created_at).toISOString(),
    });
    const hash = crypto.createHash('sha256').update((prev ?? '') + payload).digest('hex');
    if (r.prev_hash !== prev || r.hash !== hash) return Number(r.id);
    prev = r.hash;
  }
  return null;
}
