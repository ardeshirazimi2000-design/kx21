import crypto from 'node:crypto';
import express, { Router } from 'express';
import { z } from 'zod';
import { config } from '../config.js';
import { currentUser, requirePerm } from '../auth/middleware.js';
import { one, query, tx } from '../db/pool.js';
import { audit } from '../lib/audit.js';
import { encryptText, sha256, timingSafeEqualHex } from '../lib/crypto.js';
import { badRequest, forbidden, notFound, unauthorized } from '../lib/errors.js';
import { scanFile, validateFile } from '../lib/files.js';
import { putFile } from '../lib/storage.js';
import { body, dateStr, paged, pageParams, param, uuid } from '../lib/validate.js';
import {
  loadIntegration,
  meetingsRequest,
  pollEvents,
  queueFeedback,
  receiveEvent,
  referLetterToMeeting,
  syncMeeting,
  syncRecentMeetings,
  verifyWebhookSignature,
  type EventEnvelope,
} from '../integration/meetings.js';
import { loadVisibleLetter } from '../services/access.js';
import { drainJobs, enqueue } from '../services/jobs.js';
import { newTrackingCode } from '../services/letters.js';
import { notify } from '../services/notifications.js';

// ─────────────────────────────── Public endpoints (no user session) ───────────────────────────────

export const integrationPublicRouter = Router();

/** Webhook from the meetings system (HMAC-signed). Raw body is needed for the signature. */
integrationPublicRouter.post('/integrations/meetings/webhook', express.raw({ type: '*/*', limit: '1mb' }), async (req, res) => {
  const i = await loadIntegration();
  if (!i?.webhookSecret) throw notFound();
  const raw = Buffer.isBuffer(req.body) ? req.body.toString('utf8') : '';
  if (!verifyWebhookSignature(i.webhookSecret, req.headers['x-kx-signature'] as string | undefined, raw)) throw unauthorized('امضای رویداد نامعتبر است');
  let e: EventEnvelope;
  try {
    e = JSON.parse(raw);
  } catch {
    throw badRequest('JSON نامعتبر است');
  }
  if (!e?.id || !e.type) throw badRequest('رویداد نامعتبر است');
  const fresh = await receiveEvent(e);
  res.status(202).json({ accepted: true, duplicate: !fresh });
});

