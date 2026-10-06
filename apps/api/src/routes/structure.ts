import bcrypt from 'bcryptjs';
import { DEFAULT_COMMISSION_SETTINGS, POSITIONS, positionHasVote, type Position } from '@kx/shared';
import { Router } from 'express';
import { z } from 'zod';
import { currentUser, type AuthUser } from '../auth/middleware.js';
import { one, query, tx } from '../db/pool.js';
import { audit } from '../lib/audit.js';
import { badRequest, conflict, forbidden, notFound } from '../lib/errors.js';
import { body, dateStr, paged, pageParams, param, uuid } from '../lib/validate.js';
import { commissionAccess, isChamberAdmin, requireChamberAdmin, requireSuperAdmin, visibleChamberIds } from '../services/access.js';

export const structureRouter = Router();

// ─────────────────────────────── Chambers ───────────────────────────────

const chamberSchema = z.object({
  name: z.string().min(2),
  province: z.string().min(2),
  logoUrl: z.string().url().nullish(),
  phone: z.string().nullish(),
  email: z.string().email().nullish(),
  address: z.string().nullish(),
  settings: z.record(z.string(), z.unknown()).optional(),
});

structureRouter.get('/chambers', async (req, res) => {
  const ids = await visibleChamberIds(currentUser(req));
  const rows = await query(
    `SELECT * FROM chambers WHERE ($1::uuid[] IS NULL OR id = ANY($1)) ORDER BY name`,
    [ids],
  );
  res.json(rows);
});

