import {
  availableCaseActions,
  CASE_ACTIONS,
  CASE_EVENT_LABELS,
  CASE_LEVEL_LABELS,
  CASE_STATUS_LABELS,
  CASE_TRANSITIONS,
  caseTransition,
  isArchivalOpen,
  isEditable,
  isLive,
  type CaseAction,
} from '@kx/shared';
import { Router } from 'express';
import { z } from 'zod';
import { currentUser } from '../auth/middleware.js';
import { one, query, tx } from '../db/pool.js';
import { audit } from '../lib/audit.js';
import { badRequest, conflict, forbidden, HttpError, notFound } from '../lib/errors.js';
import { body, dateStr, paged, pageParams, param, uuid } from '../lib/validate.js';
import { commissionAccess, meetingAccess } from '../services/access.js';
import {
  caseAccess,
  caseVisibility,
  councilBodies,
  councilContext,
  councilPeople,
  levelChamberId,
  nextCaseCode,
  notifyCase,
  originPeople,
  type CouncilCase,
} from '../services/council.js';

/** شورای گفت‌وگو: council cases and their way through expert and council meetings (services/council.ts). */
export const councilRouter = Router();

const PRIORITY = z.enum(['normal', 'high', 'urgent']);

// ─────────────────────────────── Overview and lists ───────────────────────────────

/** What the user does in the council: their chambers' bodies and roles, for the menu and the dashboard. */
councilRouter.get('/council/me', async (req, res) => {
  const u = currentUser(req);
  const ctx = await councilContext(u);
  const chambers = [...new Set([...ctx.member, ...ctx.president, ...u.adminChambers])];
  const bodies = chambers.length
    ? await query(
        `SELECT c.id, c.name, c.body_type, c.chamber_id, ch.name AS chamber_name, ch.kind AS chamber_kind, c.council_secretary_id,
                (SELECT full_name FROM users WHERE id = c.council_secretary_id) AS council_secretary_name
           FROM commissions c JOIN chambers ch ON ch.id = c.chamber_id
          WHERE c.chamber_id = ANY($1) AND c.body_type <> 'commission' AND c.status = 'active' ORDER BY ch.kind DESC, ch.name, c.body_type`,
        [chambers],
      )
    : [];
  const v = caseVisibility(u, ctx, 1);
  const [{ count }] = await query<{ count: string }>(`SELECT count(*) FROM council_cases c WHERE ${v.where}`, v.params);
  res.json({
    secretariat: ctx.secretariat,
    president: ctx.president,
    member: ctx.member,
    nationalChamberId: ctx.nationalChamber,
    bodies,
    visibleCases: Number(count),
    // Who can open a case from the chamber (the provincial secretariat).
    canOpen: ctx.secretariat.filter((id) => id !== ctx.nationalChamber),
  });
});

councilRouter.get('/council-cases', async (req, res) => {
  const u = currentUser(req);
  const ctx = await councilContext(u);
  const { page, pageSize, offset, q } = pageParams(req);
  const text = (k: string) => (typeof req.query[k] === 'string' && req.query[k] ? String(req.query[k]) : null);
  const status = text('status');
  const level = text('level');
  const chamberId = text('chamberId') ? uuid.parse(text('chamberId')) : null;
  const commissionId = text('commissionId') ? uuid.parse(text('commissionId')) : null;
  const overdue = req.query.overdue === 'true';
  const v = caseVisibility(u, ctx, 7);
  const where = `${v.where} AND ($1::text IS NULL OR c.title ILIKE '%' || $1 || '%' OR c.code ILIKE '%' || $1 || '%')
    AND ($2::text IS NULL OR c.status = ANY(string_to_array($2, ','))) AND ($3::text IS NULL OR c.level = $3)
    AND ($4::uuid IS NULL OR c.origin_chamber_id = $4) AND ($5::uuid IS NULL OR c.origin_commission_id = $5)
    AND (NOT $6::boolean OR (c.due_date < current_date AND c.status NOT IN ('resolved','closed')))`;
  const params = [q, status, level, chamberId, commissionId, overdue, ...v.params];
  const items = await query(
    `SELECT c.id, c.code, c.title, c.level, c.status, c.priority, c.confidential, c.due_date, c.created_at, c.updated_at,
            (c.due_date < current_date AND c.status NOT IN ('resolved','closed')) AS is_overdue,
            ch.name AS origin_chamber_name, ch.province AS origin_province, k.name AS origin_commission_name
       FROM council_cases c JOIN chambers ch ON ch.id = c.origin_chamber_id LEFT JOIN commissions k ON k.id = c.origin_commission_id
      WHERE ${where} ORDER BY (c.status IN ('resolved','closed')), c.due_date NULLS LAST, c.created_at DESC LIMIT ${pageSize} OFFSET ${offset}`,
    params,
  );
  const [{ count }] = await query<{ count: string }>(`SELECT count(*) FROM council_cases c WHERE ${where}`, params);
  res.json(paged(items, Number(count), page, pageSize));
});

