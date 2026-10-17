/**
 * Integration API for external systems (office automation, …) — REST + JSON, versioned under /api/integration/v1.
 * Authentication: `X-Api-Key` or an OAuth2 client-credentials bearer token; every client is scoped to one chamber.
 * Events (resolution/meeting/referral changes) are pushed to the client's webhook (HMAC-signed) and can be polled.
 */
import crypto from 'node:crypto';
import express, { Router } from 'express';
import multer from 'multer';
import { z } from 'zod';
import { currentUser } from '../auth/middleware.js';
import { config } from '../config.js';
import { one, query, tx } from '../db/pool.js';
import { audit } from '../lib/audit.js';
import { badRequest, conflict, notFound } from '../lib/errors.js';
import { encryptSecret } from '../lib/secrets.js';
import { body, dateStr, paged, pageParams, param, parse, uuid } from '../lib/validate.js';
import { requireChamberAdmin } from '../services/access.js';
import {
  authenticateIntegration,
  eventsAfter,
  generateApiKey,
  integrationClient,
  INTEGRATION_EVENTS,
  INTEGRATION_SCOPES,
  issueClientToken,
  requireScope,
} from '../services/integrations.js';
import { notify } from '../services/notifications.js';
import { notifySubmitted, recordProgress } from '../services/resolutionProgress.js';
import { scanFile, sendDocument, storeFile, validateFile } from './documents.js';

export const integrationApiRouter = Router();

// OAuth2 token endpoint (RFC 6749 §4.4) — accepts JSON or form bodies.
integrationApiRouter.post('/oauth/token', express.urlencoded({ extended: false }), async (req, res) => {
  const b = req.body ?? {};
  let clientId = b.client_id as string | undefined;
  let clientSecret = b.client_secret as string | undefined;
  const basic = req.headers.authorization?.startsWith('Basic ') ? Buffer.from(req.headers.authorization.slice(6), 'base64').toString() : null;
  if (basic) [clientId, clientSecret] = [basic.slice(0, basic.indexOf(':')), basic.slice(basic.indexOf(':') + 1)];
  if (b.grant_type !== 'client_credentials') {
    res.status(400).json({ error: 'unsupported_grant_type' });
    return;
  }
  const token = clientId && clientSecret && uuid.safeParse(clientId).success ? await issueClientToken(clientId, clientSecret) : null;
  if (!token) {
    res.status(401).json({ error: 'invalid_client' });
    return;
  }
  res.setHeader('cache-control', 'no-store');
  res.json(token);
});

integrationApiRouter.use(authenticateIntegration);

const sinceParam = (v: unknown) => (typeof v === 'string' && v ? z.string().datetime({ offset: true }).parse(v) : null);

integrationApiRouter.get('/me', (req, res) => {
  const c = integrationClient(req);
  res.json({ id: c.id, name: c.name, chamberId: c.chamberId, scopes: c.scopes });
});

integrationApiRouter.get('/commissions', requireScope('meetings:read'), async (req, res) => {
  const c = integrationClient(req);
  res.json(
    await query(
      `SELECT cm.id, cm.name, cm.code, cm.domain, cm.status, t.title AS term_title,
              (SELECT u.full_name FROM commission_memberships ms JOIN users u ON u.id = ms.user_id
                WHERE ms.commission_id = cm.id AND ms.status = 'active' AND ms.position = 'secretary' LIMIT 1) AS secretary_name
         FROM commissions cm JOIN terms t ON t.id = cm.term_id
        WHERE cm.chamber_id = $1 AND cm.status = 'active' AND t.status = 'active' ORDER BY cm.name`,
      [c.chamberId],
    ),
  );
});

const MEETING_COLS = `m.id, m.commission_id, cm.name AS commission_name, cm.code AS commission_code, m.number, m.title, m.scheduled_at,
  m.duration_minutes, m.location, m.online_link, m.type, m.status, m.started_at, m.ended_at, m.updated_at`;