structureRouter.post('/chambers', async (req, res) => {
  const u = currentUser(req);
  requireSuperAdmin(u);
  const b = body(req, chamberSchema);
  const row = await tx(async (c) => {
    const r = await one(
      `INSERT INTO chambers (name, province, logo_url, phone, email, address, settings)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [b.name, b.province, b.logoUrl ?? null, b.phone ?? null, b.email ?? null, b.address ?? null, JSON.stringify(b.settings ?? {})],
      c,
    );
    await audit(c, req, { chamberId: r.id, action: 'chamber.created', entity: 'chamber', entityId: r.id, after: r });
    return r;
  });
  res.status(201).json(row);
});

structureRouter.get('/chambers/:id', async (req, res) => {
  const id = param(req, 'id');
  const ids = await visibleChamberIds(currentUser(req));
  if (ids && !ids.includes(id)) throw notFound();
  const row = await one('SELECT * FROM chambers WHERE id = $1', [id]);
  if (!row) throw notFound();
  res.json(row);
});

structureRouter.patch('/chambers/:id', async (req, res) => {
  const id = param(req, 'id');
  requireChamberAdmin(currentUser(req), id);
  const b = body(req, chamberSchema.partial());
  const row = await tx(async (c) => {
    const before = await one('SELECT * FROM chambers WHERE id = $1 FOR UPDATE', [id], c);
    if (!before) throw notFound();
    const after = await one(
      `UPDATE chambers SET name = COALESCE($2, name), province = COALESCE($3, province), logo_url = COALESCE($4, logo_url),
         phone = COALESCE($5, phone), email = COALESCE($6, email), address = COALESCE($7, address),
         settings = COALESCE($8, settings), updated_at = now() WHERE id = $1 RETURNING *`,
      [id, b.name, b.province, b.logoUrl, b.phone, b.email, b.address, b.settings ? JSON.stringify(b.settings) : null],
      c,
    );
    await audit(c, req, { chamberId: id, action: 'chamber.updated', entity: 'chamber', entityId: id, before, after });
    return after;
  });
  res.json(row);
});

structureRouter.post('/chambers/:id/admins', async (req, res) => {
  const id = param(req, 'id');
  requireSuperAdmin(currentUser(req));
  const b = body(req, z.object({ userId: uuid }));
  await tx(async (c) => {
    await c.query('INSERT INTO chamber_admins (chamber_id, user_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [id, b.userId]);
    await audit(c, req, { chamberId: id, action: 'chamber.admin_added', entity: 'user', entityId: b.userId });
  });
  res.status(204).end();
});

// ─────────────────────────────── Terms (دوره‌ها) ───────────────────────────────

structureRouter.get('/terms', async (req, res) => {
  const chamberId = uuid.parse(req.query.chamberId);
  const ids = await visibleChamberIds(currentUser(req));
  if (ids && !ids.includes(chamberId)) throw notFound();
  res.json(await query('SELECT * FROM terms WHERE chamber_id = $1 ORDER BY number DESC', [chamberId]));
});

const termSchema = z.object({
  chamberId: uuid,
  number: z.number().int().positive(),
  title: z.string().min(2),
  startDate: dateStr,
  endDate: dateStr.nullish(),
  status: z.enum(['planned', 'active', 'closed']).default('planned'),
});

/** Activating a term closes the previous active term and ends memberships of its commissions (history is kept). */
async function closeActiveTerm(c: Parameters<Parameters<typeof tx>[0]>[0], req: any, chamberId: string, exceptId?: string) {
  const active = await query<{ id: string }>(
    `SELECT id FROM terms WHERE chamber_id = $1 AND status = 'active' AND ($2::uuid IS NULL OR id <> $2) FOR UPDATE`,
    [chamberId, exceptId ?? null],
    c,
  );
  for (const t of active) {
    await c.query(`UPDATE terms SET status = 'closed', end_date = COALESCE(end_date, current_date) WHERE id = $1`, [t.id]);
    const ended = await c.query(
      `UPDATE commission_memberships SET status = 'ended', end_date = COALESCE(end_date, current_date), note = COALESCE(note, 'پایان دوره')
        WHERE status = 'active' AND commission_id IN (SELECT id FROM commissions WHERE term_id = $1)`,
      [t.id],
    );
    await audit(c, req, { chamberId, action: 'term.closed', entity: 'term', entityId: t.id, after: { endedMemberships: ended.rowCount } });
  }
}

structureRouter.post('/terms', async (req, res) => {
  const b = body(req, termSchema);
  requireChamberAdmin(currentUser(req), b.chamberId);
  const row = await tx(async (c) => {
    if (b.status === 'active') await closeActiveTerm(c, req, b.chamberId);
    const r = await one(
      `INSERT INTO terms (chamber_id, number, title, start_date, end_date, status) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [b.chamberId, b.number, b.title, b.startDate, b.endDate ?? null, b.status],
      c,
    );
    await audit(c, req, { chamberId: b.chamberId, action: 'term.created', entity: 'term', entityId: r.id, after: r });
    return r;
  }).catch((e) => {
    if (e.code === '23505') throw conflict('دوره‌ای با این شماره قبلاً ثبت شده است');
    throw e;
  });
  res.status(201).json(row);
});

structureRouter.patch('/terms/:id', async (req, res) => {
  const id = param(req, 'id');
  const b = body(req, termSchema.omit({ chamberId: true }).partial());
  const row = await tx(async (c) => {
    const before = await one('SELECT * FROM terms WHERE id = $1 FOR UPDATE', [id], c);
    if (!before) throw notFound();
    requireChamberAdmin(currentUser(req), before.chamber_id);
    if (b.status === 'active' && before.status !== 'active') await closeActiveTerm(c, req, before.chamber_id, id);
    const after = await one(
      `UPDATE terms SET number = COALESCE($2, number), title = COALESCE($3, title), start_date = COALESCE($4, start_date),
         end_date = COALESCE($5, end_date), status = COALESCE($6, status) WHERE id = $1 RETURNING *`,
      [id, b.number, b.title, b.startDate, b.endDate, b.status],
      c,
    );
    await audit(c, req, { chamberId: before.chamber_id, action: 'term.updated', entity: 'term', entityId: id, before, after });
    return after;
  });
  res.json(row);
});

