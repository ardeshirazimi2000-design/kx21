import { Router } from 'express';
import { z } from 'zod';
import { currentUser, type AuthUser } from '../auth/middleware.js';
import { one, query, tx } from '../db/pool.js';
import { audit } from '../lib/audit.js';
import { badRequest, conflict, forbidden, notFound } from '../lib/errors.js';
import { body, dateStr, paged, pageParams, param, uuid } from '../lib/validate.js';
import { commissionAccess } from '../services/access.js';
import { notify } from '../services/notifications.js';

export const resolutionsRouter = Router();

/** SQL fragment restricting resolutions to what the user may see. Uses params $1 = userId, $2 = isSuper, $3 = adminChambers. */
const VISIBLE = `($2::boolean OR r.chamber_id = ANY($3::uuid[]) OR r.owner_id = $1
  OR EXISTS (SELECT 1 FROM commission_memberships cm WHERE cm.commission_id = r.commission_id AND cm.user_id = $1
             AND cm.status = 'active' AND cm.position <> 'expert'))`;

async function loadResolution(u: AuthUser, id: string, db?: any, lock = false) {
  const r = await one(
    `SELECT r.* FROM resolutions r WHERE r.id = $4 AND ${VISIBLE}${lock ? ' FOR UPDATE OF r' : ''}`,
    [u.id, u.isSuperAdmin, u.adminChambers, id],
    db,
  );
  if (!r) throw notFound('مصوبه یافت نشد');
  const ca = await commissionAccess(u, r.commission_id, db).catch(() => null);
  return { r, canManage: !!ca?.can('resolution.manage'), isOwner: r.owner_id === u.id };
}

const createSchema = z.object({
  commissionId: uuid,
  meetingId: uuid.nullish(),
  agendaItemId: uuid.nullish(),
  voteSessionId: uuid.nullish(),
  text: z.string().min(5),
  ownerId: uuid.nullish(),
  addressee: z.string().nullish(),
  dueDate: dateStr.nullish(),
  priority: z.enum(['low', 'normal', 'high', 'urgent']).default('normal'),
  kpi: z.string().nullish(),
});

resolutionsRouter.post('/resolutions', async (req, res) => {
  const u = currentUser(req);
  const b = body(req, createSchema);
  const ca = await commissionAccess(u, b.commissionId);
  ca.require('resolution.manage');
  const row = await tx(async (c) => {
    await c.query('SELECT 1 FROM commissions WHERE id = $1 FOR UPDATE', [b.commissionId]);
    if (b.meetingId) {
      const m = await one('SELECT commission_id, status FROM meetings WHERE id = $1', [b.meetingId], c);
      if (!m || m.commission_id !== b.commissionId) throw badRequest('جلسه متعلق به این کمیسیون نیست');
      if (['draft', 'scheduled', 'invitation_sent', 'checkin_open', 'cancelled'].includes(m.status)) {
        throw conflict('مصوبه فقط از جلسه برگزارشده ایجاد می‌شود');
      }
    }
    if (b.agendaItemId) {
      const it = await one('SELECT meeting_id FROM agenda_items WHERE id = $1', [b.agendaItemId], c);
      if (!it || (b.meetingId && it.meeting_id !== b.meetingId)) throw badRequest('دستور جلسه نامعتبر است');
    }
    if (b.voteSessionId) {
      const vs = await one('SELECT status, result FROM vote_sessions WHERE id = $1', [b.voteSessionId], c);
      if (!vs || vs.status !== 'closed') throw badRequest('رأی‌گیری مربوطه بسته نشده است');
      if (!vs.result?.passed) throw conflict('این موضوع در رأی‌گیری تصویب نشده است', 'not_passed');
    }
    const { n } = (await one<{ n: number }>('SELECT count(*) + 1 AS n FROM resolutions WHERE commission_id = $1', [b.commissionId], c))!;
    const number = `${ca.commission.code}-${String(n).padStart(3, '0')}`;
    const r = await one(
      `INSERT INTO resolutions (chamber_id, commission_id, meeting_id, agenda_item_id, vote_session_id, number, text, owner_id, addressee,
          due_date, priority, kpi, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *`,
      [
        ca.commission.chamber_id, b.commissionId, b.meetingId ?? null, b.agendaItemId ?? null, b.voteSessionId ?? null, number, b.text,
        b.ownerId ?? null, b.addressee ?? null, b.dueDate ?? null, b.priority, b.kpi ?? null, u.id,
      ],
      c,
    );
    await c.query(
      `INSERT INTO tasks (chamber_id, resolution_id, title, assignee_id, due_date) VALUES ($1,$2,$3,$4,$5)`,
      [r.chamber_id, r.id, `اجرای مصوبه ${number}`, r.owner_id, r.due_date],
    );
    await audit(c, req, { chamberId: r.chamber_id, action: 'resolution.created', entity: 'resolution', entityId: r.id, after: r });
    return r;
  });
  if (row.owner_id) {
    await notify({
      chamberId: row.chamber_id,
      userIds: [row.owner_id],
      event: 'resolution.created',
      title: `مصوبه جدید ${row.number}`,
      body: row.text.slice(0, 200),
      data: { resolutionId: row.id },
    });
  }
  res.status(201).json(row);
});