integrationApiRouter.get('/meetings', requireScope('meetings:read'), async (req, res) => {
  const c = integrationClient(req);
  const { page, pageSize, offset, q } = pageParams(req);
  const from = req.query.from ? z.string().datetime({ offset: true }).parse(req.query.from) : null;
  const to = req.query.to ? z.string().datetime({ offset: true }).parse(req.query.to) : null;
  const commissionId = req.query.commissionId ? uuid.parse(req.query.commissionId) : null;
  const since = sinceParam(req.query.updatedSince);
  const where = `m.chamber_id = $1 AND m.status <> 'draft' AND ($2::timestamptz IS NULL OR m.scheduled_at >= $2) AND ($3::timestamptz IS NULL OR m.scheduled_at < $3)
    AND ($4::uuid IS NULL OR m.commission_id = $4) AND ($5::timestamptz IS NULL OR m.updated_at >= $5)
    AND ($6::text IS NULL OR m.title ILIKE '%' || $6 || '%')`;
  const params = [c.chamberId, from, to, commissionId, since, q];
  const items = await query(
    `SELECT ${MEETING_COLS} FROM meetings m JOIN commissions cm ON cm.id = m.commission_id WHERE ${where}
      ORDER BY m.scheduled_at DESC LIMIT ${pageSize} OFFSET ${offset}`,
    params,
  );
  const [{ count }] = await query(`SELECT count(*) FROM meetings m WHERE ${where}`, params);
  res.json(paged(items, count, page, pageSize));
});

integrationApiRouter.get('/meetings/:id', requireScope('meetings:read'), async (req, res) => {
  const c = integrationClient(req);
  const m = await one(
    `SELECT ${MEETING_COLS} FROM meetings m JOIN commissions cm ON cm.id = m.commission_id WHERE m.id = $1 AND m.chamber_id = $2 AND m.status <> 'draft'`,
    [param(req, 'id'), c.chamberId],
  );
  if (!m) throw notFound('جلسه یافت نشد');
  const [participants, agenda, resolutions, documents] = await Promise.all([
    query(
      `SELECT u.id, u.full_name, u.national_id, u.email, u.mobile, u.organization, mi.role, mi.has_vote, a.status AS attendance
         FROM meeting_invitees mi JOIN users u ON u.id = mi.user_id LEFT JOIN attendance a ON a.meeting_id = mi.meeting_id AND a.user_id = mi.user_id
        WHERE mi.meeting_id = $1 ORDER BY u.full_name`,
      [m.id],
    ),
    query(
      `SELECT id, order_no, title, description, status, decision, issue_id FROM agenda_items WHERE meeting_id = $1 AND status <> 'removed' ORDER BY order_no`,
      [m.id],
    ),
    query(`SELECT id, number, text, status, progress, due_date FROM resolutions WHERE meeting_id = $1 ORDER BY number`, [m.id]),
    query(
      `SELECT d.id, d.kind, d.title, d.file_name, d.mime_type, d.size_bytes, d.sha256, d.created_at FROM documents d
        WHERE d.meeting_id = $1 OR d.agenda_item_id IN (SELECT id FROM agenda_items WHERE meeting_id = $1) ORDER BY d.created_at`,
      [m.id],
    ),
  ]);
  // Minutes are shared only once approved.
  const minutes = await one(`SELECT minutes_number, body, approved_at, content_hash FROM minutes WHERE meeting_id = $1 AND status = 'approved'`, [m.id]);
  res.json({ ...m, participants, agenda, resolutions, documents, minutes });
});

const RESOLUTION_COLS = `r.id, r.number, r.text, r.status, r.progress, r.priority, r.due_date, r.addressee, r.kpi, r.created_at, r.updated_at,
  r.commission_id, cm.name AS commission_name, r.meeting_id, m.number AS meeting_number, m.title AS meeting_title, m.scheduled_at AS meeting_date,
  r.owner_id, o.full_name AS owner_name, o.national_id AS owner_national_id, o.email AS owner_email, o.mobile AS owner_mobile`;