// ─────────────────────────────── Commissions ───────────────────────────────

const settingsSchema = z
  .object({
    quorum: z
      .object({
        type: z.enum(['majority', 'percent', 'fixed', 'two_thirds']),
        value: z.number().positive().optional(),
        countProxy: z.boolean(),
        countOnline: z.boolean(),
      })
      .partial(),
    requireQuorumForVoting: z.boolean(),
    requireQuorumToStart: z.boolean(),
    allowProxy: z.boolean(),
    secretVoteDefault: z.boolean(),
    resultVisibility: z.enum(['invitees', 'officers']),
    passRule: z.enum(['majority_of_present', 'majority_of_cast', 'simple_majority', 'two_thirds_of_present']),
    allowParallelAgenda: z.boolean(),
    allowComments: z.boolean(),
    dueSoonDays: z.number().int().min(0).max(60),
  })
  .partial();

const commissionSchema = z.object({
  chamberId: uuid,
  termId: uuid,
  name: z.string().min(2),
  code: z.string().min(1).max(30),
  domain: z.string().nullish(),
  description: z.string().nullish(),
  status: z.enum(['active', 'inactive', 'dissolved']).default('active'),
  settings: settingsSchema.optional(),
});

structureRouter.get('/commissions', async (req, res) => {
  const u = currentUser(req);
  const { page, pageSize, offset, q } = pageParams(req);
  const chamberId = req.query.chamberId ? uuid.parse(req.query.chamberId) : null;
  const termId = req.query.termId ? uuid.parse(req.query.termId) : null;
  const where = `($1::uuid IS NULL OR c.chamber_id = $1) AND ($2::uuid IS NULL OR c.term_id = $2)
    AND ($3::text IS NULL OR c.name ILIKE '%' || $3 || '%' OR c.code ILIKE '%' || $3 || '%' OR c.domain ILIKE '%' || $3 || '%')
    AND ($4::boolean OR c.chamber_id = ANY($5::uuid[])
         OR EXISTS (SELECT 1 FROM commission_memberships m WHERE m.commission_id = c.id AND m.user_id = $6 AND m.status = 'active'))`;
  const params = [chamberId, termId, q, u.isSuperAdmin, u.adminChambers, u.id];
  const items = await query(
    `SELECT c.*, t.title AS term_title, t.number AS term_number,
       (SELECT count(*) FROM commission_memberships m WHERE m.commission_id = c.id AND m.status = 'active') AS member_count,
       (SELECT u.full_name FROM commission_memberships m JOIN users u ON u.id = m.user_id
          WHERE m.commission_id = c.id AND m.status = 'active' AND m.position = 'chair') AS chair_name,
       (SELECT u.full_name FROM commission_memberships m JOIN users u ON u.id = m.user_id
          WHERE m.commission_id = c.id AND m.status = 'active' AND m.position = 'secretary') AS secretary_name,
       (SELECT m.position FROM commission_memberships m WHERE m.commission_id = c.id AND m.user_id = $6 AND m.status = 'active') AS my_position
     FROM commissions c JOIN terms t ON t.id = c.term_id WHERE ${where}
     ORDER BY c.name LIMIT ${pageSize} OFFSET ${offset}`,
    params,
  );
  const [{ count }] = await query(`SELECT count(*) FROM commissions c WHERE ${where}`, params);
  res.json(paged(items, count, page, pageSize));
});