resolutionsRouter.get('/resolutions', async (req, res) => {
  const u = currentUser(req);
  const { page, pageSize, offset, q } = pageParams(req);
  const commissionId = req.query.commissionId ? uuid.parse(req.query.commissionId) : null;
  const chamberId = req.query.chamberId ? uuid.parse(req.query.chamberId) : null;
  const meetingId = req.query.meetingId ? uuid.parse(req.query.meetingId) : null;
  const status = typeof req.query.status === 'string' ? req.query.status.split(',') : null;
  const mine = req.query.mine === 'true';
  const overdue = req.query.overdue === 'true';
  const where = `${VISIBLE} AND ($4::uuid IS NULL OR r.commission_id = $4) AND ($5::uuid IS NULL OR r.chamber_id = $5)
    AND ($6::uuid IS NULL OR r.meeting_id = $6) AND ($7::text[] IS NULL OR r.status = ANY($7))
    AND (NOT $8 OR r.owner_id = $1)
    AND (NOT $9 OR (r.due_date < current_date AND r.status NOT IN ('done','cancelled')))
    AND ($10::text IS NULL OR r.text ILIKE '%' || $10 || '%' OR r.number ILIKE '%' || $10 || '%' OR r.addressee ILIKE '%' || $10 || '%')`;
  const params = [u.id, u.isSuperAdmin, u.adminChambers, commissionId, chamberId, meetingId, status, mine, overdue, q];
  const items = await query(
    `SELECT r.*, c.name AS commission_name, o.full_name AS owner_name, m.number AS meeting_number,
            (r.due_date < current_date AND r.status NOT IN ('done','cancelled')) AS is_overdue
       FROM resolutions r JOIN commissions c ON c.id = r.commission_id LEFT JOIN users o ON o.id = r.owner_id
       LEFT JOIN meetings m ON m.id = r.meeting_id
      WHERE ${where} ORDER BY is_overdue DESC, r.due_date NULLS LAST, r.created_at DESC LIMIT ${pageSize} OFFSET ${offset}`,
    params,
  );
  const [{ count }] = await query(`SELECT count(*) FROM resolutions r WHERE ${where}`, params);
  res.json(paged(items, count, page, pageSize));
});

resolutionsRouter.get('/resolutions/:id', async (req, res) => {
  const u = currentUser(req);
  const { r, canManage, isOwner } = await loadResolution(u, param(req, 'id'));
  const [updates, tasks, documents, extra] = await Promise.all([
    query(
      `SELECT ru.*, u.full_name FROM resolution_updates ru JOIN users u ON u.id = ru.user_id WHERE ru.resolution_id = $1 ORDER BY ru.created_at DESC`,
      [r.id],
    ),
    query('SELECT t.*, u.full_name AS assignee_name FROM tasks t LEFT JOIN users u ON u.id = t.assignee_id WHERE t.resolution_id = $1', [r.id]),
    query('SELECT id, title, file_name, mime_type, size_bytes, created_at FROM documents WHERE resolution_id = $1 ORDER BY created_at', [r.id]),
    one(
      `SELECT c.name AS commission_name, o.full_name AS owner_name, m.title AS meeting_title, m.number AS meeting_number, ai.title AS agenda_title
         FROM resolutions r JOIN commissions c ON c.id = r.commission_id LEFT JOIN users o ON o.id = r.owner_id
         LEFT JOIN meetings m ON m.id = r.meeting_id LEFT JOIN agenda_items ai ON ai.id = r.agenda_item_id WHERE r.id = $1`,
      [r.id],
    ),
  ]);
  res.json({ ...r, ...extra, updates, tasks, documents, canManage, isOwner });
});

