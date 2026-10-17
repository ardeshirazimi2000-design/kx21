import { Router } from 'express';
import { z } from 'zod';
import { currentUser, requirePerm, type AuthUser } from '../auth/middleware.js';
import { one, pool, query, tx, type Db } from '../db/pool.js';
import { audit } from '../lib/audit.js';
import { code128Svg, qrSvg } from '../lib/barcode.js';
import { config } from '../config.js';
import { badRequest, conflict, forbidden, notFound } from '../lib/errors.js';
import { scanFile, sendFile, upload, uploadedName, validateFile } from '../lib/files.js';
import { getFile, putFile } from '../lib/storage.js';
import { body, dateStr, listParam, paged, pageParams, param, parse, uuid } from '../lib/validate.js';
import { letterVisibleSql, loadVisibleLetter } from '../services/access.js';
import { archiveLetter } from '../services/archive.js';
import { letterContentHash, newTrackingCode, nextLetterNumber, primaryUnitOf } from '../services/letters.js';
import { notify, positionHolders } from '../services/notifications.js';
import { signaturesOf, signContent, verifySignature } from '../services/signatures.js';
import { actOnStep, canActOnStep, cancelWorkflow, startWorkflow } from '../services/workflow.js';

export const lettersRouter = Router();

const recipientSchema = z
  .object({ userId: uuid.nullish(), positionId: uuid.nullish(), unitId: uuid.nullish(), kind: z.enum(['to', 'cc']).default('to') })
  .refine((r) => [r.userId, r.positionId, r.unitId].filter(Boolean).length === 1, 'هر گیرنده باید دقیقاً یک کاربر، سمت یا واحد باشد');

const letterSchema = z.object({
  kind: z.enum(['incoming', 'outgoing', 'internal']),
  subject: z.string().min(3).max(500),
  body: z.string().max(100_000).nullish(),
  summary: z.string().max(2000).nullish(),
  externalParty: z.string().max(300).nullish(),
  externalOrg: z.string().max(300).nullish(),
  externalNumber: z.string().max(100).nullish(),
  externalDate: dateStr.nullish(),
  source: z.enum(['manual', 'email', 'scan', 'api']).default('manual'),
  deliveryMethod: z.string().max(100).nullish(),
  priority: z.enum(['low', 'normal', 'high', 'urgent']).default('normal'),
  confidentiality: z.number().int().min(0).max(2).default(0),
  ownerUnitId: uuid.nullish(),
  replyToId: uuid.nullish(),
  dueDate: dateStr.nullish(),
  recipients: z.array(recipientSchema).max(100).optional(),
});

const REGISTER_PERM = { incoming: 'letter.register_incoming', outgoing: 'letter.register_outgoing', internal: 'letter.create' } as const;

function requireCreate(u: AuthUser, kind: string, unitId: string | null) {
  // Anyone with letter.create drafts; incoming letters are recorded by the secretariat.
  if (kind === 'incoming') requirePerm(u, 'letter.register_incoming', unitId);
  else requirePerm(u, 'letter.create');
}

async function setRecipients(c: Db, letterId: string, recipients: z.infer<typeof recipientSchema>[] | undefined) {
  if (!recipients) return;
  await c.query('DELETE FROM letter_recipients WHERE letter_id = $1', [letterId]);
  for (const r of recipients) {
    await c.query('INSERT INTO letter_recipients (letter_id, user_id, position_id, unit_id, kind) VALUES ($1,$2,$3,$4,$5)', [
      letterId, r.userId ?? null, r.positionId ?? null, r.unitId ?? null, r.kind,
    ]);
  }
}

/** Users behind the internal recipients (unit = its manager position holders). */
async function recipientUsers(c: Db, letterId: string): Promise<string[]> {
  const rows = await query('SELECT * FROM letter_recipients WHERE letter_id = $1', [letterId], c);
  const ids: string[] = [];
  for (const r of rows) {
    if (r.user_id) ids.push(r.user_id);
    else if (r.position_id) ids.push(...(await positionHolders(r.position_id, c)));
    else if (r.unit_id) {
      const m = await one('SELECT id FROM positions WHERE unit_id = $1 AND is_manager', [r.unit_id], c);
      if (m) ids.push(...(await positionHolders(m.id, c)));
    }
  }
  return ids;
}