const RESOLUTION_FROM = `FROM resolutions r JOIN commissions cm ON cm.id = r.commission_id LEFT JOIN meetings m ON m.id = r.meeting_id LEFT JOIN users o ON o.id = r.owner_id`;

integrationApiRouter.get('/resolutions', requireScope('resolutions:read'), async (req, res) => {
  const c = integrationClient(req);
  const { page, pageSize, offset, q } = pageParams(req);
  const since = sinceParam(req.query.updatedSince);
  const status = typeof req.query.status === 'string' && req.query.status ? req.query.status.split(',') : null;
  const where = `r.chamber_id = $1 AND ($2::timestamptz IS NULL OR r.updated_at >= $2) AND ($3::text[] IS NULL OR r.status = ANY($3))
    AND ($4::text IS NULL OR r.text ILIKE '%' || $4 || '%' OR r.number ILIKE '%' || $4 || '%')`;
  const params = [c.chamberId, since, status, q];
  const items = await query(`SELECT ${RESOLUTION_COLS} ${RESOLUTION_FROM} WHERE ${where} ORDER BY r.updated_at DESC LIMIT ${pageSize} OFFSET ${offset}`, params);
  const [{ count }] = await query(`SELECT count(*) FROM resolutions r WHERE ${where}`, params);
  res.json(paged(items, count, page, pageSize));
});

integrationApiRouter.get('/resolutions/:id', requireScope('resolutions:read'), async (req, res) => {
  const c = integrationClient(req);
  const r = await one(`SELECT ${RESOLUTION_COLS} ${RESOLUTION_FROM} WHERE r.id = $1 AND r.chamber_id = $2`, [param(req, 'id'), c.chamberId]);
  if (!r) throw notFound('مصوبه یافت نشد');
  const [updates, documents] = await Promise.all([
    query(
      `SELECT ru.id, ru.kind, ru.progress, ru.note, ru.source, ru.external_ref, ru.created_at, COALESCE(u.full_name, ic.name) AS author
         FROM resolution_updates ru LEFT JOIN users u ON u.id = ru.user_id LEFT JOIN integration_clients ic ON ic.id = ru.integration_client_id
        WHERE ru.resolution_id = $1 ORDER BY ru.created_at`,
      [r.id],
    ),
    query(`SELECT id, kind, title, file_name, mime_type, size_bytes, sha256, created_at FROM documents WHERE resolution_id = $1 ORDER BY created_at`, [r.id]),
  ]);
  res.json({ ...r, updates, documents });
});

/** Execution feedback (پیگیری اجرای مصوبه) reported by the external system. */
integrationApiRouter.post('/resolutions/:id/feedback', requireScope('resolutions:feedback'), async (req, res) => {
  const c = integrationClient(req);
  const b = body(
    req,
    z.object({
      progress: z.number().int().min(0).max(100),
      note: z.string().max(4000).nullish(),
      submit: z.boolean().default(false),
      externalRef: z.string().max(200).nullish(),
      documentId: uuid.nullish(),
    }),
  );
  const { row, officers } = await tx(async (db) => {
    const r = await one('SELECT * FROM resolutions WHERE id = $1 AND chamber_id = $2 FOR UPDATE', [param(req, 'id'), c.chamberId], db);
    if (!r) throw notFound('مصوبه یافت نشد');
    if (b.documentId) {
      const d = await one('SELECT resolution_id FROM documents WHERE id = $1', [b.documentId], db);
      if (!d || d.resolution_id !== r.id) throw badRequest('مستند متعلق به این مصوبه نیست');
    }
    const note = b.note ? `[${c.name}] ${b.note}` : `[${c.name}]`;
    return recordProgress(db, req, r, { ...b, note, userId: null, source: 'integration', integrationClientId: c.id });
  });
  await notifySubmitted(row, officers);
  res.json({ id: row.id, status: row.status, progress: row.progress });
});