resolutionsRouter.patch('/resolutions/:id', async (req, res) => {
  const u = currentUser(req);
  const b = body(
    req,
    createSchema.pick({ text: true, ownerId: true, addressee: true, dueDate: true, priority: true, kpi: true }).partial().extend({
      status: z.literal('cancelled').optional(),
    }),
  );
  const { row, ownerChanged } = await tx(async (c) => {
    const { r, canManage } = await loadResolution(u, param(req, 'id'), c, true);
    if (!canManage) throw forbidden();
    if (r.status === 'done') throw conflict('مصوبه انجام‌شده قابل ویرایش نیست');
    const row = await one(
      `UPDATE resolutions SET text = COALESCE($2, text), owner_id = COALESCE($3, owner_id), addressee = COALESCE($4, addressee),
         due_date = COALESCE($5, due_date), priority = COALESCE($6, priority), kpi = COALESCE($7, kpi), status = COALESCE($8, status),
         overdue_notified_at = CASE WHEN $5::date IS NOT NULL THEN NULL ELSE overdue_notified_at END,
         due_soon_notified_at = CASE WHEN $5::date IS NOT NULL THEN NULL ELSE due_soon_notified_at END,
         updated_at = now() WHERE id = $1 RETURNING *`,
      [r.id, b.text, b.ownerId, b.addressee, b.dueDate, b.priority, b.kpi, b.status],
      c,
    );
    await c.query(
      `UPDATE tasks SET assignee_id = $2, due_date = $3, status = CASE WHEN $4 = 'cancelled' THEN 'cancelled' ELSE status END, updated_at = now()
        WHERE resolution_id = $1`,
      [r.id, row.owner_id, row.due_date, row.status],
    );
    await audit(c, req, { chamberId: r.chamber_id, action: 'resolution.updated', entity: 'resolution', entityId: r.id, before: r, after: row });
    return { row, ownerChanged: r.owner_id !== row.owner_id };
  });
  if (ownerChanged && row.owner_id) {
    await notify({
      chamberId: row.chamber_id,
      userIds: [row.owner_id],
      event: 'resolution.created',
      title: `مسئولیت اجرای مصوبه ${row.number}`,
      body: row.text.slice(0, 200),
      data: { resolutionId: row.id },
    });
  }
  res.json(row);
});

/** Owner reports progress (percentage, note, evidence document). submit=true sends it for secretary review. */
resolutionsRouter.patch('/resolutions/:id/progress', async (req, res) => {
  const u = currentUser(req);
  const b = body(
    req,
    z.object({ progress: z.number().int().min(0).max(100), note: z.string().nullish(), documentId: uuid.nullish(), submit: z.boolean().default(false) }),
  );
  const { row, officers } = await tx(async (c) => {
    const { r, canManage, isOwner } = await loadResolution(u, param(req, 'id'), c, true);
    if (!isOwner && !canManage) throw forbidden('فقط مسئول اجرا می‌تواند پیشرفت را ثبت کند');
    if (['done', 'cancelled'].includes(r.status)) throw conflict('این مصوبه بسته شده است');
    if (b.documentId) {
      const d = await one('SELECT resolution_id FROM documents WHERE id = $1', [b.documentId], c);
      if (!d || d.resolution_id !== r.id) throw badRequest('مستند متعلق به این مصوبه نیست');
    }
    const status = b.submit || b.progress === 100 ? 'submitted' : 'in_progress';
    const row = await one(`UPDATE resolutions SET progress = $2, status = $3, updated_at = now() WHERE id = $1 RETURNING *`, [r.id, b.progress, status], c);
    await c.query(`INSERT INTO resolution_updates (resolution_id, user_id, kind, progress, note, document_id) VALUES ($1,$2,'progress',$3,$4,$5)`, [
      r.id, u.id, b.progress, b.note ?? null, b.documentId ?? null,
    ]);
    await c.query(`UPDATE tasks SET status = 'in_progress', output = COALESCE($2, output), updated_at = now() WHERE resolution_id = $1`, [r.id, b.note ?? null]);
    await audit(c, req, { chamberId: r.chamber_id, action: 'resolution.progress', entity: 'resolution', entityId: r.id, before: { progress: r.progress, status: r.status }, after: { progress: b.progress, status } });
    const officers = status === 'submitted'
      ? await query<{ user_id: string }>(
          `SELECT user_id FROM commission_memberships WHERE commission_id = $1 AND status = 'active' AND position = 'secretary'`,
          [r.commission_id],
          c,
        )
      : [];
    return { row, officers: officers.map((o) => o.user_id) };
  });
  if (officers.length) {
    await notify({
      chamberId: row.chamber_id,
      userIds: officers,
      event: 'resolution.reviewed',
      title: `گزارش اجرای مصوبه ${row.number} برای بررسی ارسال شد`,
      body: `پیشرفت اعلام‌شده: ${row.progress}٪`,
      data: { resolutionId: row.id },
    });
  }
  res.json(row);
});