async function register(c: Db, req: any, u: AuthUser, letter: any) {
  if (letter.number) throw conflict('نامه قبلاً ثبت شده است');
  if (letter.status === 'cancelled') throw conflict('نامه ابطال شده است');
  requirePerm(u, REGISTER_PERM[letter.kind as keyof typeof REGISTER_PERM], letter.owner_unit_id);
  const n = await nextLetterNumber(c, letter.kind);
  const r = await one(
    `UPDATE letters SET number = $2, year = $3, seq = $4, status = CASE WHEN status = 'draft' THEN 'registered' ELSE status END,
       registered_at = now(), registered_by = $5, updated_at = now() WHERE id = $1 RETURNING *`,
    [letter.id, n.number, n.year, n.seq, u.id],
    c,
  );
  await audit(c, req, { action: 'letter.registered', entity: 'letter', entityId: letter.id, after: { number: n.number } });
  if (r.kind === 'internal') {
    await notify({ userIds: await recipientUsers(c, r.id), event: 'letter.received', vars: { subject: r.subject, number: r.number }, data: { letterId: r.id } }, c);
  }
  return r;
}

lettersRouter.post('/letters', async (req, res) => {
  const u = currentUser(req);
  const b = body(req, letterSchema.extend({ register: z.boolean().default(false), workflow: z.string().nullish() }));
  const ownerUnit = b.ownerUnitId ?? (await primaryUnitOf(u.id, pool));
  requireCreate(u, b.kind, ownerUnit);
  if (b.confidentiality > u.clearance) throw forbidden('سطح محرمانگی بالاتر از مجوز شماست');
  if (b.kind !== 'internal' && !b.externalParty && !b.externalOrg) throw badRequest(b.kind === 'incoming' ? 'فرستنده نامه وارده را وارد کنید' : 'گیرنده نامه صادره را وارد کنید');
  const row = await tx(async (c) => {
    if (b.replyToId) await loadVisibleLetter(u, b.replyToId, c);
    let l = await one(
      `INSERT INTO letters (kind, tracking_code, subject, body, summary, external_party, external_org, external_number, external_date, source,
          delivery_method, priority, confidentiality, owner_unit_id, reply_to_id, due_date, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17) RETURNING *`,
      [
        b.kind, await newTrackingCode(c), b.subject, b.body ?? null, b.summary ?? null, b.externalParty ?? null, b.externalOrg ?? null,
        b.externalNumber ?? null, b.externalDate ?? null, b.source, b.deliveryMethod ?? null, b.priority, b.confidentiality, ownerUnit,
        b.replyToId ?? null, b.dueDate ?? null, u.id,
      ],
      c,
    );
    await setRecipients(c, l.id, b.recipients);
    await audit(c, req, { action: 'letter.created', entity: 'letter', entityId: l.id, after: l });
    if (b.register) l = await register(c, req, u, l);
    if (b.workflow) {
      requirePerm(u, 'workflow.start');
      await startWorkflow(c, req, { letterId: l.id, definition: b.workflow, startedBy: u.id });
      l = await one('SELECT * FROM letters WHERE id = $1', [l.id], c);
    }
    return l;
  });
  res.status(201).json(row);
});