/** Refer a letter (مکاتبه) to a commission: creates an issue the secretary can put on a meeting's agenda. */
integrationApiRouter.post('/referrals', requireScope('referrals:write'), async (req, res) => {
  const c = integrationClient(req);
  const b = body(
    req,
    z.object({
      commissionId: uuid,
      title: z.string().min(3).max(500),
      description: z.string().max(20000).nullish(),
      externalRef: z.string().min(1).max(200),
      externalNumber: z.string().max(100).nullish(),
      externalDate: dateStr.nullish(),
      requestedMeetingId: uuid.nullish(),
    }),
  );
  const { row, created } = await tx(async (db) => {
    const cm = await one(`SELECT id, chamber_id, name FROM commissions WHERE id = $1 AND chamber_id = $2 AND status = 'active'`, [b.commissionId, c.chamberId], db);
    if (!cm) throw badRequest('کمیسیون یافت نشد یا فعال نیست');
    if (b.requestedMeetingId) {
      const m = await one('SELECT commission_id, status FROM meetings WHERE id = $1', [b.requestedMeetingId], db);
      if (!m || m.commission_id !== cm.id) throw badRequest('جلسه متعلق به این کمیسیون نیست');
      if (!['draft', 'scheduled', 'invitation_sent', 'checkin_open'].includes(m.status)) throw conflict('این جلسه دیگر دستور جلسه جدید نمی‌پذیرد');
    }
    const existing = await one('SELECT * FROM issues WHERE integration_client_id = $1 AND external_ref = $2', [c.id, b.externalRef], db);
    if (existing) return { row: existing, created: false };
    const row = await one(
      `INSERT INTO issues (chamber_id, commission_id, title, description, source, integration_client_id, external_ref, external_number, external_date, requested_meeting_id)
       VALUES ($1,$2,$3,$4,'integration',$5,$6,$7,$8,$9) RETURNING *`,
      [c.chamberId, cm.id, b.title, b.description ?? null, c.id, b.externalRef, b.externalNumber ?? null, b.externalDate ?? null, b.requestedMeetingId ?? null],
      db,
    );
    await audit(db, req, { chamberId: c.chamberId, action: 'issue.created', entity: 'issue', entityId: row.id, after: row, reason: `integration:${c.name}` });
    return { row, created: true };
  });
  if (created) {
    const officers = await query<{ user_id: string }>(
      `SELECT user_id FROM commission_memberships WHERE commission_id = $1 AND status = 'active' AND position IN ('secretary','chair')`,
      [row.commission_id],
    );
    await notify({
      chamberId: row.chamber_id,
      userIds: officers.map((o) => o.user_id),
      event: 'referral.created',
      title: `ارجاع مکاتبه از ${c.name}`,
      body: `${row.title}${row.external_number ? ` (شماره نامه ${row.external_number})` : ''}`,
      data: { issueId: row.id, commissionId: row.commission_id },
    });
  }
  res.status(created ? 201 : 200).json(await referralView(row.id, c.chamberId));
});

async function referralView(id: string, chamberId: string) {
  const i = await one(
    `SELECT i.id, i.commission_id, cm.name AS commission_name, i.title, i.status, i.external_ref, i.external_number, i.requested_meeting_id,
            i.created_at, i.updated_at
       FROM issues i JOIN commissions cm ON cm.id = i.commission_id WHERE i.id = $1 AND i.chamber_id = $2`,
    [id, chamberId],
  );
  if (!i) throw notFound('ارجاع یافت نشد');
  const agenda = await query(
    `SELECT ai.id, ai.title, ai.status, ai.decision, m.id AS meeting_id, m.number AS meeting_number, m.title AS meeting_title,
            m.scheduled_at, m.status AS meeting_status
       FROM agenda_items ai JOIN meetings m ON m.id = ai.meeting_id WHERE ai.issue_id = $1 AND ai.status <> 'removed' ORDER BY m.scheduled_at`,
    [id],
  );
  const resolutions = await query(
    `SELECT r.id, r.number, r.status, r.progress FROM resolutions r JOIN agenda_items ai ON ai.id = r.agenda_item_id WHERE ai.issue_id = $1`,
    [id],
  );
  return { ...i, agenda, resolutions };
}