/** Secretary/chair accepts (done) or returns the reported result. */
resolutionsRouter.post('/resolutions/:id/review', async (req, res) => {
  const u = currentUser(req);
  const b = body(req, z.object({ approve: z.boolean(), note: z.string().nullish() }).refine((v) => v.approve || (v.note && v.note.length >= 3), 'برای برگشت، توضیح لازم است'));
  const row = await tx(async (c) => {
    const { r, canManage } = await loadResolution(u, param(req, 'id'), c, true);
    if (!canManage) throw forbidden();
    if (r.status !== 'submitted') throw conflict('مصوبه در انتظار بررسی نیست');
    const row = await one(
      `UPDATE resolutions SET status = $2, progress = CASE WHEN $2 = 'done' THEN 100 ELSE progress END, updated_at = now() WHERE id = $1 RETURNING *`,
      [r.id, b.approve ? 'done' : 'returned'],
      c,
    );
    await c.query(`UPDATE tasks SET status = $2, updated_at = now() WHERE resolution_id = $1`, [r.id, b.approve ? 'done' : 'in_progress']);
    await c.query(`INSERT INTO resolution_updates (resolution_id, user_id, kind, note) VALUES ($1,$2,$3,$4)`, [r.id, u.id, b.approve ? 'approve' : 'return', b.note ?? null]);
    await audit(c, req, { chamberId: r.chamber_id, action: b.approve ? 'resolution.approved' : 'resolution.returned', entity: 'resolution', entityId: r.id, before: r, after: row, reason: b.note });
    return row;
  });
  if (row.owner_id) {
    await notify({
      chamberId: row.chamber_id,
      userIds: [row.owner_id],
      event: 'resolution.reviewed',
      title: b.approve ? `مصوبه ${row.number} انجام‌شده تأیید شد` : `مصوبه ${row.number} برگشت داده شد`,
      body: b.note ?? '',
      data: { resolutionId: row.id },
    });
  }
  res.json(row);
});

// ─────────────────────────────── Tasks ───────────────────────────────

resolutionsRouter.get('/tasks', async (req, res) => {
  const u = currentUser(req);
  res.json(
    await query(
      `SELECT t.*, r.number AS resolution_number, r.text AS resolution_text FROM tasks t LEFT JOIN resolutions r ON r.id = t.resolution_id
        WHERE t.assignee_id = $1 AND t.status NOT IN ('done','cancelled') ORDER BY t.due_date NULLS LAST`,
      [u.id],
    ),
  );
});

// ─────────────────────────────── Issues (مسائل) ───────────────────────────────

resolutionsRouter.get('/commissions/:id/issues', async (req, res) => {
  const ca = await commissionAccess(currentUser(req), param(req, 'id'));
  if (ca.position === 'expert') throw forbidden();
  res.json(
    await query(
      `SELECT i.*, u.full_name AS created_by_name,
         (SELECT count(*) FROM referrals rf WHERE rf.issue_id = i.id) AS referral_count
         FROM issues i LEFT JOIN users u ON u.id = i.created_by WHERE i.commission_id = $1 ORDER BY i.created_at DESC`,
      [ca.commission.id],
    ),
  );
});