lettersRouter.get('/letters', async (req, res) => {
  const u = currentUser(req);
  const { page, pageSize, offset, q } = pageParams(req);
  const f = parse(
    z.object({
      kind: z.string().optional(),
      status: z.string().optional(),
      priority: z.string().optional(),
      box: z.enum(['all', 'mine', 'drafts', 'sent']).default('all'),
      from: dateStr.optional(),
      to: dateStr.optional(),
      unitId: uuid.optional(),
      number: z.string().optional(),
      party: z.string().optional(),
      confidentiality: z.coerce.number().int().optional(),
      source: z.string().optional(),
    }),
    req.query,
  );
  const params: unknown[] = [];
  const add = (v: unknown) => (params.push(v), `$${params.length}`);
  const where = [letterVisibleSql(u, params)];
  const kinds = listParam(f.kind);
  if (kinds) where.push(`l.kind = ANY(${add(kinds)}::text[])`);
  const statuses = listParam(f.status);
  if (statuses) where.push(`l.status = ANY(${add(statuses)}::text[])`);
  const priorities = listParam(f.priority);
  if (priorities) where.push(`l.priority = ANY(${add(priorities)}::text[])`);
  if (f.box === 'mine') where.push(`l.created_by = ${add(u.id)}`);
  if (f.box === 'drafts') where.push(`l.status = 'draft' AND l.created_by = ${add(u.id)}`);
  if (f.box === 'sent') where.push(`l.kind = 'outgoing' AND l.status = 'sent'`);
  if (f.from) where.push(`COALESCE(l.registered_at, l.created_at) >= ${add(f.from)}::date`);
  if (f.to) where.push(`COALESCE(l.registered_at, l.created_at) < ${add(f.to)}::date + 1`);
  if (f.unitId) where.push(`l.owner_unit_id = ${add(f.unitId)}`);
  if (f.number) where.push(`(fa_normalize(l.number) ILIKE '%' || fa_normalize(${add(f.number)}) || '%' OR l.external_number ILIKE '%' || ${add(f.number)} || '%')`);
  if (f.party) where.push(`(fa_normalize(l.external_party) ILIKE '%' || fa_normalize(${add(f.party)}) || '%' OR fa_normalize(l.external_org) ILIKE '%' || fa_normalize(${add(f.party)}) || '%')`);
  if (f.confidentiality !== undefined) where.push(`l.confidentiality = ${add(f.confidentiality)}`);
  if (f.source) where.push(`l.source = ${add(f.source)}`);
  let rank = '';
  if (q) {
    // Full-text (all words, prefix match) or tracking code / number substring.
    const terms = q.replace(/[^\p{L}\p{N}\s/]/gu, ' ').split(/\s+/).filter(Boolean).map((t) => `${t}:*`).join(' & ');
    const tsq = add(terms || q);
    const raw = add(q);
    where.push(`(l.search @@ to_tsquery('simple', fa_normalize(${tsq})) OR l.tracking_code = ${raw} OR fa_normalize(l.number) = fa_normalize(${raw}))`);
    rank = `ts_rank(l.search, to_tsquery('simple', fa_normalize(${tsq}))) DESC, `;
  }
  const w = where.join(' AND ');
  const items = await query(
    `SELECT l.id, l.kind, l.number, l.tracking_code, l.subject, l.external_party, l.external_org, l.external_number, l.priority, l.confidentiality,
            l.status, l.source, l.due_date, l.registered_at, l.created_at, ou.name AS owner_unit, cu.full_name AS created_by_name,
            (SELECT count(*) FROM letter_attachments a WHERE a.letter_id = l.id) AS attachment_count
       FROM letters l LEFT JOIN org_units ou ON ou.id = l.owner_unit_id LEFT JOIN users cu ON cu.id = l.created_by
      WHERE ${w} ORDER BY ${rank}COALESCE(l.registered_at, l.created_at) DESC LIMIT ${pageSize} OFFSET ${offset}`,
    params,
  );
  const [{ count }] = await query(`SELECT count(*) FROM letters l WHERE ${w}`, params);
  res.json(paged(items, count, page, pageSize));
});