integrationApiRouter.get('/referrals/:id', requireScope('referrals:write'), async (req, res) => {
  res.json(await referralView(param(req, 'id'), integrationClient(req).chamberId));
});

// ─────────────── Attachments (پیوست — دوطرفه) ───────────────

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: config.maxUploadMb * 1024 * 1024, files: 1 } });

integrationApiRouter.post('/documents', requireScope('documents:write'), upload.single('file'), async (req, res) => {
  const c = integrationClient(req);
  if (!req.file) throw badRequest('فایلی ارسال نشده است');
  const meta = parse(z.object({ issueId: uuid.nullish(), resolutionId: uuid.nullish(), title: z.string().max(200).nullish() }), req.body);
  if (!!meta.issueId === !!meta.resolutionId) throw badRequest('دقیقاً یکی از issueId یا resolutionId لازم است');
  const target = meta.issueId
    ? await one('SELECT id, commission_id FROM issues WHERE id = $1 AND chamber_id = $2 AND integration_client_id = $3', [meta.issueId, c.chamberId, c.id])
    : await one('SELECT id, commission_id FROM resolutions WHERE id = $1 AND chamber_id = $2', [meta.resolutionId, c.chamberId]);
  if (!target) throw notFound('مقصد سند یافت نشد');
  const fileName = Buffer.from(req.file.originalname, 'latin1').toString('utf8');
  const detected = validateFile(fileName, req.file.mimetype, req.file.buffer);
  if ((await scanFile(req.file.buffer)) !== 'clean') throw badRequest('فایل آلوده تشخیص داده شد');
  const stored = await storeFile(c.chamberId, req.file.buffer);
  const row = await tx(async (db) => {
    const r = await one(
      `INSERT INTO documents (id, chamber_id, commission_id, resolution_id, issue_id, kind, title, file_name, mime_type, size_bytes, storage_key, sha256, integration_client_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING id, kind, title, file_name, mime_type, size_bytes, sha256, created_at`,
      [
        stored.id, c.chamberId, target.commission_id, meta.resolutionId ?? null, meta.issueId ?? null, meta.resolutionId ? 'evidence' : 'letter',
        meta.title ?? null, fileName, detected.mime, req.file!.size, stored.storageKey, stored.sha256, c.id,
      ],
      db,
    );
    await audit(db, req, { chamberId: c.chamberId, action: 'document.uploaded', entity: 'document', entityId: r.id, after: r, reason: `integration:${c.name}` });
    return r;
  });
  res.status(201).json(row);
});

integrationApiRouter.get('/documents/:id/content', requireScope('documents:read'), async (req, res) => {
  const c = integrationClient(req);
  // Only documents of meetings that left draft, resolutions, or issues this client referred.
  const d = await one(
    `SELECT d.* FROM documents d
       LEFT JOIN agenda_items ai ON ai.id = d.agenda_item_id
       LEFT JOIN meetings m ON m.id = COALESCE(d.meeting_id, ai.meeting_id)
       LEFT JOIN issues i ON i.id = d.issue_id
      WHERE d.id = $1 AND d.chamber_id = $2
        AND ((m.id IS NOT NULL AND m.status <> 'draft') OR d.resolution_id IS NOT NULL OR i.integration_client_id = $3)`,
    [param(req, 'id'), c.chamberId, c.id],
  );
  if (!d) throw notFound();
  await sendDocument(res, d);
});