resolutionsRouter.post('/commissions/:id/issues', async (req, res) => {
  const u = currentUser(req);
  const ca = await commissionAccess(u, param(req, 'id'));
  // Any non-expert member may raise an issue; officers manage them.
  if (!ca.can('issue.manage') && !(ca.position && ['member', 'chair', 'vice_chair', 'secretary'].includes(ca.position))) throw forbidden();
  const b = body(req, z.object({ title: z.string().min(3), description: z.string().nullish() }));
  const row = await tx(async (c) => {
    const r = await one(
      `INSERT INTO issues (chamber_id, commission_id, title, description, created_by) VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [ca.commission.chamber_id, ca.commission.id, b.title, b.description ?? null, u.id],
      c,
    );
    await audit(c, req, { chamberId: r.chamber_id, action: 'issue.created', entity: 'issue', entityId: r.id, after: r });
    return r;
  });
  res.status(201).json(row);
});

resolutionsRouter.patch('/issues/:id', async (req, res) => {
  const u = currentUser(req);
  const id = param(req, 'id');
  const b = body(
    req,
    z.object({
      title: z.string().min(3).optional(),
      description: z.string().nullish(),
      status: z.enum(['open', 'under_review', 'on_agenda', 'resolved', 'closed']).optional(),
    }),
  );
  const row = await tx(async (c) => {
    const before = await one('SELECT * FROM issues WHERE id = $1 FOR UPDATE', [id], c);
    if (!before) throw notFound();
    (await commissionAccess(u, before.commission_id, c)).require('issue.manage');
    const r = await one(
      `UPDATE issues SET title = COALESCE($2, title), description = COALESCE($3, description), status = COALESCE($4, status), updated_at = now()
        WHERE id = $1 RETURNING *`,
      [id, b.title, b.description, b.status],
      c,
    );
    await audit(c, req, { chamberId: r.chamber_id, action: 'issue.updated', entity: 'issue', entityId: id, before, after: r });
    return r;
  });
  res.json(row);
});

// ─────────────────────────────── Expert referrals (کارشناسی) ───────────────────────────────

resolutionsRouter.post('/referrals', async (req, res) => {
  const u = currentUser(req);
  const b = body(
    req,
    z.object({ commissionId: uuid, issueId: uuid.nullish(), agendaItemId: uuid.nullish(), expertId: uuid, request: z.string().min(3), dueDate: dateStr.nullish() }),
  );
  const ca = await commissionAccess(u, b.commissionId);
  ca.require('issue.manage');
  const row = await tx(async (c) => {
    if (b.issueId) {
      const i = await one('SELECT commission_id FROM issues WHERE id = $1', [b.issueId], c);
      if (!i || i.commission_id !== b.commissionId) throw badRequest('موضوع متعلق به این کمیسیون نیست');
      await c.query(`UPDATE issues SET status = 'under_review', updated_at = now() WHERE id = $1`, [b.issueId]);
    }
    const r = await one(
      `INSERT INTO referrals (chamber_id, commission_id, issue_id, agenda_item_id, expert_id, request, due_date, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [ca.commission.chamber_id, b.commissionId, b.issueId ?? null, b.agendaItemId ?? null, b.expertId, b.request, b.dueDate ?? null, u.id],
      c,
    );
    await audit(c, req, { chamberId: r.chamber_id, action: 'referral.created', entity: 'referral', entityId: r.id, after: r });
    return r;
  });
  await notify({
    chamberId: row.chamber_id,
    userIds: [row.expert_id],
    event: 'referral.created',
    title: 'ارجاع کارشناسی جدید',
    body: row.request,
    data: { referralId: row.id },
  });
  res.status(201).json(row);
});

resolutionsRouter.get('/referrals', async (req, res) => {
  const u = currentUser(req);
  const commissionId = req.query.commissionId ? uuid.parse(req.query.commissionId) : null;
  if (commissionId) {
    const ca = await commissionAccess(u, commissionId);
    if (!ca.can('issue.manage')) throw forbidden();
  }
  res.json(
    await query(
      `SELECT rf.*, e.full_name AS expert_name, i.title AS issue_title, c.name AS commission_name
         FROM referrals rf JOIN users e ON e.id = rf.expert_id LEFT JOIN issues i ON i.id = rf.issue_id
         JOIN commissions c ON c.id = rf.commission_id
        WHERE ($1::uuid IS NOT NULL AND rf.commission_id = $1) OR ($1::uuid IS NULL AND rf.expert_id = $2)
        ORDER BY rf.status, rf.due_date NULLS LAST, rf.created_at DESC`,
      [commissionId, u.id],
    ),
  );
});

resolutionsRouter.post('/referrals/:id/answer', async (req, res) => {
  const u = currentUser(req);
  const b = body(req, z.object({ response: z.string().min(3) }));
  const row = await tx(async (c) => {
    const r = await one('SELECT * FROM referrals WHERE id = $1 FOR UPDATE', [param(req, 'id')], c);
    if (!r || r.expert_id !== u.id) throw notFound();
    if (r.status !== 'pending') throw conflict('به این ارجاع قبلاً پاسخ داده شده است');
    const row = await one(
      `UPDATE referrals SET response = $2, status = 'answered', answered_at = now() WHERE id = $1 RETURNING *`,
      [r.id, b.response],
      c,
    );
    await audit(c, req, { chamberId: r.chamber_id, action: 'referral.answered', entity: 'referral', entityId: r.id, after: row });
    return row;
  });
  if (row.created_by) {
    await notify({
      chamberId: row.chamber_id,
      userIds: [row.created_by],
      event: 'referral.answered',
      title: 'پاسخ کارشناسی دریافت شد',
      body: row.response.slice(0, 200),
      data: { referralId: row.id },
    });
  }
  res.json(row);
});