lettersRouter.get('/letters/:id', async (req, res) => {
  const u = currentUser(req);
  const l = await loadVisibleLetter(u, param(req, 'id'));
  const [extra, recipients, attachments, routing, instances, steps, refs, resolution, document] = await Promise.all([
    one(
      `SELECT ou.name AS owner_unit, cu.full_name AS created_by_name, ru.full_name AS registered_by_name, su.full_name AS signer_name,
              rt.number AS reply_to_number, rt.subject AS reply_to_subject
         FROM letters l LEFT JOIN org_units ou ON ou.id = l.owner_unit_id LEFT JOIN users cu ON cu.id = l.created_by
         LEFT JOIN users ru ON ru.id = l.registered_by LEFT JOIN users su ON su.id = l.signer_id LEFT JOIN letters rt ON rt.id = l.reply_to_id
        WHERE l.id = $1`,
      [l.id],
    ),
    query(
      `SELECT lr.*, us.full_name AS user_name, p.title AS position_title, pu.name AS position_unit, ou.name AS unit_name
         FROM letter_recipients lr LEFT JOIN users us ON us.id = lr.user_id LEFT JOIN positions p ON p.id = lr.position_id
         LEFT JOIN org_units pu ON pu.id = p.unit_id LEFT JOIN org_units ou ON ou.id = lr.unit_id WHERE lr.letter_id = $1`,
      [l.id],
    ),
    query(
      `SELECT a.id, a.group_id, a.version, a.title, a.file_name, a.mime_type, a.size_bytes, a.sha256, a.source, a.created_at, us.full_name AS uploaded_by_name
         FROM letter_attachments a LEFT JOIN users us ON us.id = a.uploaded_by WHERE a.letter_id = $1 ORDER BY a.created_at, a.version`,
      [l.id],
    ),
    query(
      `SELECT r.*, fu.full_name AS from_name, tu.full_name AS to_name, p.title AS to_position, pu.name AS to_unit, du.full_name AS done_by_name
         FROM letter_routing r LEFT JOIN users fu ON fu.id = r.from_user_id LEFT JOIN users tu ON tu.id = r.to_user_id
         LEFT JOIN positions p ON p.id = r.to_position_id LEFT JOIN org_units pu ON pu.id = p.unit_id LEFT JOIN users du ON du.id = r.done_by
        WHERE r.letter_id = $1 ORDER BY r.created_at`,
      [l.id],
    ),
    query(
      `SELECT wi.*, d.name AS definition_name, d.key AS definition_key, d.version AS definition_version FROM workflow_instances wi
         JOIN workflow_definitions d ON d.id = wi.definition_id WHERE wi.letter_id = $1 ORDER BY wi.started_at`,
      [l.id],
    ),
    query(
      `SELECT ws.*, au.full_name AS assignee_name, p.title AS assignee_position, xu.full_name AS acted_by_name FROM workflow_steps ws
         JOIN workflow_instances wi ON wi.id = ws.instance_id LEFT JOIN users au ON au.id = ws.assignee_user_id
         LEFT JOIN positions p ON p.id = ws.assignee_position_id LEFT JOIN users xu ON xu.id = ws.acted_by
        WHERE wi.letter_id = $1 ORDER BY ws.created_at`,
      [l.id],
    ),
    query('SELECT * FROM letter_meeting_refs WHERE letter_id = $1 ORDER BY created_at', [l.id]),
    one('SELECT external_id, number, commission_name, status, progress, due_date FROM resolutions_cache WHERE letter_id = $1', [l.id]),
    one('SELECT id, folder_id, title FROM documents WHERE letter_id = $1', [l.id]),
  ]);
  const hash = await letterContentHash(pool, l.id);
  const signatures = await signaturesOf('letter', l.id, hash, pool);
  const myPositions = u.positions.map((p) => p.positionId);
  const myRoutes = routing.filter((r) => ['pending', 'seen'].includes(r.status) && (r.to_user_id === u.id || myPositions.includes(r.to_position_id)));
  const mySteps = [];
  for (const s of steps) if (s.status === 'active' && (await canActOnStep(pool, u, s))) mySteps.push(s.id);
  res.json({
    ...l,
    ...extra,
    recipients,
    attachments,
    routing,
    workflows: instances.map((i) => ({ ...i, steps: steps.filter((s) => s.instance_id === i.id) })),
    meetingRefs: refs,
    resolution,
    document,
    signatures,
    contentHash: hash,
    my: {
      routes: myRoutes.map((r) => r.id),
      steps: mySteps,
      canRegister: !l.number && l.status !== 'cancelled' && u.can(REGISTER_PERM[l.kind as keyof typeof REGISTER_PERM], l.owner_unit_id),
      canEdit: ['draft', 'registered'].includes(l.status) && !signatures.length && (l.created_by === u.id || u.can('letter.register_incoming', l.owner_unit_id)),
      canSign: !!l.number && !['cancelled', 'archived'].includes(l.status) && u.can('letter.sign', l.owner_unit_id),
      canSend: l.kind === 'outgoing' && !!l.number && !['sent', 'cancelled', 'archived'].includes(l.status) && u.can('letter.send', l.owner_unit_id),
      canArchive: !!l.number && !['archived', 'cancelled'].includes(l.status) && u.can('archive.manage'),
      canCancel: !['cancelled', 'archived', 'sent'].includes(l.status) && (u.can('letter.cancel', l.owner_unit_id) || (l.status === 'draft' && l.created_by === u.id)),
      canStartWorkflow: !['cancelled', 'archived', 'sent'].includes(l.status) && u.can('workflow.start') && !instances.some((i) => i.status === 'running'),
      canReferToMeeting: !!l.number && u.can('meetings.refer'),
    },
  });
});

lettersRouter.patch('/letters/:id', async (req, res) => {
  const u = currentUser(req);
  const b = body(req, letterSchema.omit({ kind: true }).partial());
  const row = await tx(async (c) => {
    const l = await loadVisibleLetter(u, param(req, 'id'), c, true);
    if (!['draft', 'registered'].includes(l.status)) throw conflict('نامه در این وضعیت قابل ویرایش نیست');
    if (l.created_by !== u.id && !u.can('letter.register_incoming', l.owner_unit_id)) throw forbidden();
    if ((await query(`SELECT 1 FROM signatures WHERE entity_type = 'letter' AND entity_id = $1`, [l.id], c)).length) throw conflict('نامه امضاشده قابل ویرایش نیست');
    if (b.confidentiality !== undefined && b.confidentiality > u.clearance) throw forbidden('سطح محرمانگی بالاتر از مجوز شماست');
    const r = await one(
      `UPDATE letters SET subject = COALESCE($2, subject), body = COALESCE($3, body), summary = COALESCE($4, summary),
         external_party = COALESCE($5, external_party), external_org = COALESCE($6, external_org), external_number = COALESCE($7, external_number),
         external_date = COALESCE($8, external_date), delivery_method = COALESCE($9, delivery_method), priority = COALESCE($10, priority),
         confidentiality = COALESCE($11, confidentiality), owner_unit_id = COALESCE($12, owner_unit_id), due_date = COALESCE($13, due_date),
         updated_at = now() WHERE id = $1 RETURNING *`,
      [l.id, b.subject, b.body, b.summary, b.externalParty, b.externalOrg, b.externalNumber, b.externalDate, b.deliveryMethod, b.priority, b.confidentiality, b.ownerUnitId, b.dueDate],
      c,
    );
    await setRecipients(c, l.id, b.recipients);
    await audit(c, req, { action: 'letter.updated', entity: 'letter', entityId: l.id, before: l, after: r });
    return r;
  });
  res.json(row);
});