integrationApiRouter.get('/events', requireScope('events:read'), async (req, res) => {
  const c = integrationClient(req);
  const after = Math.max(0, Number(req.query.after ?? 0) || 0);
  const limit = Math.min(500, Math.max(1, Number(req.query.limit ?? 100) || 100));
  const items = await eventsAfter(c.id, after, limit);
  res.json({ items, next: items.length ? items[items.length - 1].id : String(after) });
});

// ─────────────────────────────── Admin (chamber admins) ───────────────────────────────

export const integrationsAdminRouter = Router();

const clientSchema = z.object({
  name: z.string().min(2).max(100),
  description: z.string().max(500).nullish(),
  scopes: z.array(z.enum(INTEGRATION_SCOPES)).min(1).default([...INTEGRATION_SCOPES]),
  events: z.array(z.enum(['*', ...INTEGRATION_EVENTS])).min(1).default(['*']),
  webhookUrl: z.string().url().refine((u) => /^https?:\/\//.test(u), 'آدرس باید http یا https باشد').nullish(),
});

const PUBLIC_COLS = `id, chamber_id, name, description, key_prefix, scopes, events, webhook_url, is_active, last_used_at, created_at, updated_at`;

integrationsAdminRouter.get('/integrations', async (req, res) => {
  const u = currentUser(req);
  const chamberId = uuid.parse(req.query.chamberId);
  requireChamberAdmin(u, chamberId);
  const rows = await query(
    `SELECT ${PUBLIC_COLS},
       (SELECT count(*) FROM integration_events e WHERE e.client_id = ic.id AND e.status = 'pending') AS pending_events,
       (SELECT count(*) FROM integration_events e WHERE e.client_id = ic.id AND e.status = 'failed') AS failed_events
       FROM integration_clients ic WHERE chamber_id = $1 ORDER BY created_at`,
    [chamberId],
  );
  res.json({ items: rows, scopes: INTEGRATION_SCOPES, events: INTEGRATION_EVENTS });
});

integrationsAdminRouter.post('/integrations', async (req, res) => {
  const u = currentUser(req);
  const b = body(req, clientSchema.extend({ chamberId: uuid }));
  requireChamberAdmin(u, b.chamberId);
  const key = generateApiKey();
  const webhookSecret = crypto.randomBytes(32).toString('base64url');
  const row = await tx(async (c) => {
    if (await one('SELECT 1 FROM integration_clients WHERE chamber_id = $1 AND name = $2', [b.chamberId, b.name], c)) {
      throw conflict('سامانه‌ای با این نام قبلاً تعریف شده است');
    }
    const r = await one(
      `INSERT INTO integration_clients (chamber_id, name, description, key_prefix, key_hash, scopes, events, webhook_url, webhook_secret_enc, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING ${PUBLIC_COLS}`,
      [b.chamberId, b.name, b.description ?? null, key.prefix, key.hash, b.scopes, b.events, b.webhookUrl ?? null, encryptSecret(webhookSecret), u.id],
      c,
    );
    await audit(c, req, { chamberId: b.chamberId, action: 'integration.created', entity: 'integration_client', entityId: r.id, after: r });
    return r;
  });
  // Secrets are shown once; only hashes / ciphertext are stored.
  res.status(201).json({ ...row, apiKey: key.key, clientId: row.id, webhookSecret });
});

async function adminClient(req: express.Request, id: string, db?: any) {
  const u = currentUser(req);
  const row = await one(`SELECT ${PUBLIC_COLS} FROM integration_clients WHERE id = $1`, [id], db);
  if (!row) throw notFound();
  requireChamberAdmin(u, row.chamber_id);
  return row;
}

integrationsAdminRouter.patch('/integrations/:id', async (req, res) => {
  const b = body(req, clientSchema.partial().extend({ isActive: z.boolean().optional() }));
  const row = await tx(async (c) => {
    const before = await adminClient(req, param(req, 'id'), c);
    const r = await one(
      `UPDATE integration_clients SET name = COALESCE($2, name), description = COALESCE($3, description), scopes = COALESCE($4, scopes),
         events = COALESCE($5, events), webhook_url = CASE WHEN $6::boolean THEN $7 ELSE webhook_url END, is_active = COALESCE($8, is_active),
         updated_at = now() WHERE id = $1 RETURNING ${PUBLIC_COLS}`,
      [before.id, b.name, b.description, b.scopes, b.events, b.webhookUrl !== undefined, b.webhookUrl ?? null, b.isActive],
      c,
    );
    await audit(c, req, { chamberId: r.chamber_id, action: 'integration.updated', entity: 'integration_client', entityId: r.id, before, after: r });
    return r;
  });
  res.json(row);
});

/** Issues a new API key (and webhook secret); the old ones stop working immediately. */
integrationsAdminRouter.post('/integrations/:id/rotate', async (req, res) => {
  const key = generateApiKey();
  const webhookSecret = crypto.randomBytes(32).toString('base64url');
  const row = await tx(async (c) => {
    const before = await adminClient(req, param(req, 'id'), c);
    const r = await one(
      `UPDATE integration_clients SET key_prefix = $2, key_hash = $3, webhook_secret_enc = $4, updated_at = now() WHERE id = $1 RETURNING ${PUBLIC_COLS}`,
      [before.id, key.prefix, key.hash, encryptSecret(webhookSecret)],
      c,
    );
    await audit(c, req, { chamberId: r.chamber_id, action: 'integration.rotated', entity: 'integration_client', entityId: r.id });
    return r;
  });
  res.json({ ...row, apiKey: key.key, clientId: row.id, webhookSecret });
});

integrationsAdminRouter.get('/integrations/:id/events', async (req, res) => {
  const ic = await adminClient(req, param(req, 'id'));
  const { page, pageSize, offset } = pageParams(req);
  const status = typeof req.query.status === 'string' && req.query.status ? req.query.status : null;
  const params = [ic.id, status];
  const where = `client_id = $1 AND ($2::text IS NULL OR status = $2)`;
  const items = await query(
    `SELECT id, event, entity, entity_id, status, attempts, last_error, next_attempt_at, delivered_at, created_at FROM integration_events
      WHERE ${where} ORDER BY id DESC LIMIT ${pageSize} OFFSET ${offset}`,
    params,
  );
  const [{ count }] = await query(`SELECT count(*) FROM integration_events WHERE ${where}`, params);
  res.json(paged(items, count, page, pageSize));
});

integrationsAdminRouter.post('/integrations/:id/events/:eventId/retry', async (req, res) => {
  const ic = await adminClient(req, param(req, 'id'));
  const eventId = z.coerce.number().int().positive().parse(req.params.eventId);
  const r = await one(
    `UPDATE integration_events SET status = 'pending', next_attempt_at = now(), attempts = 0 WHERE id = $1 AND client_id = $2 AND status IN ('failed','skipped') RETURNING id`,
    [eventId, ic.id],
  );
  if (!r) throw notFound();
  res.json({ ok: true });
});

/** Sends a test event (integration.ping) to the client's webhook. */
integrationsAdminRouter.post('/integrations/:id/ping', async (req, res) => {
  const ic = await adminClient(req, param(req, 'id'));
  if (!ic.is_active) throw conflict('سامانه غیرفعال است');
  if (!ic.webhook_url) throw badRequest('آدرس Webhook تعریف نشده است');
  const r = await one(
    `INSERT INTO integration_events (client_id, chamber_id, event, entity, entity_id, payload) VALUES ($1,$2,'integration.ping','integration',$1,$3) RETURNING id`,
    [ic.id, ic.chamber_id, JSON.stringify({ message: 'ping', at: new Date().toISOString() })],
  );
  res.status(202).json({ eventId: String(r!.id) });
});