councilRouter.get('/council-cases/:id', async (req, res) => {
  const u = currentUser(req);
  const a = await caseAccess(u, param(req, 'id'));
  const c = a.case;
  const [origin, events, agenda, docs] = await Promise.all([
    one(
      `SELECT ch.name AS chamber_name, ch.province, k.name AS commission_name, r.number AS resolution_number, r.text AS resolution_text, r.due_date AS resolution_due
         FROM chambers ch LEFT JOIN commissions k ON k.id = $2 LEFT JOIN resolutions r ON r.id = $3 WHERE ch.id = $1`,
      [c.origin_chamber_id, c.origin_commission_id, c.origin_resolution_id],
    ),
    query(
      `SELECT e.*, u.full_name AS actor_name, m.title AS meeting_title, r.number AS resolution_number, r.text AS resolution_text
         FROM council_case_events e LEFT JOIN users u ON u.id = e.actor_id LEFT JOIN meetings m ON m.id = e.meeting_id
         LEFT JOIN resolutions r ON r.id = e.resolution_id WHERE e.case_id = $1 ORDER BY e.id`,
      [c.id],
    ),
    query(
      `SELECT ai.id AS agenda_item_id, ai.status AS agenda_status, m.id AS meeting_id, m.title AS meeting_title, m.number, m.scheduled_at, m.status AS meeting_status,
              k.body_type, k.name AS body_name, ch.kind AS chamber_kind
         FROM agenda_items ai JOIN meetings m ON m.id = ai.meeting_id JOIN commissions k ON k.id = m.commission_id JOIN chambers ch ON ch.id = m.chamber_id
        WHERE ai.council_case_id = $1 ORDER BY m.scheduled_at`,
      [c.id],
    ),
    query(`SELECT id, kind, title, file_name, mime_type, size_bytes, created_at FROM documents WHERE council_case_id = $1 ORDER BY created_at`, [c.id]),
  ]);
  // Audited: opening a confidential case (AFTA, and the architecture's confidentiality rule).
  if (c.confidential) {
    await tx((db) => audit(db, req, { chamberId: c.origin_chamber_id, action: 'council.case_viewed', entity: 'council_case', entityId: c.id }));
  }
  const actions = availableCaseActions(c, a.actors).map((action) => {
    const t = caseTransition(action, c)!;
    return { action, label: t.label, needsResolution: t.needsResolution, needsMeeting: t.needsMeeting, needsReason: t.needsReason, needsOutcome: !!t.needsOutcome };
  });
  res.json({
    ...c,
    is_overdue: !!c.due_date && c.due_date < new Date().toISOString().slice(0, 10) && !['resolved', 'closed'].includes(c.status),
    origin,
    events: events.map((e: any) => ({ ...e, label: CASE_EVENT_LABELS[e.event] ?? e.event })),
    agenda,
    documents: docs,
    roles: a.actors,
    actions,
    canAddExpertMeeting: a.actors.includes('secretariat') && ['expert_review', 'on_agenda'].includes(c.status),
    labels: { status: CASE_STATUS_LABELS[c.status], level: CASE_LEVEL_LABELS[c.level] },
  });
});