/** Letter intake (ایمیل/اسکن/API): gateways post incoming letters with the intake API key. */
integrationPublicRouter.post('/intake/letters', express.json({ limit: '30mb' }), async (req, res) => {
  const key = req.headers['x-api-key'];
  const intake = await one(`SELECT * FROM integrations WHERE kind = 'intake' AND is_active`);
  if (typeof key !== 'string' || !intake?.inbound_key_hash || !timingSafeEqualHex(intake.inbound_key_hash, sha256(key))) throw unauthorized('کلید ورودی نامعتبر است');
  const b = body(
    req,
    z.object({
      subject: z.string().min(3).max(500),
      body: z.string().max(100_000).nullish(),
      externalParty: z.string().max(300).nullish(),
      externalOrg: z.string().max(300).nullish(),
      externalNumber: z.string().max(100).nullish(),
      externalDate: dateStr.nullish(),
      source: z.enum(['email', 'scan', 'api']).default('api'),
      externalRef: z.string().max(300).nullish(),
      attachments: z.array(z.object({ fileName: z.string().min(1).max(255), contentBase64: z.string().min(1) })).max(20).default([]),
    }),
  );
  if (!b.externalParty && !b.externalOrg) throw badRequest('فرستنده نامه مشخص نیست');
  const files: { name: string; mime: string; storageKey: string; sha256: string; size: number }[] = [];
  for (const a of b.attachments) {
    const buf = Buffer.from(a.contentBase64, 'base64');
    if (buf.length > config.maxUploadMb * 1024 * 1024) throw badRequest(`حجم فایل ${a.fileName} بیش از حد مجاز است`);
    const mime = validateFile(a.fileName, buf);
    if ((await scanFile(buf)) !== 'clean') throw badRequest('فایل آلوده تشخیص داده شد');
    files.push({ name: a.fileName, mime, ...(await putFile('letters', buf)) });
  }
  const letter = await tx(async (c) => {
    const sys = (await one(`SELECT id FROM users WHERE username = 'system'`, [], c)) ?? (await one(`INSERT INTO users (username, full_name) VALUES ('system','سامانه (خودکار)') RETURNING id`, [], c));
    // Draft in the secretariat: a person checks it, then registers (numbers) it.
    const l = await one(
      `INSERT INTO letters (kind, tracking_code, subject, body, external_party, external_org, external_number, external_date, source, owner_unit_id, created_by)
       VALUES ('incoming',$1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
      [await newTrackingCode(c), b.subject, b.body ?? null, b.externalParty ?? null, b.externalOrg ?? null, b.externalNumber ?? null, b.externalDate ?? null, b.source, intake.settings?.defaultUnitId ?? null, sys!.id],
      c,
    );
    for (const f of files) {
      await c.query(
        `INSERT INTO letter_attachments (letter_id, group_id, version, file_name, mime_type, size_bytes, storage_key, sha256, source, external_ref)
         VALUES ($1, gen_random_uuid(), 1, $2, $3, $4, $5, $6, $7, $8)`,
        [l.id, f.name, f.mime, f.size, f.storageKey, f.sha256, b.source === 'api' ? 'upload' : b.source, b.externalRef ?? null],
      );
    }
    // Hand it to the secretariat (role holders) through the cartable.
    const sec = await query(`SELECT ur.user_id FROM user_roles ur JOIN roles r ON r.id = ur.role_id WHERE r.key = 'secretariat'`, [], c);
    for (const s of sec) {
      await c.query(`INSERT INTO letter_routing (letter_id, to_user_id, action, instruction) VALUES ($1,$2,'review',$3)`, [l.id, s.user_id, `بررسی و ثبت نامه دریافتی (${b.source})`]);
    }
    await notify({ userIds: sec.map((s) => s.user_id), event: 'routing.assigned', vars: { actor: 'سامانه', number: 'پیش‌نویس', subject: l.subject, action: 'بررسی و ثبت', instruction: '' }, data: { letterId: l.id } }, c);
    await audit(c, null, { action: 'letter.intake', entity: 'letter', entityId: l.id, after: { source: b.source, externalRef: b.externalRef, attachments: files.length }, userId: sys!.id });
    return l;
  });
  res.status(201).json({ id: letter.id, trackingCode: letter.tracking_code, status: letter.status });
});

// ─────────────────────────────── Admin: integration settings ───────────────────────────────

export const integrationRouter = Router();

const webhookPath = '/api/integrations/meetings/webhook';

integrationRouter.get('/integrations', async (req, res) => {
  requirePerm(currentUser(req), 'integration.manage');
  const rows = await query(`SELECT * FROM integrations ORDER BY kind`);
  const inbox = await query(`SELECT status, count(*) AS n FROM integration_inbox GROUP BY status`);
  const feedback = await query(`SELECT status, count(*) AS n FROM resolution_feedback GROUP BY status`);
  res.json({
    items: rows.map(({ client_secret_enc, webhook_secret_enc, inbound_key_hash, ...r }) => ({
      ...r,
      hasApiKey: !!client_secret_enc,
      hasWebhookSecret: !!webhook_secret_enc,
      hasInboundKey: !!inbound_key_hash,
    })),
    webhookUrl: `${config.publicUrl}${webhookPath}`,
    intakeUrl: `${config.publicUrl}/api/intake/letters`,
    inbox: Object.fromEntries(inbox.map((r) => [r.status, r.n])),
    feedback: Object.fromEntries(feedback.map((r) => [r.status, r.n])),
  });
});

integrationRouter.put('/integrations/meetings', async (req, res) => {
  requirePerm(currentUser(req), 'integration.manage');
  const b = body(
    req,
    z.object({
      name: z.string().min(2).max(100).default('سامانه جلسات کمیسیون‌ها'),
      baseUrl: z.string().url().transform((s) => s.replace(/\/+$/, '')),
      clientId: z.string().max(100).nullish(),
      apiKey: z.string().min(10).max(300).optional(),
      webhookSecret: z.string().min(16).max(300).optional(),
      isActive: z.boolean().default(true),
      settings: z
        .object({
          resolutionWorkflowKey: z.string().max(60).optional(),
          defaultUnitId: uuid.optional(),
          autoFeedback: z.boolean().optional(),
          auth: z.enum(['apikey', 'oauth2']).optional(),
          poll: z.boolean().optional(),
        })
        .default({}),
    }),
  );
  await tx(async (c) => {
    await c.query(
      `INSERT INTO integrations (kind, name, base_url, client_id, client_secret_enc, webhook_secret_enc, settings, is_active)
       VALUES ('meetings',$1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (kind) DO UPDATE SET name = EXCLUDED.name, base_url = EXCLUDED.base_url, client_id = EXCLUDED.client_id,
         client_secret_enc = COALESCE(EXCLUDED.client_secret_enc, integrations.client_secret_enc),
         webhook_secret_enc = COALESCE(EXCLUDED.webhook_secret_enc, integrations.webhook_secret_enc),
         settings = EXCLUDED.settings, is_active = EXCLUDED.is_active, updated_at = now()`,
      [b.name, b.baseUrl, b.clientId ?? null, b.apiKey ? encryptText(b.apiKey) : null, b.webhookSecret ? encryptText(b.webhookSecret) : null, JSON.stringify(b.settings), b.isActive],
    );
    await audit(c, req, {
      action: 'integration.configured', entity: 'integration', entityId: 'meetings',
      after: { baseUrl: b.baseUrl, clientId: b.clientId, settings: b.settings, isActive: b.isActive, apiKeyChanged: !!b.apiKey, webhookSecretChanged: !!b.webhookSecret },
    });
  });
  res.status(204).end();
});

integrationRouter.post('/integrations/meetings/test', async (req, res) => {
  requirePerm(currentUser(req), 'integration.manage');
  const me = await meetingsRequest('GET', '/me');
  res.json({ ok: true, remote: me });
});

/** Sync now: recent meetings + pending events. */
integrationRouter.post('/integrations/meetings/sync', async (req, res) => {
  requirePerm(currentUser(req), 'integration.manage');
  try {
    const meetings = await syncRecentMeetings();
    const events = await pollEvents();
    const jobs = await drainJobs(20);
    res.json({ meetings, events, jobs });
  } catch (e) {
    await query(`UPDATE integrations SET last_error = $1 WHERE kind = 'meetings'`, [(e as Error).message.slice(0, 500)]);
    throw e;
  }
});

integrationRouter.get('/integrations/meetings/inbox', async (req, res) => {
  requirePerm(currentUser(req), 'integration.manage');
  const { page, pageSize, offset } = pageParams(req);
  const items = await query(`SELECT id, event_id, event_type, status, error, received_at, processed_at FROM integration_inbox ORDER BY id DESC LIMIT ${pageSize} OFFSET ${offset}`);
  const [{ count }] = await query(`SELECT count(*) FROM integration_inbox`);
  res.json(paged(items, count, page, pageSize));
});

integrationRouter.post('/integrations/meetings/inbox/:id/retry', async (req, res) => {
  requirePerm(currentUser(req), 'integration.manage');
  const id = z.coerce.number().int().positive().parse(req.params.id);
  const r = await one(`UPDATE integration_inbox SET status = 'received', error = NULL WHERE id = $1 AND status = 'failed' RETURNING id`, [id]);
  if (!r) throw notFound();
  await enqueue('meetings.event', { inboxId: id });
  res.status(202).json({ ok: true });
});

/** Intake gateway settings; rotating returns the new API key once. */
integrationRouter.put('/integrations/intake', async (req, res) => {
  requirePerm(currentUser(req), 'integration.manage');
  const b = body(req, z.object({ isActive: z.boolean().default(true), defaultUnitId: uuid.nullish(), rotateKey: z.boolean().default(false) }));
  const key = b.rotateKey ? `oai_${crypto.randomBytes(32).toString('base64url')}` : null;
  await tx(async (c) => {
    await c.query(
      `INSERT INTO integrations (kind, name, inbound_key_hash, settings, is_active) VALUES ('intake','دریافت نامه (ایمیل/اسکن/API)',$1,$2,$3)
       ON CONFLICT (kind) DO UPDATE SET inbound_key_hash = COALESCE(EXCLUDED.inbound_key_hash, integrations.inbound_key_hash),
         settings = EXCLUDED.settings, is_active = EXCLUDED.is_active, updated_at = now()`,
      [key ? sha256(key) : null, JSON.stringify({ defaultUnitId: b.defaultUnitId ?? null }), b.isActive],
    );
    await audit(c, req, { action: 'integration.intake_configured', entity: 'integration', entityId: 'intake', after: { isActive: b.isActive, defaultUnitId: b.defaultUnitId, rotated: !!key } });
  });
  res.json({ apiKey: key });
});

// ─────────────────────────────── Meetings (read model) ───────────────────────────────

integrationRouter.get('/meetings', async (req, res) => {
  requirePerm(currentUser(req), 'meetings.view');
  const { page, pageSize, offset, q } = pageParams(req);
  const upcoming = req.query.upcoming === 'true';
  const where = `($1::text IS NULL OR title ILIKE '%' || $1 || '%' OR commission_name ILIKE '%' || $1 || '%') AND (NOT $2 OR scheduled_at >= now() - interval '1 day')`;
  const items = await query(
    `SELECT external_id AS id, commission_id, commission_name, number, title, scheduled_at, location, status, synced_at,
            jsonb_array_length(COALESCE(data->'resolutions','[]'::jsonb)) AS resolution_count
       FROM meetings_cache WHERE ${where} ORDER BY scheduled_at ${upcoming ? 'ASC' : 'DESC'} LIMIT ${pageSize} OFFSET ${offset}`,
    [q, upcoming],
  );
  const [{ count }] = await query(`SELECT count(*) FROM meetings_cache WHERE ${where}`, [q, upcoming]);
  res.json(paged(items, count, page, pageSize));
});

integrationRouter.get('/meetings/:id', async (req, res) => {
  requirePerm(currentUser(req), 'meetings.view');
  const id = param(req, 'id');
  if (req.query.refresh === '1') await syncMeeting(id);
  const m = await one('SELECT * FROM meetings_cache WHERE external_id = $1', [id]);
  if (!m) throw notFound('جلسه یافت نشد');
  const [resolutions, referrals] = await Promise.all([
    query(`SELECT r.*, l.number AS letter_number FROM resolutions_cache r LEFT JOIN letters l ON l.id = r.letter_id WHERE r.meeting_external_id = $1 ORDER BY r.number`, [id]),
    query(`SELECT mr.*, l.number AS letter_number, l.subject FROM letter_meeting_refs mr JOIN letters l ON l.id = mr.letter_id WHERE mr.requested_meeting_id = $1`, [id]),
  ]);
  res.json({ ...m, id: m.external_id, resolutions, referrals });
});

/** Attachments of a meeting, fetched from the meetings system on demand. */
integrationRouter.get('/meetings/:id/documents/:docId', async (req, res) => {
  requirePerm(currentUser(req), 'meetings.view');
  const m = await one('SELECT data FROM meetings_cache WHERE external_id = $1', [param(req, 'id')]);
  const docId = param(req, 'docId');
  if (!m || !(m.data?.documents ?? []).some((d: any) => d.id === docId)) throw notFound();
  const r = await meetingsRequest<Response>('GET', `/documents/${docId}/content`, undefined, { raw: true });
  res.setHeader('content-type', r.headers.get('content-type') ?? 'application/octet-stream');
  res.setHeader('content-disposition', r.headers.get('content-disposition') ?? 'attachment');
  res.setHeader('x-content-type-options', 'nosniff');
  res.send(Buffer.from(await r.arrayBuffer()));
});

integrationRouter.get('/commissions', async (req, res) => {
  requirePerm(currentUser(req), 'meetings.refer');
  res.json(await meetingsRequest('GET', '/commissions'));
});

// ─────────────────────────────── Resolutions follow-up ───────────────────────────────

integrationRouter.get('/resolutions', async (req, res) => {
  const u = currentUser(req);
  const all = u.can('meetings.view');
  const { page, pageSize, offset, q } = pageParams(req);
  const mine = req.query.mine === 'true' || !all;
  const status = typeof req.query.status === 'string' && req.query.status ? req.query.status.split(',') : null;
  const where = `(NOT $1 OR r.owner_user_id = $2) AND ($3::text[] IS NULL OR r.status = ANY($3)) AND ($4::text IS NULL OR r.text ILIKE '%' || $4 || '%' OR r.number ILIKE '%' || $4 || '%')`;
  const params = [mine, u.id, status, q];
  const items = await query(
    `SELECT r.external_id AS id, r.number, r.text, r.status, r.progress, r.due_date, r.owner_name, r.commission_name, r.letter_id, l.number AS letter_number,
            m.title AS meeting_title, m.number AS meeting_number, (r.due_date < current_date AND r.status NOT IN ('done','cancelled')) AS overdue
       FROM resolutions_cache r LEFT JOIN letters l ON l.id = r.letter_id LEFT JOIN meetings_cache m ON m.external_id = r.meeting_external_id
      WHERE ${where} ORDER BY overdue DESC, r.due_date NULLS LAST LIMIT ${pageSize} OFFSET ${offset}`,
    params,
  );
  const [{ count }] = await query(`SELECT count(*) FROM resolutions_cache r WHERE ${where}`, params);
  res.json(paged(items, count, page, pageSize));
});

integrationRouter.get('/resolutions/:id', async (req, res) => {
  const u = currentUser(req);
  const r = await one(
    `SELECT r.*, l.number AS letter_number, l.subject AS letter_subject, m.title AS meeting_title, m.number AS meeting_number, m.scheduled_at AS meeting_date
       FROM resolutions_cache r LEFT JOIN letters l ON l.id = r.letter_id LEFT JOIN meetings_cache m ON m.external_id = r.meeting_external_id
      WHERE r.external_id = $1`,
    [param(req, 'id')],
  );
  if (!r || (!u.can('meetings.view') && r.owner_user_id !== u.id)) throw notFound('مصوبه یافت نشد');
  const feedback = await query(
    `SELECT f.*, us.full_name AS created_by_name FROM resolution_feedback f LEFT JOIN users us ON us.id = f.created_by WHERE f.resolution_external_id = $1 ORDER BY f.created_at DESC`,
    [r.external_id],
  );
  res.json({ ...r, id: r.external_id, feedback, canFollow: r.owner_user_id === u.id || u.can('resolutions.follow') });
});

integrationRouter.post('/resolutions/:id/feedback', async (req, res) => {
  const u = currentUser(req);
  const b = body(req, z.object({ progress: z.number().int().min(0).max(100), note: z.string().min(3).max(4000), submit: z.boolean().default(false) }));
  const row = await tx(async (c) => {
    const r = await one('SELECT * FROM resolutions_cache WHERE external_id = $1', [param(req, 'id')], c);
    if (!r) throw notFound('مصوبه یافت نشد');
    if (r.owner_user_id !== u.id && !u.can('resolutions.follow')) throw forbidden();
    if (['done', 'cancelled'].includes(r.status)) throw badRequest('این مصوبه بسته شده است');
    const f = await queueFeedback(c, { resolutionId: r.external_id, letterId: r.letter_id, progress: b.progress, note: `${b.note} — ${u.fullName}`, submit: b.submit, userId: u.id });
    await audit(c, req, { action: 'resolution.feedback_queued', entity: 'resolution', entityId: r.external_id, after: b });
    return f;
  });
  res.status(202).json(row);
});

// ─────────────────────────────── Letter → meeting referral ───────────────────────────────

integrationRouter.post('/letters/:id/meeting-referrals', async (req, res) => {
  const u = currentUser(req);
  requirePerm(u, 'meetings.refer');
  const b = body(req, z.object({ commissionId: uuid, requestedMeetingId: uuid.nullish(), note: z.string().max(4000).nullish(), includeAttachments: z.boolean().default(true) }));
  const letter = await loadVisibleLetter(u, param(req, 'id'));
  const row = await referLetterToMeeting(u, letter, b);
  await tx((c) => audit(c, req, { action: 'letter.referred_to_meeting', entity: 'letter', entityId: letter.id, after: { commissionId: b.commissionId, issueId: row.external_issue_id } }));
  res.status(201).json(row);
});
