import type { Request } from 'express';
import { one, query, type Db } from '../db/pool.js';
import { audit } from '../lib/audit.js';
import { conflict } from '../lib/errors.js';
import { notify } from './notifications.js';

export interface ProgressInput {
  progress: number;
  note?: string | null;
  documentId?: string | null;
  submit?: boolean;
  /** Person reporting; null when an integrated system reports. */
  userId: string | null;
  source?: 'user' | 'integration';
  integrationClientId?: string | null;
  externalRef?: string | null;
}

/**
 * Records execution progress of a resolution (row must be locked by the caller).
 * Progress 100 or submit=true sends the result to the commission secretary for review.
 */
export async function recordProgress(c: Db, req: Request | null, r: any, p: ProgressInput) {
  if (['done', 'cancelled'].includes(r.status)) throw conflict('این مصوبه بسته شده است');
  const status = p.submit || p.progress === 100 ? 'submitted' : 'in_progress';
  const row = await one(`UPDATE resolutions SET progress = $2, status = $3, updated_at = now() WHERE id = $1 RETURNING *`, [r.id, p.progress, status], c);
  await c.query(
    `INSERT INTO resolution_updates (resolution_id, user_id, kind, progress, note, document_id, source, integration_client_id, external_ref)
     VALUES ($1,$2,'progress',$3,$4,$5,$6,$7,$8)`,
    [r.id, p.userId, p.progress, p.note ?? null, p.documentId ?? null, p.source ?? 'user', p.integrationClientId ?? null, p.externalRef ?? null],
  );
  await c.query(`UPDATE tasks SET status = 'in_progress', output = COALESCE($2, output), updated_at = now() WHERE resolution_id = $1`, [r.id, p.note ?? null]);
  await audit(c, req, {
    chamberId: r.chamber_id,
    action: 'resolution.progress',
    entity: 'resolution',
    entityId: r.id,
    before: { progress: r.progress, status: r.status },
    after: { progress: p.progress, status, source: p.source ?? 'user' },
  });
  const officers =
    status === 'submitted'
      ? await query<{ user_id: string }>(
          `SELECT user_id FROM commission_memberships WHERE commission_id = $1 AND status = 'active' AND position = 'secretary'`,
          [r.commission_id],
          c,
        )
      : [];
  return { row, officers: officers.map((o) => o.user_id) };
}

export async function notifySubmitted(row: any, officers: string[]) {
  if (!officers.length) return;
  await notify({
    chamberId: row.chamber_id,
    userIds: officers,
    event: 'resolution.reviewed',
    title: `گزارش اجرای مصوبه ${row.number} برای بررسی ارسال شد`,
    body: `پیشرفت اعلام‌شده: ${row.progress}٪`,
    data: { resolutionId: row.id },
  });
}