structureRouter.post('/commissions', async (req, res) => {
  const b = body(req, commissionSchema);
  requireChamberAdmin(currentUser(req), b.chamberId);
  const term = await one('SELECT chamber_id FROM terms WHERE id = $1', [b.termId]);
  if (!term || term.chamber_id !== b.chamberId) throw badRequest('دوره متعلق به این اتاق نیست');
  const settings = { ...DEFAULT_COMMISSION_SETTINGS, ...(b.settings ?? {}), quorum: { ...DEFAULT_COMMISSION_SETTINGS.quorum, ...(b.settings?.quorum ?? {}) } };
  const row = await tx(async (c) => {
    const r = await one(
      `INSERT INTO commissions (chamber_id, term_id, name, code, domain, description, status, settings)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [b.chamberId, b.termId, b.name, b.code, b.domain ?? null, b.description ?? null, b.status, JSON.stringify(settings)],
      c,
    );
    await audit(c, req, { chamberId: b.chamberId, action: 'commission.created', entity: 'commission', entityId: r.id, after: r });
    return r;
  }).catch((e) => {
    if (e.code === '23505') throw conflict('کد کمیسیون در این دوره تکراری است');
    throw e;
  });
  res.status(201).json(row);
});

structureRouter.get('/commissions/:id', async (req, res) => {
  const a = await commissionAccess(currentUser(req), param(req, 'id'));
  const term = await one('SELECT id, number, title, status FROM terms WHERE id = $1', [a.commission.term_id]);
  const officers = await query(
    `SELECT m.position, u.id AS user_id, u.full_name FROM commission_memberships m JOIN users u ON u.id = m.user_id
      WHERE m.commission_id = $1 AND m.status = 'active' AND m.position IN ('chair','vice_chair','secretary')`,
    [a.commission.id],
  );
  res.json({ ...a.commission, settings: a.settings, term, officers, myPosition: a.position, capabilities: [...a.caps] });
});

structureRouter.patch('/commissions/:id', async (req, res) => {
  const id = param(req, 'id');
  const b = body(req, commissionSchema.omit({ chamberId: true, termId: true }).partial());
  const row = await tx(async (c) => {
    const before = await one('SELECT * FROM commissions WHERE id = $1 FOR UPDATE', [id], c);
    if (!before) throw notFound();
    requireChamberAdmin(currentUser(req), before.chamber_id);
    let settings = null;
    if (b.settings) {
      const cur = { ...DEFAULT_COMMISSION_SETTINGS, ...before.settings };
      settings = JSON.stringify({ ...cur, ...b.settings, quorum: { ...cur.quorum, ...(b.settings.quorum ?? {}) } });
    }
    const after = await one(
      `UPDATE commissions SET name = COALESCE($2, name), code = COALESCE($3, code), domain = COALESCE($4, domain),
         description = COALESCE($5, description), status = COALESCE($6, status), settings = COALESCE($7, settings), updated_at = now()
       WHERE id = $1 RETURNING *`,
      [id, b.name, b.code, b.domain, b.description, b.status, settings],
      c,
    );
    await audit(c, req, { chamberId: before.chamber_id, action: 'commission.updated', entity: 'commission', entityId: id, before, after });
    return after;
  });
  res.json(row);
});

// ─────────────────────────────── Memberships (اعضا و سمت‌ها) ───────────────────────────────

structureRouter.get('/commissions/:id/members', async (req, res) => {
  const a = await commissionAccess(currentUser(req), param(req, 'id'));
  const includeEnded = req.query.includeEnded === 'true';
  const rows = await query(
    `SELECT m.*, u.full_name, u.organization, u.job_title, u.mobile, u.email
       FROM commission_memberships m JOIN users u ON u.id = m.user_id
      WHERE m.commission_id = $1 AND ($2 OR m.status = 'active')
      ORDER BY m.status, array_position(ARRAY['chair','vice_chair','secretary','member','expert','observer'], m.position), u.full_name`,
    [a.commission.id, includeEnded],
  );
  const canSeeContacts = a.can('meeting.manage') || a.can('commission.manage');
  res.json(canSeeContacts ? rows : rows.map(({ mobile: _m, email: _e, ...r }) => r));
});

const personSchema = z.object({
  fullName: z.string().min(2),
  nationalId: z.string().regex(/^\d{10}$/, 'کد ملی باید ۱۰ رقم باشد').nullish(),
  mobile: z.string().regex(/^09\d{9}$/, 'شماره موبایل معتبر نیست').nullish(),
  email: z.string().email().nullish(),
  organization: z.string().nullish(),
  jobTitle: z.string().nullish(),
  bio: z.string().nullish(),
  password: z.string().min(8).nullish(),
});

async function createPerson(c: any, req: any, chamberId: string, p: z.infer<typeof personSchema>) {
  const hash = p.password ? await bcrypt.hash(p.password, 10) : null;
  try {
    const r = await one(
      `INSERT INTO users (chamber_id, full_name, national_id, mobile, email, organization, job_title, bio, password_hash)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       RETURNING id, chamber_id, full_name, national_id, mobile, email, organization, job_title, bio, is_active, created_at`,
      [chamberId, p.fullName, p.nationalId ?? null, p.mobile ?? null, p.email ?? null, p.organization ?? null, p.jobTitle ?? null, p.bio ?? null, hash],
      c,
    );
    await audit(c, req, { chamberId, action: 'person.created', entity: 'user', entityId: r.id, after: r });
    return r;
  } catch (e: any) {
    if (e.code === '23505') throw conflict('شخصی با این ایمیل یا شماره موبایل قبلاً ثبت شده است');
    throw e;
  }
}

structureRouter.post('/commissions/:id/members', async (req, res) => {
  const u = currentUser(req);
  const commissionId = param(req, 'id');
  const b = body(
    req,
    z
      .object({
        userId: uuid.optional(),
        person: personSchema.optional(),
        position: z.enum(POSITIONS),
        hasVote: z.boolean().optional(),
        startDate: dateStr.optional(),
        endDate: dateStr.nullish(),
        replaceExisting: z.boolean().default(false),
      })
      .refine((v) => v.userId || v.person, 'شناسه فرد یا مشخصات فرد جدید لازم است'),
  );
  const row = await tx(async (c) => {
    const commission = await one('SELECT * FROM commissions WHERE id = $1 FOR UPDATE', [commissionId], c);
    if (!commission) throw notFound('کمیسیون یافت نشد');
    requireChamberAdmin(u, commission.chamber_id);
    const userId = b.userId ?? (await createPerson(c, req, commission.chamber_id, b.person!)).id;
    const existing = await one(
      `SELECT * FROM commission_memberships WHERE commission_id = $1 AND user_id = $2 AND status = 'active'`,
      [commissionId, userId],
      c,
    );
    if (existing) throw conflict('این فرد در حال حاضر عضو فعال کمیسیون است؛ برای تغییر سمت از ویرایش عضویت استفاده کنید');
    if (['chair', 'vice_chair', 'secretary'].includes(b.position)) {
      const holder = await one(
        `SELECT * FROM commission_memberships WHERE commission_id = $1 AND position = $2 AND status = 'active'`,
        [commissionId, b.position],
        c,
      );
      if (holder && !b.replaceExisting) throw conflict('این سمت در حال حاضر متصدی دارد', 'position_taken');
      if (holder) {
        await c.query(`UPDATE commission_memberships SET status = 'ended', end_date = current_date, note = 'جایگزینی سمت' WHERE id = $1`, [holder.id]);
        await audit(c, req, { chamberId: commission.chamber_id, action: 'membership.ended', entity: 'membership', entityId: holder.id, before: holder, reason: 'جایگزینی سمت' });
      }
    }
    const r = await one(
      `INSERT INTO commission_memberships (chamber_id, commission_id, user_id, position, has_vote, start_date, end_date)
       VALUES ($1,$2,$3,$4,$5,COALESCE($6::date, current_date),$7) RETURNING *`,
      [commission.chamber_id, commissionId, userId, b.position, b.hasVote ?? positionHasVote(b.position), b.startDate ?? null, b.endDate ?? null],
      c,
    );
    await audit(c, req, { chamberId: commission.chamber_id, action: 'membership.created', entity: 'membership', entityId: r.id, after: r });
    return r;
  });
  res.status(201).json(row);
});

/** Change position / voting right: the old row is ended and a new one created, so history is preserved. */
structureRouter.patch('/memberships/:id', async (req, res) => {
  const id = param(req, 'id');
  const b = body(req, z.object({ position: z.enum(POSITIONS).optional(), hasVote: z.boolean().optional(), endDate: dateStr.nullish() }));
  const row = await tx(async (c) => {
    const before = await one('SELECT * FROM commission_memberships WHERE id = $1 FOR UPDATE', [id], c);
    if (!before) throw notFound();
    requireChamberAdmin(currentUser(req), before.chamber_id);
    if (before.status !== 'active') throw conflict('عضویت پایان‌یافته قابل ویرایش نیست');
    const position: Position = b.position ?? before.position;
    if (position === before.position && b.hasVote === undefined) {
      const r = await one('UPDATE commission_memberships SET end_date = $2 WHERE id = $1 RETURNING *', [id, b.endDate ?? null], c);
      await audit(c, req, { chamberId: before.chamber_id, action: 'membership.updated', entity: 'membership', entityId: id, before, after: r });
      return r;
    }
    await c.query(`UPDATE commission_memberships SET status = 'ended', end_date = current_date, note = 'تغییر سمت' WHERE id = $1`, [id]);
    const r = await one(
      `INSERT INTO commission_memberships (chamber_id, commission_id, user_id, position, has_vote, start_date, end_date)
       VALUES ($1,$2,$3,$4,$5,current_date,$6) RETURNING *`,
      [before.chamber_id, before.commission_id, before.user_id, position, b.hasVote ?? positionHasVote(position), b.endDate ?? before.end_date],
      c,
    ).catch((e) => {
      if (e.code === '23505') throw conflict('این سمت در حال حاضر متصدی دارد', 'position_taken');
      throw e;
    });
    await audit(c, req, { chamberId: before.chamber_id, action: 'membership.changed', entity: 'membership', entityId: r.id, before, after: r });
    return r;
  });
  res.json(row);
});

structureRouter.post('/memberships/:id/end', async (req, res) => {
  const id = param(req, 'id');
  const b = body(req, z.object({ endDate: dateStr.optional(), reason: z.string().optional() }));
  const row = await tx(async (c) => {
    const before = await one('SELECT * FROM commission_memberships WHERE id = $1 FOR UPDATE', [id], c);
    if (!before) throw notFound();
    requireChamberAdmin(currentUser(req), before.chamber_id);
    const r = await one(
      `UPDATE commission_memberships SET status = 'ended', end_date = COALESCE($2::date, current_date), note = $3 WHERE id = $1 RETURNING *`,
      [id, b.endDate ?? null, b.reason ?? null],
      c,
    );
    await audit(c, req, { chamberId: before.chamber_id, action: 'membership.ended', entity: 'membership', entityId: id, before, after: r, reason: b.reason });
    return r;
  });
  res.json(row);
});

// ─────────────────────────────── People ───────────────────────────────

/** Officers may search people of their chamber (to invite guests); admins manage people. */
async function canSearchPeople(u: AuthUser, chamberId: string) {
  if (isChamberAdmin(u, chamberId)) return true;
  const r = await one(
    `SELECT 1 FROM commission_memberships WHERE user_id = $1 AND chamber_id = $2 AND status = 'active'
       AND position IN ('chair','vice_chair','secretary')`,
    [u.id, chamberId],
  );
  return !!r;
}

structureRouter.get('/people', async (req, res) => {
  const u = currentUser(req);
  const chamberId = uuid.parse(req.query.chamberId);
  if (!(await canSearchPeople(u, chamberId))) throw forbidden();
  const { page, pageSize, offset, q } = pageParams(req);
  const where = `chamber_id = $1 AND ($2::text IS NULL OR full_name ILIKE '%' || $2 || '%' OR organization ILIKE '%' || $2 || '%'
     OR mobile LIKE '%' || $2 || '%' OR email ILIKE '%' || $2 || '%')`;
  const items = await query(
    `SELECT id, full_name, national_id, mobile, email, organization, job_title, is_active, (password_hash IS NOT NULL) AS can_login,
       EXISTS (SELECT 1 FROM chamber_admins a WHERE a.user_id = users.id AND a.chamber_id = $1) AS is_chamber_admin
     FROM users WHERE ${where} ORDER BY full_name LIMIT ${pageSize} OFFSET ${offset}`,
    [chamberId, q],
  );
  const [{ count }] = await query(`SELECT count(*) FROM users WHERE ${where}`, [chamberId, q]);
  res.json(paged(items, count, page, pageSize));
});

structureRouter.post('/people', async (req, res) => {
  const u = currentUser(req);
  const b = body(req, personSchema.extend({ chamberId: uuid }));
  if (!(await canSearchPeople(u, b.chamberId))) throw forbidden();
  // Only admins may give a login password to a new person.
  if (b.password && !isChamberAdmin(u, b.chamberId)) throw forbidden();
  const row = await tx((c) => createPerson(c, req, b.chamberId, b));
  res.status(201).json(row);
});

structureRouter.get('/people/:id', async (req, res) => {
  const u = currentUser(req);
  const id = param(req, 'id');
  const p = await one(
    'SELECT id, chamber_id, full_name, national_id, mobile, email, organization, job_title, bio, is_active, created_at FROM users WHERE id = $1',
    [id],
  );
  if (!p || (u.id !== id && !(p.chamber_id && isChamberAdmin(u, p.chamber_id)))) throw notFound();
  const memberships = await query(
    `SELECT m.*, c.name AS commission_name, t.title AS term_title FROM commission_memberships m
       JOIN commissions c ON c.id = m.commission_id JOIN terms t ON t.id = c.term_id
      WHERE m.user_id = $1 ORDER BY m.start_date DESC`,
    [id],
  );
  res.json({ ...p, memberships });
});

structureRouter.patch('/people/:id', async (req, res) => {
  const u = currentUser(req);
  const id = param(req, 'id');
  const b = body(req, personSchema.partial().extend({ isActive: z.boolean().optional() }));
  const row = await tx(async (c) => {
    const before = await one('SELECT id, chamber_id, full_name, mobile, email, organization, job_title, is_active FROM users WHERE id = $1 FOR UPDATE', [id], c);
    if (!before || !before.chamber_id) throw notFound();
    requireChamberAdmin(u, before.chamber_id);
    const hash = b.password ? await bcrypt.hash(b.password, 10) : null;
    const after = await one(
      `UPDATE users SET full_name = COALESCE($2, full_name), national_id = COALESCE($3, national_id), mobile = COALESCE($4, mobile),
         email = COALESCE($5, email), organization = COALESCE($6, organization), job_title = COALESCE($7, job_title),
         bio = COALESCE($8, bio), password_hash = COALESCE($9, password_hash), is_active = COALESCE($10, is_active), updated_at = now()
       WHERE id = $1 RETURNING id, chamber_id, full_name, mobile, email, organization, job_title, is_active`,
      [id, b.fullName, b.nationalId, b.mobile, b.email, b.organization, b.jobTitle, b.bio, hash, b.isActive],
      c,
    );
    if (b.isActive === false || b.password) {
      await c.query('UPDATE refresh_tokens SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL', [id]);
    }
    await audit(c, req, {
      chamberId: before.chamber_id,
      action: 'person.updated',
      entity: 'user',
      entityId: id,
      before,
      after: { ...after, passwordChanged: !!b.password },
    });
    return after;
  }).catch((e) => {
    if (e.code === '23505') throw conflict('ایمیل یا شماره موبایل تکراری است');
    throw e;
  });
  res.json(row);
});