/** Meetings and resolutions the secretariat may use for the next step of a case. */
councilRouter.get('/council-cases/:id/options', async (req, res) => {
  const u = currentUser(req);
  const a = await caseAccess(u, param(req, 'id'));
  if (!a.actors.includes('secretariat') && !a.actors.includes('president')) throw forbidden();
  const chamber = a.levelChamber;
  const meetings = chamber
    ? await query(
        `SELECT m.id, m.title, m.number, m.scheduled_at, m.status, k.body_type, k.name AS body_name
           FROM meetings m JOIN commissions k ON k.id = m.commission_id
          WHERE k.chamber_id = $1 AND k.body_type <> 'commission' AND k.status = 'active'
            AND (m.status IN ('draft','scheduled','invitation_sent','checkin_open','in_progress','agenda_processing') OR (m.archival AND m.status = 'minutes_draft'))
            AND NOT EXISTS (SELECT 1 FROM agenda_items ai WHERE ai.meeting_id = m.id AND ai.council_case_id = $2)
          ORDER BY m.scheduled_at`,
        [chamber, a.case.id],
      )
    : [];
  // Resolutions of meetings at the current level where the case was on the agenda.
  const resolutions = chamber
    ? await query(
        `SELECT r.id, r.number, r.text, r.due_date, k.body_type, m.title AS meeting_title
           FROM resolutions r JOIN agenda_items ai ON ai.id = r.agenda_item_id JOIN meetings m ON m.id = r.meeting_id JOIN commissions k ON k.id = r.commission_id
          WHERE ai.council_case_id = $1 AND k.chamber_id = $2 AND r.status <> 'cancelled' ORDER BY r.created_at DESC`,
        [a.case.id, chamber],
      )
    : [];
  res.json({ meetings, resolutions });
});

// ─────────────────────────────── Opening a case ───────────────────────────────

const openSchema = z
  .object({
    // From a commission resolution («ارجاع به شورای گفت‌وگو»), or by the chamber's council secretariat.
    resolutionId: uuid.optional(),
    chamberId: uuid.optional(),
    title: z.string().trim().min(5).max(300).optional(),
    description: z.string().trim().max(20_000).nullish(),
    dueDate: dateStr.nullish(),
    priority: PRIORITY.default('normal'),
    confidential: z.boolean().default(false),
  })
  .refine((v) => !!v.resolutionId !== !!v.chamberId, 'مصوبهٔ کمیسیون یا اتاق را مشخص کنید');