lettersRouter.post('/letters/:id/register', async (req, res) => {
  const u = currentUser(req);
  const row = await tx(async (c) => register(c, req, u, await loadVisibleLetter(u, param(req, 'id'), c, true)));
  res.json(row);
});

// ─────────────── Attachments ───────────────

lettersRouter.post('/letters/:id/attachments', upload.single('file'), async (req, res) => {
  const u = currentUser(req);
  if (!req.file) throw badRequest('فایلی ارسال نشده است');
  const meta = parse(z.object({ groupId: uuid.nullish(), title: z.string().max(200).nullish(), source: z.enum(['upload', 'scan', 'email']).default('upload') }), req.body);
  const name = uploadedName(req.file);
  const mime = validateFile(name, req.file.buffer);
  if ((await scanFile(req.file.buffer)) !== 'clean') throw badRequest('فایل آلوده تشخیص داده شد');
  const l = await loadVisibleLetter(u, param(req, 'id'));
  if (['cancelled', 'archived', 'sent'].includes(l.status)) throw conflict('به نامه در این وضعیت پیوست اضافه نمی‌شود');
  const stored = await putFile('letters', req.file.buffer);
  const row = await tx(async (c) => {
    let groupId = meta.groupId ?? null;
    let version = 1;
    if (groupId) {
      const last = await one('SELECT max(version) AS v FROM letter_attachments WHERE letter_id = $1 AND group_id = $2', [l.id, groupId], c);
      if (!last?.v) throw badRequest('پیوست اصلی یافت نشد');
      version = last.v + 1;
    } else {
      groupId = (await one('SELECT gen_random_uuid() AS id', [], c))!.id;
    }
    const r = await one(
      `INSERT INTO letter_attachments (letter_id, group_id, version, title, file_name, mime_type, size_bytes, storage_key, sha256, source, uploaded_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id, group_id, version, title, file_name, mime_type, size_bytes, sha256, created_at`,
      [l.id, groupId, version, meta.title ?? null, name, mime, stored.size, stored.storageKey, stored.sha256, meta.source, u.id],
      c,
    );
    await audit(c, req, { action: 'letter.attachment_added', entity: 'letter', entityId: l.id, after: r });
    return r;
  });
  res.status(201).json(row);
});

lettersRouter.get('/letters/:id/attachments/:attId/download', async (req, res) => {
  const u = currentUser(req);
  const l = await loadVisibleLetter(u, param(req, 'id'));
  const a = await one('SELECT * FROM letter_attachments WHERE id = $1 AND letter_id = $2', [param(req, 'attId'), l.id]);
  if (!a) throw notFound();
  sendFile(res, await getFile(a.storage_key), a.file_name, a.mime_type, req.query.inline === '1');
});

// ─────────────── Barcode / QR ───────────────

lettersRouter.get('/letters/:id/barcode.svg', async (req, res) => {
  const l = await loadVisibleLetter(currentUser(req), param(req, 'id'));
  res.type('image/svg+xml').send(code128Svg(l.tracking_code));
});

lettersRouter.get('/letters/:id/qr.svg', async (req, res) => {
  const l = await loadVisibleLetter(currentUser(req), param(req, 'id'));
  res.type('image/svg+xml').send(await qrSvg(`${config.publicUrl}/verify/${l.tracking_code}`));
});

/** Find a letter by scanning its barcode (tracking code) or typing its number. */
lettersRouter.get('/letters/lookup/:code', async (req, res) => {
  const u = currentUser(req);
  const code = String(req.params.code).trim();
  const params: unknown[] = [code];
  const l = await one(`SELECT l.id FROM letters l WHERE (l.tracking_code = $1 OR fa_normalize(l.number) = fa_normalize($1)) AND ${letterVisibleSql(u, params)}`, params);
  if (!l) throw notFound('نامه‌ای با این بارکد یافت نشد');
  res.json(l);
});

// ─────────────── Routing (ارجاع) ───────────────

