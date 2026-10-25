import type { Request } from 'express';
import { one, query, type Db } from '../db/pool.js';
import { audit } from '../lib/audit.js';
import { badRequest, conflict } from '../lib/errors.js';

/**
 * Executive bodies (دستگاه‌های اجرایی) of a resolution: one lead and partners. Each reports its own progress;
 * the resolution's progress is their average and it goes for review once all of them are done.
 */

export interface ExecutorInput {
  name: string;
  role?: 'lead' | 'partner';
}

/** «سازمان  صمت » → «سازمان صمت»: one spelling per body in the chamber's list. */
export const normalizeOrgName = (s: string) => s.replace(/\s+/g, ' ').replace(/ي/g, 'ی').replace(/ك/g, 'ک').trim();

export async function loadExecutors(resolutionId: string, db?: Db) {
  return query<{ id: string; organization_id: string; name: string; role: 'lead' | 'partner'; progress: number; status: string; last_report_at: string | null }>(
    `SELECT e.id, e.organization_id, o.name, e.role, e.progress, e.status, e.last_report_at
       FROM resolution_executors e JOIN organizations o ON o.id = e.organization_id
      WHERE e.resolution_id = $1 ORDER BY e.role = 'lead' DESC, e.order_no, o.name`,
    [resolutionId],
    db,
  );
}

/**
 * Replaces the bodies of a resolution with the given list (by name; new names join the chamber's list). Bodies
 * kept from before keep their progress. The first lead, or else the first body, is the lead.
 */
export async function setExecutors(c: Db, r: { id: string; chamber_id: string }, list: ExecutorInput[]) {
  const seen = new Set<string>();
  const items = list
    .map((e) => ({ name: normalizeOrgName(e.name), role: e.role ?? 'partner' }))
    .filter((e) => e.name.length >= 2 && !seen.has(e.name) && seen.add(e.name));
  if (items.length > 12) throw badRequest('حداکثر ۱۲ دستگاه اجرایی برای هر مصوبه');
  const leadAt = Math.max(0, items.findIndex((e) => e.role === 'lead'));
  const keep: string[] = [];
  // Roles change in two steps so the one-lead rule holds throughout.
  await c.query(`UPDATE resolution_executors SET role = 'partner' WHERE resolution_id = $1`, [r.id]);
  for (const [i, e] of items.entries()) {
    const org = (await one<{ id: string }>(
      `INSERT INTO organizations (chamber_id, name) VALUES ($1, $2) ON CONFLICT (chamber_id, name) DO UPDATE SET name = EXCLUDED.name RETURNING id`,
      [r.chamber_id, e.name],
      c,
    ))!;
    const row = (await one<{ id: string }>(
      `INSERT INTO resolution_executors (resolution_id, organization_id, role, order_no) VALUES ($1, $2, 'partner', $3)
       ON CONFLICT (resolution_id, organization_id) DO UPDATE SET order_no = EXCLUDED.order_no RETURNING id`,
      [r.id, org.id, i],
      c,
    ))!;
    keep.push(row.id);
  }
  await c.query(`DELETE FROM resolution_executors WHERE resolution_id = $1 AND NOT (id = ANY($2::uuid[]))`, [r.id, keep]);
  if (keep.length) await c.query(`UPDATE resolution_executors SET role = 'lead' WHERE id = $1`, [keep[leadAt]]);
  const executors = await loadExecutors(r.id, c);
  await c.query(`UPDATE resolutions SET addressee = $2 WHERE id = $1`, [r.id, executors.map((e) => e.name).join('، ') || null]);
  return executors;
}

export interface ExecutorProgressInput {
  progress: number;
  note?: string | null;
  documentId?: string | null;
  userId: string;
}

/**
 * Records one body's progress report (resolution row locked by the caller). The resolution's progress becomes the
 * bodies' average; once every body is at 100% it is sent to the secretary for review.
 */
export async function recordExecutorProgress(c: Db, req: Request, r: any, executorId: string, p: ExecutorProgressInput) {
  if (['done', 'cancelled'].includes(r.status)) throw conflict('این مصوبه بسته شده است');
  const ex = await one('SELECT * FROM resolution_executors WHERE id = $1 AND resolution_id = $2 FOR UPDATE', [executorId, r.id], c);
  if (!ex) throw badRequest('این دستگاه از مجریان این مصوبه نیست');
  const status = p.progress >= 100 ? 'done' : p.progress > 0 ? 'in_progress' : 'open';
  await c.query(`UPDATE resolution_executors SET progress = $2, status = $3, last_report_at = now() WHERE id = $1`, [ex.id, p.progress, status]);
  await c.query(
    `INSERT INTO resolution_updates (resolution_id, user_id, kind, progress, note, document_id, executor_id) VALUES ($1,$2,'progress',$3,$4,$5,$6)`,
    [r.id, p.userId, p.progress, p.note ?? null, p.documentId ?? null, ex.id],
  );
  const all = await query<{ progress: number }>('SELECT progress FROM resolution_executors WHERE resolution_id = $1', [r.id], c);
  const overall = Math.round(all.reduce((s, e) => s + e.progress, 0) / all.length);
  const allDone = all.every((e) => e.progress >= 100);
  // A resolution recorded from the archive is not reviewed; it just follows its bodies.
  const next = r.archival ? (allDone ? 'done' : overall > 0 ? 'in_progress' : 'open') : allDone ? 'submitted' : 'in_progress';
  const row = await one(`UPDATE resolutions SET progress = $2, status = $3, updated_at = now() WHERE id = $1 RETURNING *`, [r.id, overall, next], c);
  await c.query(`UPDATE tasks SET status = $2, output = COALESCE($3, output), updated_at = now() WHERE resolution_id = $1`, [
    r.id,
    next === 'done' ? 'done' : 'in_progress',
    p.note ?? null,
  ]);
  await audit(c, req, {
    chamberId: r.chamber_id,
    action: 'resolution.progress',
    entity: 'resolution',
    entityId: r.id,
    before: { progress: r.progress, status: r.status, executor: ex.id, executorProgress: ex.progress },
    after: { progress: overall, status: next, executor: ex.id, executorProgress: p.progress },
  });
  const officers =
    next === 'submitted'
      ? await query<{ user_id: string }>(`SELECT user_id FROM commission_memberships WHERE commission_id = $1 AND status = 'active' AND position = 'secretary'`, [r.commission_id], c)
      : [];
  return { row, officers: officers.map((o) => o.user_id) };
}