councilRouter.post('/council-cases', async (req, res) => {
  const u = currentUser(req);
  const b = body(req, openSchema);
  const row = await tx(async (c) => {
    let chamberId: string;
    let commissionId: string | null = null;
    let title = b.title;
    let dueDate = b.dueDate ?? null;
    if (b.resolutionId) {
      const r = await one('SELECT * FROM resolutions WHERE id = $1 FOR UPDATE', [b.resolutionId], c);
      if (!r) throw notFound('مصوبه یافت نشد');
      const ca = await commissionAccess(u, r.commission_id, c);
      ca.require('resolution.manage');
      if (ca.commission.body_type !== 'commission') throw badRequest('فقط مصوبهٔ کمیسیون به شورا ارجاع می‌شود');
      if (r.status === 'cancelled') throw conflict('این مصوبه لغو شده است');
      if (!r.due_date) throw new HttpError(400, 'resolution_due_required', 'مهلت مرحلهٔ بعد از مصوبه می‌آید؛ ابتدا برای مصوبه مهلت تعیین کنید');
      if (await one('SELECT 1 FROM council_cases WHERE origin_resolution_id = $1', [r.id], c)) throw conflict('این مصوبه قبلاً به شورا ارجاع شده است', 'already_referred');
      chamberId = r.chamber_id;
      commissionId = r.commission_id;
      title ??= r.text.length > 140 ? `${r.text.slice(0, 137)}…` : r.text;
      dueDate = r.due_date instanceof Date ? r.due_date.toISOString().slice(0, 10) : r.due_date;
    } else {
      chamberId = b.chamberId!;
      const ctx = await councilContext(u, c);
      if (!ctx.secretariat.includes(chamberId)) throw forbidden('ثبت پرونده از اتاق با دبیرخانهٔ شورای همان اتاق است');
      if (!title) throw badRequest('عنوان پرونده را بنویسید');
    }
    const chamber = await one<{ kind: string }>('SELECT kind FROM chambers WHERE id = $1', [chamberId], c);
    if (chamber?.kind !== 'provincial') throw badRequest('پرونده در اتاق استان شروع می‌شود');
    if (!(await councilBodies(chamberId, c)).council) throw conflict('شورای گفت‌وگوی این اتاق هنوز تعریف نشده است', 'no_council');
    const created = await one<CouncilCase>(
      `INSERT INTO council_cases (code, title, description, origin_chamber_id, origin_commission_id, origin_resolution_id, priority, confidential, due_date, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
      [await nextCaseCode(c), title, b.description ?? null, chamberId, commissionId, b.resolutionId ?? null, b.priority, b.confidential, dueDate, u.id],
      c,
    );
    await c.query(
      `INSERT INTO council_case_events (case_id, event, to_level, to_status, actor_id, resolution_id) VALUES ($1,'opened','provincial','expert_review',$2,$3)`,
      [created!.id, u.id, b.resolutionId ?? null],
    );
    await audit(c, req, { chamberId, action: 'council.case_opened', entity: 'council_case', entityId: created!.id, after: { code: created!.code, title, commissionId, resolutionId: b.resolutionId ?? null } });
    return created!;
  });
  await notifyCase(row, 'council.case_opened', `پروندهٔ تازهٔ شورا: ${row.code}`, row.title, await councilPeople(row.origin_chamber_id, { president: true }));
  res.status(201).json(row);
});

// ─────────────────────────────── Expert meetings and the case's way ───────────────────────────────

async function addToAgenda(c: any, req: any, caseRow: CouncilCase, meetingId: string, bodyTypes: string[], levelChamber: string) {
  const a = await meetingAccess(currentUser(req), meetingId, c, { forUpdate: true });
  a.require('meeting.manage');
  if (a.commission.chamber_id !== levelChamber || !bodyTypes.includes(a.commission.body_type)) {
    throw badRequest(bodyTypes.includes('council') ? 'جلسه باید جلسهٔ شورای همین سطح باشد' : 'جلسه باید جلسهٔ کارشناسی همین سطح باشد');
  }
  // A meeting held before the system was used can be recorded with the case on its agenda (ثبت از سوابق).
  if (!isEditable(a.meeting.status) && !isLive(a.meeting.status) && !isArchivalOpen(a.meeting)) throw conflict('افزودن دستور جلسه در این وضعیت جلسه ممکن نیست');
  if (await one('SELECT 1 FROM agenda_items WHERE meeting_id = $1 AND council_case_id = $2', [meetingId, caseRow.id], c)) {
    throw conflict('این پرونده در دستور همین جلسه هست');
  }
  const item = await one(
    `INSERT INTO agenda_items (chamber_id, meeting_id, order_no, title, description, priority, council_case_id)
     VALUES ($1,$2,(SELECT COALESCE(max(order_no),0)+1 FROM agenda_items WHERE meeting_id = $2),$3,$4,$5,$6) RETURNING *`,
    [a.meeting.chamber_id, meetingId, `پروندهٔ ${caseRow.code}: ${caseRow.title}`, caseRow.description, caseRow.priority === 'normal' ? 'normal' : caseRow.priority, caseRow.id],
    c,
  );
  await audit(c, req, { chamberId: a.meeting.chamber_id, action: 'agenda.created', entity: 'agenda_item', entityId: item.id, after: { councilCaseId: caseRow.id, meetingId } });
  return a.meeting;
}

/** Puts the case on an expert meeting's agenda (the experts are invited to that meeting, per case). */
councilRouter.post('/council-cases/:id/expert-meeting', async (req, res) => {
  const u = currentUser(req);
  const b = body(req, z.object({ meetingId: uuid }));
  await tx(async (c) => {
    const a = await caseAccess(u, param(req, 'id'), c, true);
    if (!a.actors.includes('secretariat')) throw forbidden('این کار با دبیرخانهٔ شورای همین سطح است');
    if (!['expert_review', 'on_agenda'].includes(a.case.status)) throw conflict('پرونده در مرحلهٔ بررسی نیست');
    const m = await addToAgenda(c, req, a.case, b.meetingId, ['expert_group'], a.levelChamber!);
    await c.query(
      `INSERT INTO council_case_events (case_id, event, from_level, from_status, to_level, to_status, actor_id, meeting_id) VALUES ($1,'expert_meeting',$2,$3,$2,$3,$4,$5)`,
      [a.case.id, a.case.level, a.case.status, u.id, m.id],
    );
    await c.query('UPDATE council_cases SET updated_at = now() WHERE id = $1', [a.case.id]);
  });
  res.status(201).json({ ok: true });
});

const actionSchema = z.object({
  action: z.enum(CASE_ACTIONS),
  meetingId: uuid.optional(),
  resolutionId: uuid.optional(),
  reason: z.string().trim().max(2000).optional(),
  outcome: z.string().trim().max(20_000).optional(),
});

councilRouter.post('/council-cases/:id/actions', async (req, res) => {
  const u = currentUser(req);
  const b = body(req, actionSchema);
  const result = await tx(async (c) => {
    const a = await caseAccess(u, param(req, 'id'), c, true);
    const cs = a.case;
    const t = caseTransition(b.action as CaseAction, cs);
    if (!t) throw conflict(`«${CASE_TRANSITIONS.find((x) => x.action === b.action)?.label}» در وضعیت «${CASE_STATUS_LABELS[cs.status]}» ممکن نیست`, 'invalid_transition');
    if (!a.actors.includes(t.actor)) {
      throw forbidden(
        t.actor === 'president'
          ? 'این تصمیم را دبیر شورای همین سطح (رئیس اتاق) خودش ثبت می‌کند'
          : t.actor === 'origin'
            ? 'این کار با دبیر کمیسیون مبدأ یا دبیرخانهٔ شورای استان است'
            : 'این کار با دبیرخانهٔ شورای همین سطح است',
      );
    }
    if (t.needsReason && (b.reason ?? '').length < 5) throw badRequest('دلیل را بنویسید (دست‌کم ۵ نویسه)');
    if (t.needsOutcome && (b.outcome ?? '').length < 5) throw badRequest('نتیجهٔ نهایی پرونده را برای ابلاغ به مبدأ بنویسید');

    let meetingId: string | null = null;
    let resolution: { id: string; due_date: any; meeting_id: string } | null = null;
    if (t.needsMeeting) {
      if (!b.meetingId) throw badRequest('جلسهٔ شورا را انتخاب کنید');
      meetingId = (await addToAgenda(c, req, cs, b.meetingId, ['council'], a.levelChamber!)).id;
    }
    if (t.needsResolution) {
      if (!b.resolutionId) throw badRequest('مصوبهٔ جلسه‌ای را که این تصمیم را گرفته انتخاب کنید');
      resolution = await one(
        `SELECT r.id, r.due_date, r.meeting_id, k.body_type, k.chamber_id FROM resolutions r JOIN agenda_items ai ON ai.id = r.agenda_item_id
           JOIN commissions k ON k.id = r.commission_id WHERE r.id = $1 AND ai.council_case_id = $2 AND r.status <> 'cancelled'`,
        [b.resolutionId, cs.id],
        c,
      );
      const r = resolution as any;
      if (!r || r.chamber_id !== a.levelChamber) throw badRequest('مصوبه باید از جلسه‌ای در همین سطح باشد که پرونده در دستور آن بوده است');
      if (t.needsResolution === 'council' && r.body_type !== 'council') throw badRequest('این تصمیم با مصوبهٔ جلسهٔ شورا گرفته می‌شود');
      if (t.action !== 'resolve' && !r.due_date) throw new HttpError(400, 'resolution_due_required', 'مهلت مرحلهٔ بعد از مصوبه می‌آید؛ برای مصوبه مهلت تعیین کنید');
      meetingId = r.meeting_id;
    }

    const next = t.next;
    const due = resolution?.due_date ?? null;
    const updated = await one<CouncilCase>(
      `UPDATE council_cases SET level = $2, status = $3, updated_at = now(),
          due_date = CASE WHEN $4::date IS NOT NULL THEN $4::date ELSE due_date END,
          due_soon_notified_at = CASE WHEN $4::date IS NOT NULL THEN NULL ELSE due_soon_notified_at END,
          overdue_notified_at = CASE WHEN $4::date IS NOT NULL THEN NULL ELSE overdue_notified_at END,
          national_reached_at = CASE WHEN $2 = 'national' THEN COALESCE(national_reached_at, now()) ELSE national_reached_at END,
          provincial_agenda_at = CASE WHEN $5 AND level = 'provincial' THEN COALESCE(provincial_agenda_at, now()) ELSE provincial_agenda_at END,
          national_agenda_at = CASE WHEN $5 AND level = 'national' THEN COALESCE(national_agenda_at, now()) ELSE national_agenda_at END,
          outcome = COALESCE($6, outcome),
          closed_at = CASE WHEN $3 = 'closed' THEN now() END
        WHERE id = $1 RETURNING *`,
      [cs.id, next.level, next.status, due, b.action === 'schedule', t.needsOutcome ? b.outcome : null],
      c,
    );
    await c.query(
      `INSERT INTO council_case_events (case_id, event, from_level, from_status, to_level, to_status, actor_id, reason, meeting_id, resolution_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [cs.id, b.action, cs.level, cs.status, next.level, next.status, u.id, b.reason ?? (t.needsOutcome ? b.outcome : null) ?? null, meetingId, resolution?.id ?? null],
    );
    await audit(c, req, {
      chamberId: cs.origin_chamber_id,
      action: `council.${b.action}`,
      entity: 'council_case',
      entityId: cs.id,
      before: { level: cs.level, status: cs.status },
      after: { level: next.level, status: next.status, resolutionId: resolution?.id ?? null, meetingId },
      reason: b.reason ?? null,
    });
    return { before: cs, after: updated!, label: t.label };
  });

  // Who hears about it: the new level's secretariat (and the council secretary when their approval is needed),
  // the originating commission, and the provincial secretariat when the case comes back to the province.
  const { before, after, label } = result;
  const chamberNow = await levelChamberId(after);
  const recipients = new Set<string>([...(await councilPeople(chamberNow)), ...(await originPeople(after.origin_commission_id))]);
  if (before.level !== after.level) for (const id of await councilPeople(await levelChamberId(before))) recipients.add(id);
  recipients.delete(u.id);
  const text = `${label} — وضعیت: ${CASE_STATUS_LABELS[after.status]} (${CASE_LEVEL_LABELS[after.level]})${b.reason ? `؛ ${b.reason}` : ''}`;
  await notifyCase(after, 'council.case_updated', `پروندهٔ ${after.code}: ${CASE_STATUS_LABELS[after.status]}`, text, [...recipients]);
  if (after.status === 'pending_approval') {
    const president = (await councilBodies(after.origin_chamber_id)).council?.council_secretary_id;
    if (president) {
      await notifyCase(after, 'council.approval_needed', `تأیید ارجاع پروندهٔ ${after.code} به شورای ملی`, after.title, [president]);
    }
  }
  res.json(after);
});

/** Deadlines of open cases: soon and overdue reminders to the secretariat of the case's level (run by the scheduler). */
export async function remindCouncilDeadlines(): Promise<void> {
  const soon = await query<CouncilCase>(
    `UPDATE council_cases SET due_soon_notified_at = now()
      WHERE status IN ('expert_review','on_agenda','pending_approval','returned') AND due_soon_notified_at IS NULL
        AND due_date >= current_date AND due_date <= current_date + 3 RETURNING *`,
  );
  const late = await query<CouncilCase>(
    `UPDATE council_cases SET overdue_notified_at = now()
      WHERE status IN ('expert_review','on_agenda','pending_approval','returned') AND overdue_notified_at IS NULL AND due_date < current_date RETURNING *`,
  );
  for (const [list, word] of [
    [soon, 'نزدیک است'],
    [late, 'گذشته است'],
  ] as const) {
    for (const cs of list) {
      const to = cs.status === 'returned' ? await originPeople(cs.origin_commission_id) : await councilPeople(await levelChamberId(cs));
      await notifyCase(cs, 'council.case_due', `مهلت پروندهٔ ${cs.code} ${word}`, `${cs.title} — ${CASE_STATUS_LABELS[cs.status]}`, to);
    }
  }
}