lettersRouter.post('/letters/:id/routes', async (req, res) => {
  const u = currentUser(req);
  const b = body(
    req,
    z.object({
      targets: z
        .array(
          z
            .object({
              userId: uuid.nullish(),
              positionId: uuid.nullish(),
              action: z.enum(['refer', 'review', 'approve', 'sign', 'archive', 'info', 'follow_up']).default('refer'),
              instruction: z.string().max(2000).nullish(),
              dueAt: z.string().datetime({ offset: true }).nullish(),
            })
            .refine((t) => !!t.userId !== !!t.positionId, 'گیرنده ارجاع باید کاربر یا سمت باشد'),
        )
        .min(1)
        .max(50),
      parentId: uuid.nullish(),
      /** Close my own pending referral on this letter. */
      completeMine: z.boolean().default(false),
    }),
  );
  const rows = await tx(async (c) => {
    const l = await loadVisibleLetter(u, param(req, 'id'), c, true);
    if (['cancelled', 'archived'].includes(l.status)) throw conflict('نامه در این وضعیت ارجاع نمی‌شود');
    const out = [];
    for (const t of b.targets) {
      const r = await one(
        `INSERT INTO letter_routing (letter_id, parent_id, from_user_id, to_user_id, to_position_id, action, instruction, due_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
        [l.id, b.parentId ?? null, u.id, t.userId ?? null, t.positionId ?? null, t.action, t.instruction ?? null, t.dueAt ?? null],
        c,
      );
      out.push(r);
      const users = t.userId ? [t.userId] : await positionHolders(t.positionId!, c);
      const ACTION: Record<string, string> = { refer: 'اقدام', review: 'بررسی', approve: 'تأیید', sign: 'امضا', archive: 'بایگانی', info: 'اطلاع', follow_up: 'پیگیری' };
      await notify(
        { userIds: users, event: 'routing.assigned', vars: { actor: u.fullName, number: l.number ?? 'پیش‌نویس', subject: l.subject, action: ACTION[t.action], instruction: t.instruction ?? '' }, data: { letterId: l.id } },
        c,
      );
    }
    if (b.completeMine) {
      await c.query(
        `UPDATE letter_routing SET status = 'done', done_at = now(), done_by = $2, response = COALESCE(response, 'ارجاع شد')
          WHERE letter_id = $1 AND status IN ('pending','seen') AND workflow_step_id IS NULL AND (to_user_id = $2 OR to_position_id = ANY($3::uuid[]))`,
        [l.id, u.id, u.positions.map((p) => p.positionId)],
      );
    }
    if (l.status === 'registered') await c.query(`UPDATE letters SET status = 'in_progress', updated_at = now() WHERE id = $1`, [l.id]);
    await audit(c, req, { action: 'letter.routed', entity: 'letter', entityId: l.id, after: { targets: b.targets } });
    return out;
  });
  res.status(201).json(rows);
});

lettersRouter.patch('/routes/:id', async (req, res) => {
  const u = currentUser(req);
  const b = body(req, z.object({ status: z.enum(['seen', 'done', 'returned']), response: z.string().max(4000).nullish() }));
  const row = await tx(async (c) => {
    const r = await one('SELECT * FROM letter_routing WHERE id = $1 FOR UPDATE', [param(req, 'id')], c);
    const mine = r && (r.to_user_id === u.id || u.positions.some((p) => p.positionId === r.to_position_id));
    if (!r || !mine) throw notFound();
    if (r.workflow_step_id && b.status !== 'seen') throw conflict('این ارجاع مربوط به گردش کار است؛ از اقدام گردش کار استفاده کنید');
    if (!['pending', 'seen'].includes(r.status)) throw conflict('این ارجاع بسته شده است');
    if (b.status === 'returned' && !(b.response && b.response.length >= 3)) throw badRequest('برای برگشت، توضیح لازم است');
    const out = await one(
      `UPDATE letter_routing SET status = $2, response = COALESCE($3, response), seen_at = COALESCE(seen_at, now()),
         done_at = CASE WHEN $2 IN ('done','returned') THEN now() END, done_by = CASE WHEN $2 IN ('done','returned') THEN $4::uuid END
       WHERE id = $1 RETURNING *`,
      [r.id, b.status, b.response ?? null, u.id],
      c,
    );
    if (b.status !== 'seen') await audit(c, req, { action: `routing.${b.status}`, entity: 'letter', entityId: r.letter_id, after: { routingId: r.id, response: b.response } });
    return out;
  });
  res.json(row);
});

/** Cartable (کارتابل): pending referrals and workflow steps addressed to me or my positions. */
lettersRouter.get('/cartable', async (req, res) => {
  const u = currentUser(req);
  const positions = u.positions.map((p) => p.positionId);
  const items = await query(
    `SELECT r.id AS routing_id, r.action, r.instruction, r.due_at, r.status, r.created_at, r.workflow_step_id, fu.full_name AS from_name,
            p.title AS to_position, l.id AS letter_id, l.kind, l.number, l.subject, l.priority, l.confidentiality, l.external_party, l.external_org,
            ws.name AS step_name, ws.type AS step_type, (r.due_at IS NOT NULL AND r.due_at < now()) AS overdue
       FROM letter_routing r JOIN letters l ON l.id = r.letter_id LEFT JOIN users fu ON fu.id = r.from_user_id
       LEFT JOIN positions p ON p.id = r.to_position_id LEFT JOIN workflow_steps ws ON ws.id = r.workflow_step_id
      WHERE r.status IN ('pending','seen') AND (r.to_user_id = $1 OR r.to_position_id = ANY($2::uuid[]))
      ORDER BY overdue DESC, CASE l.priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 ELSE 2 END, r.created_at DESC LIMIT 500`,
    [u.id, positions],
  );
  res.json(items);
});

// ─────────────── Workflow on a letter ───────────────

lettersRouter.post('/letters/:id/workflow', async (req, res) => {
  const u = currentUser(req);
  requirePerm(u, 'workflow.start');
  const b = body(req, z.object({ definition: z.string().min(1) }));
  const inst = await tx(async (c) => {
    const l = await loadVisibleLetter(u, param(req, 'id'), c);
    return startWorkflow(c, req, { letterId: l.id, definition: b.definition, startedBy: u.id });
  });
  res.status(201).json(inst);
});

lettersRouter.post('/workflow-steps/:id/act', async (req, res) => {
  const u = currentUser(req);
  const b = body(req, z.object({ decision: z.enum(['approve', 'reject']), comment: z.string().max(4000).nullish(), archiveFolderId: uuid.nullish() }));
  const next = await tx((c) => actOnStep(c, req, u, param(req, 'id'), b));
  res.json({ ok: true, next });
});

lettersRouter.post('/workflow-instances/:id/cancel', async (req, res) => {
  const u = currentUser(req);
  const b = body(req, z.object({ reason: z.string().min(3) }));
  await tx(async (c) => {
    const inst = await one('SELECT * FROM workflow_instances WHERE id = $1', [param(req, 'id')], c);
    if (!inst) throw notFound();
    const l = await loadVisibleLetter(u, inst.letter_id, c);
    if (inst.started_by !== u.id && !u.can('workflow.manage') && !u.can('letter.cancel', l.owner_unit_id)) throw forbidden();
    await cancelWorkflow(c, req, inst.id, b.reason);
  });
  res.status(204).end();
});

// ─────────────── Sign / send / archive / cancel ───────────────

lettersRouter.post('/letters/:id/sign', async (req, res) => {
  const u = currentUser(req);
  const row = await tx(async (c) => {
    const l = await loadVisibleLetter(u, param(req, 'id'), c, true);
    requirePerm(u, 'letter.sign', l.owner_unit_id);
    if (!l.number) throw conflict('نامه پیش از امضا باید شماره شود');
    if (['cancelled', 'archived'].includes(l.status)) throw conflict('نامه در این وضعیت امضا نمی‌شود');
    if (await one(`SELECT 1 FROM signatures WHERE entity_type = 'letter' AND entity_id = $1 AND user_id = $2`, [l.id, u.id], c)) throw conflict('شما این نامه را قبلاً امضا کرده‌اید');
    const sig = await signContent(c, { userId: u.id, entityType: 'letter', entityId: l.id, contentHash: await letterContentHash(c, l.id), positionTitle: u.positions[0]?.title });
    await c.query(`UPDATE letters SET signer_id = $2, status = CASE WHEN status IN ('registered','approved') THEN 'signed' ELSE status END, updated_at = now() WHERE id = $1`, [l.id, u.id]);
    await audit(c, req, { action: 'letter.signed', entity: 'letter', entityId: l.id, after: sig });
    return sig;
  });
  res.status(201).json(row);
});

lettersRouter.post('/letters/:id/send', async (req, res) => {
  const u = currentUser(req);
  const b = body(req, z.object({ deliveryMethod: z.string().max(100).nullish(), requireSignature: z.boolean().default(true) }));
  const row = await tx(async (c) => {
    const l = await loadVisibleLetter(u, param(req, 'id'), c, true);
    requirePerm(u, 'letter.send', l.owner_unit_id);
    if (l.kind !== 'outgoing') throw badRequest('فقط نامه صادره ارسال می‌شود');
    if (!l.number) throw conflict('نامه ثبت نشده است');
    if (['sent', 'cancelled', 'archived'].includes(l.status)) throw conflict('نامه در این وضعیت ارسال نمی‌شود');
    if (await one(`SELECT 1 FROM workflow_instances WHERE letter_id = $1 AND status = 'running'`, [l.id], c)) throw conflict('گردش کار نامه هنوز تمام نشده است');
    if (b.requireSignature && !(await one(`SELECT 1 FROM signatures WHERE entity_type = 'letter' AND entity_id = $1`, [l.id], c))) throw conflict('نامه صادره پیش از ارسال باید امضا شود');
    const r = await one(
      `UPDATE letters SET status = 'sent', sent_at = now(), delivery_method = COALESCE($2, delivery_method), updated_at = now() WHERE id = $1 RETURNING *`,
      [l.id, b.deliveryMethod ?? null],
      c,
    );
    await audit(c, req, { action: 'letter.sent', entity: 'letter', entityId: l.id, after: { deliveryMethod: r.delivery_method } });
    return r;
  });
  res.json(row);
});

lettersRouter.post('/letters/:id/archive', async (req, res) => {
  const u = currentUser(req);
  requirePerm(u, 'archive.manage');
  const b = body(req, z.object({ folderId: uuid.nullish() }));
  const doc = await tx(async (c) => {
    const l = await loadVisibleLetter(u, param(req, 'id'), c, true);
    if (!l.number) throw conflict('نامه ثبت‌نشده بایگانی نمی‌شود');
    if (await one(`SELECT 1 FROM workflow_instances WHERE letter_id = $1 AND status = 'running'`, [l.id], c)) throw conflict('گردش کار نامه هنوز تمام نشده است');
    return archiveLetter(c, req, u, l, b.folderId ?? null);
  });
  res.status(201).json(doc);
});

lettersRouter.post('/letters/:id/cancel', async (req, res) => {
  const u = currentUser(req);
  const b = body(req, z.object({ reason: z.string().min(3) }));
  const row = await tx(async (c) => {
    const l = await loadVisibleLetter(u, param(req, 'id'), c, true);
    if (!(u.can('letter.cancel', l.owner_unit_id) || (l.status === 'draft' && l.created_by === u.id))) throw forbidden();
    if (['cancelled', 'archived', 'sent'].includes(l.status)) throw conflict('نامه در این وضعیت ابطال نمی‌شود');
    const inst = await one(`SELECT id FROM workflow_instances WHERE letter_id = $1 AND status = 'running'`, [l.id], c);
    if (inst) await cancelWorkflow(c, req, inst.id, b.reason);
    await c.query(`UPDATE letter_routing SET status = 'cancelled' WHERE letter_id = $1 AND status IN ('pending','seen')`, [l.id]);
    const r = await one(`UPDATE letters SET status = 'cancelled', updated_at = now() WHERE id = $1 RETURNING *`, [l.id], c);
    await audit(c, req, { action: 'letter.cancelled', entity: 'letter', entityId: l.id, before: { status: l.status }, after: { status: 'cancelled' }, reason: b.reason });
    return r;
  });
  res.json(row);
});

// ─────────────── Public verification (QR) ───────────────

/** Public: confirms a printed letter is genuine. Confidential letters reveal only their number and date. */
export const publicLettersRouter = Router();
publicLettersRouter.get('/verify/:code', async (req, res) => {
  const code = String(req.params.code);
  if (!/^\d{12}$/.test(code)) throw notFound('کد رهگیری معتبر نیست');
  const l = await one(
    `SELECT l.id, l.kind, l.number, l.subject, l.status, l.registered_at, l.sent_at, l.confidentiality, l.external_org, l.external_party
       FROM letters l WHERE l.tracking_code = $1 AND l.number IS NOT NULL AND l.status <> 'cancelled'`,
    [code],
  );
  if (!l) throw notFound('نامه‌ای با این کد رهگیری ثبت نشده است');
  const sigs = await query(
    `SELECT s.*, u.full_name FROM signatures s JOIN users u ON u.id = s.user_id WHERE s.entity_type = 'letter' AND s.entity_id = $1 ORDER BY s.signed_at`,
    [l.id],
  );
  const hash = await letterContentHash(pool, l.id);
  res.json({
    number: l.number,
    kind: l.kind,
    registeredAt: l.registered_at,
    sentAt: l.sent_at,
    subject: l.confidentiality === 0 ? l.subject : null,
    party: l.confidentiality === 0 ? (l.kind === 'outgoing' ? l.external_org ?? l.external_party : null) : null,
    signatures: sigs.map((s) => ({ signer: s.full_name, position: s.position_title, signedAt: s.signed_at, ...verifySignature(s, hash) })),
  });
});
