import crypto from 'node:crypto';
import express, { Router, type Request } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { currentUser, requirePerm, type AuthUser } from '../auth/middleware.js';
import { config } from '../config.js';
import { one, query, tx } from '../db/pool.js';
import { audit } from '../lib/audit.js';
import { badRequest, conflict, forbidden, HttpError, notFound } from '../lib/errors.js';
import { scanFile, sendFile, upload, uploadedName, validateFile } from '../lib/files.js';
import { getFile, putFile } from '../lib/storage.js';
import { body, param, uuid } from '../lib/validate.js';
import { deliverMessage, directKey, memberConversation, memberIds, MESSAGE_COLS, messageById, systemMessage } from '../services/communications.js';
import { enqueue } from '../services/jobs.js';
import { pbx, syncPbxSoon } from '../services/pbx.js';
import { DEFAULT_INBOUND, inboundSettings, IVR_DAYS, ivrSettings, newSipSecret, SOUND_KINDS, wavProblem, type SoundKind } from '../services/pbxConfig.js';
import { encryptText } from '../lib/crypto.js';
import { logger } from '../lib/logger.js';
import { emitToUsers, isOnline } from '../services/realtime.js';

/**
 * Communications module (ارتباطات سازمانی): organisational phone directory, extensions registry and messenger.
 * The messenger is independent of the PBX: it keeps working when the telephone exchange is down or not set up.
 * Directory and messenger are open to every signed-in user (like the org chart); managing extensions and
 * organisational groups needs its own permission. Nobody — administrators included — has an endpoint to read
 * conversations they are not a member of.
 */
export const communicationsRouter = Router();

const limiter = (limit: number) =>
  rateLimit({
    windowMs: 60 * 1000,
    limit: config.isTest ? 100000 : limit,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    keyGenerator: (req) => req.user!.id,
  });
const sendLimiter = limiter(60);
const searchLimiter = limiter(30);
const maxAttachmentMb = Math.min(config.maxUploadMb, Number(process.env.COMM_MAX_ATTACHMENT_MB ?? 20) || 20);

communicationsRouter.get('/communications/status', (_req, res) => {
  const a = pbx();
  res.json({ pbx: { kind: a.kind, configured: a.configured, connected: a.connected() }, realtime: true, maxAttachmentMb });
});

/** An extension row without its (encrypted) SIP secret: for responses and the audit trail. */
const pub = ({ sip_secret_enc: _s, ...r }: any) => r;

// ─────────────── Directory (دفترچه تلفن سازمانی) ───────────────

/**
 * Active people with their current position and unit, live extensions and whether they are online.
 * Only work details: no e-mail, mobile or national id.
 */
communicationsRouter.get('/communications/directory', async (req, res) => {
  const q = typeof req.query.q === 'string' ? req.query.q.trim().slice(0, 100) : '';
  const unitId = typeof req.query.unitId === 'string' && uuid.safeParse(req.query.unitId).success ? req.query.unitId : null;
  const rows = await query(
    `WITH RECURSIVE sub AS (SELECT id FROM org_units WHERE id = $2::uuid UNION SELECT u.id FROM org_units u JOIN sub ON u.parent_id = sub.id)
     SELECT u.id, u.full_name, p.title AS position_title, ou.id AS unit_id, ou.name AS unit_name,
            COALESCE((SELECT json_agg(json_build_object('number', e.extension_number, 'label', e.label, 'status', e.status) ORDER BY e.extension_number)
                        FROM communication_extensions e WHERE e.user_id = u.id AND e.status IN ('active', 'draft', 'provisioning')), '[]'::json) AS extensions
       FROM users u
       LEFT JOIN LATERAL (SELECT up.position_id FROM user_positions up WHERE up.user_id = u.id AND (up.end_date IS NULL OR up.end_date >= current_date)
                           ORDER BY up.is_primary DESC LIMIT 1) cur ON true
       LEFT JOIN positions p ON p.id = cur.position_id
       LEFT JOIN org_units ou ON ou.id = p.unit_id
      WHERE u.is_active AND u.username <> 'system'
        AND ($2::uuid IS NULL OR ou.id IN (SELECT id FROM sub))
        AND ($1 = '' OR u.full_name ILIKE '%' || $1 || '%' OR p.title ILIKE '%' || $1 || '%' OR ou.name ILIKE '%' || $1 || '%'
             OR EXISTS (SELECT 1 FROM communication_extensions e WHERE e.user_id = u.id AND e.status <> 'disabled' AND e.extension_number LIKE $1 || '%'))
      ORDER BY ou.name NULLS LAST, p.is_manager DESC NULLS LAST, u.full_name
      LIMIT 500`,
    [q, unitId],
  );
  res.json(rows.map((r) => ({ ...r, online: isOnline(r.id) })));
});

// ─────────────── Extensions (شماره‌های داخلی) ───────────────

const EXT_COLS = `e.id, e.user_id, u.full_name, u.is_active AS user_active, e.extension_number, e.label, e.status, e.provision_source, e.last_error,
  e.last_registered_at, e.created_at, e.updated_at, e.disabled_at,
  (SELECT ou.name FROM user_positions up JOIN positions p ON p.id = up.position_id JOIN org_units ou ON ou.id = p.unit_id
    WHERE up.user_id = u.id AND (up.end_date IS NULL OR up.end_date >= current_date) ORDER BY up.is_primary DESC LIMIT 1) AS unit_name`;

communicationsRouter.get('/communications/extensions/mine', async (req, res) => {
  const u = currentUser(req);
  res.json(
    await query(`SELECT ${EXT_COLS} FROM communication_extensions e JOIN users u ON u.id = e.user_id WHERE e.user_id = $1 ORDER BY e.created_at DESC`, [u.id]),
  );
});

communicationsRouter.get('/communications/extensions', async (req, res) => {
  requirePerm(currentUser(req), 'communications.extension.manage');
  const q = typeof req.query.q === 'string' ? req.query.q.trim().slice(0, 100) : '';
  const status = typeof req.query.status === 'string' && req.query.status ? req.query.status : null;
  res.json(
    await query(
      `SELECT ${EXT_COLS} FROM communication_extensions e JOIN users u ON u.id = e.user_id
        WHERE ($1 = '' OR e.extension_number LIKE $1 || '%' OR u.full_name ILIKE '%' || $1 || '%') AND ($2::text IS NULL OR e.status = $2)
        ORDER BY e.status = 'disabled', e.extension_number`,
      [q, status],
    ),
  );
});

const extNumber = z
  .string()
  .trim()
  .regex(/^[0-9]{2,6}$/, 'شماره داخلی باید ۲ تا ۶ رقم باشد');
const numberTaken = (e: any) => {
  if (e?.code === '23505') throw conflict('این شماره داخلی در حال استفاده است', 'extension_taken');
  throw e;
};

/** Assigns a number to a user. existsOnPbx: the extension already exists on the PBX, so it is recorded as active at once. */
communicationsRouter.post('/communications/extensions', async (req, res) => {
  const u = currentUser(req);
  requirePerm(u, 'communications.extension.manage');
  const b = body(req, z.object({ userId: uuid, extensionNumber: extNumber, label: z.string().trim().max(100).nullish(), existsOnPbx: z.boolean().optional() }));
  const row = await tx(async (c) => {
    const target = await one(`SELECT id FROM users WHERE id = $1 AND is_active AND username <> 'system'`, [b.userId], c);
    if (!target) throw badRequest('کاربر یافت نشد یا غیرفعال است');
    const r = await one(
      `INSERT INTO communication_extensions (user_id, extension_number, label, status, provision_source, created_by)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [b.userId, b.extensionNumber, b.label || null, b.existsOnPbx ? 'active' : 'draft', b.existsOnPbx ? 'manual' : null, u.id],
      c,
    ).catch(numberTaken);
    await audit(c, req, { action: 'communications.extension_created', entity: 'communication_extension', entityId: r.id, after: pub(r) });
    return pub(r);
  });
  res.status(201).json(row);
});

/** Allowed status changes; 'active' by hand means an administrator confirms it exists on the PBX. 'disabled' is final. */
const TRANSITIONS: Record<string, string[]> = {
  draft: ['active', 'disabled'],
  provisioning: ['disabled'],
  failed: ['draft', 'active', 'disabled'],
  active: ['suspended', 'disabled'],
  suspended: ['active', 'disabled'],
  disabled: [],
};

communicationsRouter.patch('/communications/extensions/:id', async (req, res) => {
  requirePerm(currentUser(req), 'communications.extension.manage');
  const id = param(req, 'id');
  const b = body(
    req,
    z.object({
      label: z.string().trim().max(100).nullish(),
      status: z.enum(['draft', 'active', 'suspended', 'disabled']).optional(),
      reason: z.string().trim().max(500).optional(),
    }),
  );
  const row = await tx(async (c) => {
    const before = await one('SELECT * FROM communication_extensions WHERE id = $1 FOR UPDATE', [id], c);
    if (!before) throw notFound();
    if (before.status === 'disabled') throw conflict('داخلی غیرفعال‌شده قابل تغییر نیست؛ در صورت نیاز داخلی جدید ثبت کنید');
    const status = b.status ?? before.status;
    if (status !== before.status && !TRANSITIONS[before.status].includes(status)) throw conflict('این تغییر وضعیت برای داخلی مجاز نیست', 'bad_transition');
    if (status === 'active' && before.status !== 'suspended') {
      const owner = await one('SELECT is_active FROM users WHERE id = $1', [before.user_id], c);
      if (!owner?.is_active) throw conflict('کاربر این داخلی غیرفعال است');
    }
    const manual = status === 'active' && ['draft', 'failed'].includes(before.status);
    const r = await one(
      `UPDATE communication_extensions SET label = $2, status = $3, provision_source = CASE WHEN $4 THEN 'manual' ELSE provision_source END,
         last_error = CASE WHEN $3 = 'active' OR $3 = 'draft' THEN NULL ELSE last_error END,
         disabled_at = CASE WHEN $3 = 'disabled' THEN now() ELSE disabled_at END, updated_at = now()
        WHERE id = $1 RETURNING *`,
      [id, b.label !== undefined ? b.label || null : before.label, status, manual],
      c,
    );
    await audit(c, req, {
      action: 'communications.extension_updated',
      entity: 'communication_extension',
      entityId: id,
      before: pub(before),
      after: pub(r),
      reason: b.reason ?? null,
    });
    return pub(r);
  });
  // The PBX follows: a disabled or suspended number stops working, a resumed one works again.
  if (row.status === 'disabled')
    await pbx()
      .disableExtension({ id: row.id, number: row.extension_number })
      .catch(() => undefined);
  else syncPbxSoon();
  res.json(row);
});

/** Queues creation of the extension on the PBX (idempotent: a queued or running request is not queued again). */
communicationsRouter.post('/communications/extensions/:id/provision', async (req, res) => {
  requirePerm(currentUser(req), 'communications.extension.manage');
  const id = param(req, 'id');
  if (!pbx().configured)
    throw new HttpError(409, 'pbx_not_configured', 'مرکز تلفن هنوز به رسا متصل نشده است؛ داخلی را در مرکز تلفن بسازید و «تأیید دستی» را بزنید');
  const row = await tx(async (c) => {
    const before = await one('SELECT * FROM communication_extensions WHERE id = $1 FOR UPDATE', [id], c);
    if (!before) throw notFound();
    if (before.status === 'provisioning') return pub(before);
    if (!['draft', 'failed'].includes(before.status)) throw conflict('فقط داخلی پیش‌نویس یا ناموفق قابل ایجاد در مرکز تلفن است', 'bad_transition');
    const r = await one(
      `UPDATE communication_extensions SET status = 'provisioning', last_error = NULL, updated_at = now() WHERE id = $1 RETURNING *`,
      [id],
      c,
    );
    await enqueue('communications.provision', { extensionId: id }, c, { maxAttempts: 5 });
    await audit(c, req, { action: 'communications.extension_provision_requested', entity: 'communication_extension', entityId: id, before: pub(before), after: pub(r) });
    return pub(r);
  });
  res.status(202).json(row);
});

/**
 * Generates a new SIP password for the extension and shows it once (to configure the phone); the old one stops
 * working at the next PBX reload. The password is stored only encrypted and never listed anywhere.
 */
communicationsRouter.post('/communications/extensions/:id/credentials', async (req, res) => {
  requirePerm(currentUser(req), 'communications.extension.manage');
  const id = param(req, 'id');
  const secret = newSipSecret();
  const row = await tx(async (c) => {
    const r = await one(
      `UPDATE communication_extensions SET sip_secret_enc = $2, updated_at = now() WHERE id = $1 AND status <> 'disabled' RETURNING id, extension_number`,
      [id, encryptText(secret)],
      c,
    );
    if (!r) throw notFound();
    await audit(c, req, { action: 'communications.extension_secret_reset', entity: 'communication_extension', entityId: id });
    return r;
  });
  syncPbxSoon();
  res.setHeader('cache-control', 'no-store');
  res.json({ username: row.extension_number, password: secret });
});

/** Where calls from the city line ring (one or more extensions together). */
communicationsRouter.get('/communications/settings/inbound', async (req, res) => {
  requirePerm(currentUser(req), 'communications.settings.manage');
  res.json(await inboundSettings());
});

communicationsRouter.put('/communications/settings/inbound', async (req, res) => {
  const u = currentUser(req);
  requirePerm(u, 'communications.settings.manage');
  const b = body(req, z.object({ targets: z.array(extNumber).max(20), ringSeconds: z.number().int().min(10).max(120).default(DEFAULT_INBOUND.ringSeconds) }));
  const targets = [...new Set(b.targets)];
  const live = await query(`SELECT extension_number FROM communication_extensions WHERE extension_number = ANY($1::text[]) AND status = 'active'`, [targets]);
  if (live.length !== targets.length) throw badRequest('همه مقصدها باید داخلی فعال باشند');
  const value = { targets, ringSeconds: b.ringSeconds };
  await tx(async (c) => {
    const before = await one(`SELECT value FROM communication_settings WHERE key = 'inbound'`, [], c);
    await c.query(
      `INSERT INTO communication_settings (key, value, updated_by) VALUES ('inbound', $1, $2)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = now()`,
      [JSON.stringify(value), u.id],
    );
    await audit(c, req, { action: 'communications.settings_updated', entity: 'communication_settings', entityId: null, before: before?.value ?? null, after: value });
  });
  syncPbxSoon();
  res.json(value);
});

// ─────────────── Auto-attendant (تلفن گویا) ───────────────

const hhmm = z.string().regex(/^([01][0-9]|2[0-3]):[0-5][0-9]$/, 'ساعت نامعتبر است');

communicationsRouter.get('/communications/settings/ivr', async (req, res) => {
  requirePerm(currentUser(req), 'communications.settings.manage');
  const sounds = await query(`SELECT key, updated_at, octet_length(data)::int AS bytes FROM communication_sounds ORDER BY key`);
  const extensions = await query(
    `SELECT e.extension_number AS number, u.full_name AS name FROM communication_extensions e JOIN users u ON u.id = e.user_id
      WHERE e.status = 'active' AND u.is_active ORDER BY e.extension_number`,
  );
  const inbound = await inboundSettings();
  res.json({
    ...(await ivrSettings()),
    sounds: Object.fromEntries(sounds.map((r) => [r.key, { updatedAt: r.updated_at, seconds: Math.round(r.bytes / 16000) }])),
    extensions,
    operatorTargets: inbound.targets,
  });
});

communicationsRouter.put('/communications/settings/ivr', async (req, res) => {
  const u = currentUser(req);
  requirePerm(u, 'communications.settings.manage');
  const b = body(
    req,
    z.object({
      enabled: z.boolean(),
      options: z
        .array(z.object({ digit: z.string().regex(/^[0-9]$/), label: z.string().trim().max(60).default(''), targets: z.array(extNumber).min(1).max(20) }))
        .max(10),
      directDial: z.boolean(),
      waitSeconds: z.number().int().min(2).max(30),
      ringSeconds: z.number().int().min(10).max(120),
      workHours: z.object({ days: z.array(z.enum(IVR_DAYS)).max(7), start: hhmm, end: hhmm }),
      afterHoursEnabled: z.boolean(),
    }),
  );
  if (new Set(b.options.map((o) => o.digit)).size !== b.options.length) throw badRequest('هر کلید فقط یک بار می‌تواند به کار رود');
  if (b.workHours.start >= b.workHours.end) throw badRequest('ساعت پایان کار باید بعد از ساعت شروع باشد');
  const options = b.options.map((o) => ({ ...o, targets: [...new Set(o.targets)] }));
  const wanted = [...new Set(options.flatMap((o) => o.targets))];
  const live = await query(`SELECT extension_number FROM communication_extensions WHERE extension_number = ANY($1::text[]) AND status = 'active'`, [wanted]);
  if (live.length !== wanted.length) throw badRequest('همه مقصدها باید داخلی فعال باشند');
  if (b.enabled && !(await one(`SELECT 1 FROM communication_sounds WHERE key = 'greeting'`))) throw badRequest('پیش از روشن کردن تلفن گویا، پیام خوشامد را ضبط یا بارگذاری کنید');
  const value = { ...b, options, workHours: { ...b.workHours, days: IVR_DAYS.filter((d) => b.workHours.days.includes(d)) } };
  await tx(async (c) => {
    const before = await one(`SELECT value FROM communication_settings WHERE key = 'ivr'`, [], c);
    await c.query(
      `INSERT INTO communication_settings (key, value, updated_by) VALUES ('ivr', $1, $2)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = now()`,
      [JSON.stringify(value), u.id],
    );
    await audit(c, req, { action: 'communications.settings_updated', entity: 'communication_settings', entityId: null, before: before?.value ?? null, after: value });
  });
  syncPbxSoon();
  res.json(value);
});

const soundKind = (req: Request): SoundKind => {
  const k = req.params.kind as SoundKind;
  if (!SOUND_KINDS.includes(k)) throw notFound();
  return k;
};

/** A prompt as 8 kHz mono 16-bit PCM WAV (the page converts recordings and uploads to it). */
communicationsRouter.put('/communications/ivr/sounds/:kind', express.raw({ type: 'audio/wav', limit: '3mb' }), async (req, res) => {
  const u = currentUser(req);
  requirePerm(u, 'communications.settings.manage');
  const kind = soundKind(req);
  if (!Buffer.isBuffer(req.body)) throw badRequest('فایل صوتی WAV ارسال نشده است');
  const problem = wavProblem(req.body);
  if (problem) throw badRequest(problem);
  await tx(async (c) => {
    await c.query(
      `INSERT INTO communication_sounds (key, data, updated_by) VALUES ($1, $2, $3)
       ON CONFLICT (key) DO UPDATE SET data = EXCLUDED.data, updated_by = EXCLUDED.updated_by, updated_at = now()`,
      [kind, req.body, u.id],
    );
    await audit(c, req, { action: 'communications.sound_uploaded', entity: 'communication_sounds', entityId: null, after: { kind, bytes: req.body.length } });
  });
  syncPbxSoon();
  res.json({ kind, seconds: Math.round(req.body.length / 16000) });
});

communicationsRouter.get('/communications/ivr/sounds/:kind', async (req, res) => {
  requirePerm(currentUser(req), 'communications.settings.manage');
  const r = await one(`SELECT data FROM communication_sounds WHERE key = $1`, [soundKind(req)]);
  if (!r) throw notFound();
  res.setHeader('content-type', 'audio/wav');
  res.setHeader('cache-control', 'no-store');
  res.setHeader('x-content-type-options', 'nosniff');
  res.send(r.data);
});

communicationsRouter.delete('/communications/ivr/sounds/:kind', async (req, res) => {
  const u = currentUser(req);
  requirePerm(u, 'communications.settings.manage');
  const kind = soundKind(req);
  if (kind === 'greeting' && (await ivrSettings()).enabled) throw badRequest('تا تلفن گویا روشن است، پیام خوشامد را نمی‌توان حذف کرد');
  await tx(async (c) => {
    const r = await c.query(`DELETE FROM communication_sounds WHERE key = $1`, [kind]);
    if (r.rowCount) await audit(c, req, { action: 'communications.sound_deleted', entity: 'communication_sounds', entityId: null, before: { kind } });
  });
  syncPbxSoon();
  res.status(204).end();
});

// ─────────────── Calls (تماس‌ها) ───────────────

/** Call history: one's own calls; everyone's with communications.report.view (?scope=all). */
communicationsRouter.get('/communications/calls', async (req, res) => {
  const u = currentUser(req);
  const all = req.query.scope === 'all';
  if (all) requirePerm(u, 'communications.report.view');
  const page = Math.max(1, Number(req.query.page ?? 1) || 1);
  const pageSize = Math.min(100, Math.max(1, Number(req.query.pageSize ?? 30) || 30));
  const pick = (k: string, allowed: string[]) => (typeof req.query[k] === 'string' && allowed.includes(req.query[k] as string) ? (req.query[k] as string) : null);
  const direction = pick('direction', ['internal', 'inbound', 'outbound']);
  const disposition = pick('disposition', ['answered', 'missed', 'busy', 'failed']);
  const date = (k: string) => (typeof req.query[k] === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(req.query[k] as string) ? (req.query[k] as string) : null);
  const where = `($1 OR c.caller_user_id = $2 OR c.callee_user_id = $2) AND ($3::text IS NULL OR c.direction = $3) AND ($4::text IS NULL OR c.disposition = $4)
     AND ($5::date IS NULL OR c.started_at >= $5::date) AND ($6::date IS NULL OR c.started_at < $6::date + 1)`;
  const params = [all, u.id, direction, disposition, date('from'), date('to')];
  const [{ total }] = await query(`SELECT count(*)::int AS total FROM communication_calls c WHERE ${where}`, params);
  const items = await query(
    `SELECT c.id, c.direction, c.caller_number, c.caller_name, c.callee_number, c.caller_user_id, c.callee_user_id, cu.full_name AS caller_user_name,
            eu.full_name AS callee_user_name, c.started_at, c.answered_at, c.ended_at, c.disposition, c.duration_seconds
       FROM communication_calls c LEFT JOIN users cu ON cu.id = c.caller_user_id LEFT JOIN users eu ON eu.id = c.callee_user_id
      WHERE ${where} ORDER BY c.started_at DESC LIMIT $7 OFFSET $8`,
    [...params, pageSize, (page - 1) * pageSize],
  );
  res.json({ items, total, page, pageSize });
});

/** City-line numbers that may be dialled (after the 9 prefix): 8-digit local, 0 + 10 digits (other cities, mobile), emergency. */
export const EXTERNAL_NUMBER = /^9(?:[2-9][0-9]{7}|0[1-9][0-9]{9}|11[05]|125)$/;
const originateLimiter = limiter(10);

/** Click-to-call: the caller's own phone rings first, then the destination. Destinations are checked here and by the dial plan. */
communicationsRouter.post('/communications/calls/originate', originateLimiter, async (req, res) => {
  const u = currentUser(req);
  const b = body(req, z.object({ to: z.string().trim().regex(/^[0-9]{2,13}$/, 'شماره مقصد معتبر نیست'), extensionId: uuid.optional() }));
  const a = pbx();
  if (!a.configured) throw new HttpError(409, 'pbx_not_configured', 'مرکز تلفن به رسا متصل نیست');
  if (!a.connected()) throw new HttpError(503, 'pbx_unavailable', 'ارتباط با مرکز تلفن برقرار نیست؛ کمی بعد دوباره تلاش کنید');
  const mine = await one(
    `SELECT extension_number FROM communication_extensions WHERE user_id = $1 AND status = 'active' AND ($2::uuid IS NULL OR id = $2) ORDER BY created_at LIMIT 1`,
    [u.id, b.extensionId ?? null],
  );
  if (!mine) throw conflict('شما داخلی فعال ندارید', 'no_extension');
  const internal = await one(`SELECT 1 FROM communication_extensions WHERE extension_number = $1 AND status = 'active'`, [b.to]);
  if (!internal) {
    if (!EXTERNAL_NUMBER.test(b.to)) throw badRequest('این شماره قابل گرفتن نیست؛ برای خط شهری ابتدا ۹ را بگیرید');
    const emergency = /^91(?:1[05]|25)$/.test(b.to);
    if (!emergency && !u.can('communications.call.external')) throw forbidden('مجوز تماس با خط شهری را ندارید');
  }
  if (b.to === mine.extension_number) throw badRequest('تماس با داخلی خودتان ممکن نیست');
  // The call row is opened here (the PBX events then update it), so the history shows the dialled number even when the
  // call never reaches the destination (busy line, gateway down).
  const callId = `rasa-${crypto.randomUUID()}`;
  const row = await one(
    `INSERT INTO communication_calls (unique_call_id, direction, caller_number, caller_name, callee_number, caller_user_id, callee_user_id)
     VALUES ($1,$2,$3,$4,$5,$6,(SELECT user_id FROM communication_extensions WHERE extension_number = $5 AND status = 'active' AND $2 = 'internal')) RETURNING id`,
    [callId, internal ? 'internal' : 'outbound', mine.extension_number, u.fullName.slice(0, 80), internal ? b.to : b.to.slice(1), u.id],
  );
  await query(`INSERT INTO communication_call_events (call_id, event_type, event_key, payload) VALUES ($1,'started',$2,'{"origin":"click_to_call"}')`, [row.id, callId]);
  await a.originate({ fromExtension: mine.extension_number, to: b.to, callerName: u.fullName, userId: u.id, callId }).catch(async (e) => {
    logger.warn({ err: (e as Error).message, from: mine.extension_number }, 'originate refused by the PBX');
    await query(`UPDATE communication_calls SET ended_at = now(), disposition = 'failed', duration_seconds = 0 WHERE id = $1`, [row.id]);
    throw new HttpError(503, 'pbx_unavailable', 'مرکز تلفن درخواست تماس را نپذیرفت');
  });
  res.status(202).json({ callId: row.id, from: mine.extension_number, to: b.to });
});

// ─────────────── Messenger (پیام‌رسان سازمانی) ───────────────

const canManageGroups = (u: AuthUser) => u.can('communications.conversation.manage');

communicationsRouter.get('/communications/conversations', async (req, res) => {
  const u = currentUser(req);
  const rows = await query(
    `SELECT c.id, c.conversation_type, c.is_archived, c.created_at, c.last_message_at, m.member_role, m.muted, m.last_read_at,
            CASE WHEN c.conversation_type = 'direct' THEN ou.full_name ELSE c.title END AS title,
            CASE WHEN c.conversation_type = 'direct' THEN ou.id END AS other_user_id,
            (SELECT count(*)::int FROM communication_conversation_members x WHERE x.conversation_id = c.id AND x.left_at IS NULL) AS member_count,
            (SELECT count(*)::int FROM communication_messages msg WHERE msg.conversation_id = c.id AND msg.deleted_at IS NULL AND msg.message_type <> 'system'
                AND msg.sender_user_id IS DISTINCT FROM $1 AND msg.created_at > COALESCE(m.last_read_at, m.joined_at)) AS unread,
            (SELECT json_build_object('body', CASE WHEN l.deleted_at IS NULL THEN left(l.body, 120) ELSE '' END, 'type', l.message_type,
                    'deleted', l.deleted_at IS NOT NULL, 'sender_name', ls.full_name, 'created_at', l.created_at)
               FROM communication_messages l LEFT JOIN users ls ON ls.id = l.sender_user_id
              WHERE l.conversation_id = c.id ORDER BY l.created_at DESC LIMIT 1) AS last_message
       FROM communication_conversations c
       JOIN communication_conversation_members m ON m.conversation_id = c.id AND m.user_id = $1 AND m.left_at IS NULL
       LEFT JOIN communication_conversation_members om ON c.conversation_type = 'direct' AND om.conversation_id = c.id AND om.user_id <> $1
       LEFT JOIN users ou ON ou.id = om.user_id
      ORDER BY COALESCE(c.last_message_at, c.created_at) DESC`,
    [u.id],
  );
  res.json(rows.map((r) => ({ ...r, other_online: r.other_user_id ? isOnline(r.other_user_id) : undefined })));
});

const createSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('direct'), userId: uuid }),
  z.object({
    type: z.literal('group'),
    title: z.string().trim().min(2).max(150),
    description: z.string().trim().max(1000).nullish(),
    ownerUnitId: uuid.nullish(),
    memberIds: z.array(uuid).max(500).default([]),
  }),
]);

/** A direct conversation is opened (found or created) by anyone; an organisational group needs the permission. */
communicationsRouter.post('/communications/conversations', async (req, res) => {
  const u = currentUser(req);
  const b = body(req, createSchema);
  if (b.type === 'direct') {
    if (b.userId === u.id) throw badRequest('گفت‌وگو با خودتان ممکن نیست');
    const key = directKey(u.id, b.userId);
    const existing = await one('SELECT id FROM communication_conversations WHERE direct_key = $1', [key]);
    if (existing) {
      res.json({ id: existing.id, created: false });
      return;
    }
    const other = await one(`SELECT id FROM users WHERE id = $1 AND is_active AND username <> 'system'`, [b.userId]);
    if (!other) throw badRequest('کاربر یافت نشد یا غیرفعال است');
    const id = await tx(async (c) => {
      const r = await one(
        `INSERT INTO communication_conversations (conversation_type, direct_key, created_by) VALUES ('direct', $1, $2)
         ON CONFLICT (direct_key) DO NOTHING RETURNING id`,
        [key, u.id],
        c,
      );
      if (!r) return (await one('SELECT id FROM communication_conversations WHERE direct_key = $1', [key], c))!.id as string;
      await c.query(`INSERT INTO communication_conversation_members (conversation_id, user_id) VALUES ($1, $2), ($1, $3)`, [r.id, u.id, b.userId]);
      return r.id as string;
    });
    res.status(201).json({ id, created: true });
    return;
  }
  if (!canManageGroups(u)) throw forbidden('ایجاد گروه سازمانی نیاز به مجوز مدیریت گفت‌وگوها دارد');
  const ids = [...new Set(b.memberIds.filter((m) => m !== u.id))];
  const id = await tx(async (c) => {
    const valid = await query(`SELECT id, full_name FROM users WHERE id = ANY($1::uuid[]) AND is_active AND username <> 'system'`, [ids], c);
    if (valid.length !== ids.length) throw badRequest('برخی اعضا یافت نشدند یا غیرفعال‌اند');
    const r = await one(
      `INSERT INTO communication_conversations (conversation_type, title, description, owner_unit_id, created_by) VALUES ('group', $1, $2, $3, $4) RETURNING *`,
      [b.title, b.description || null, b.ownerUnitId ?? null, u.id],
      c,
    );
    await c.query(`INSERT INTO communication_conversation_members (conversation_id, user_id, member_role) VALUES ($1, $2, 'owner')`, [r.id, u.id]);
    for (const m of ids) await c.query(`INSERT INTO communication_conversation_members (conversation_id, user_id) VALUES ($1, $2)`, [r.id, m]);
    await systemMessage(c, r.id, `${u.fullName} گروه «${b.title}» را ساخت`);
    await audit(c, req, {
      action: 'communications.group_created',
      entity: 'communication_conversation',
      entityId: r.id,
      after: { ...r, members: [u.id, ...ids] },
    });
    return r.id as string;
  });
  emitToUsers([u.id, ...ids], 'ConversationUpdated', { conversationId: id });
  res.status(201).json({ id, created: true });
});

async function memberOr404(u: AuthUser, id: string) {
  const conv = await memberConversation(u.id, id);
  if (!conv) throw notFound('گفت‌وگو یافت نشد');
  return conv;
}

/** Group settings and membership: the group's owners, or holders of the management permission who are members. */
const requireGroupAdmin = (u: AuthUser, conv: any) => {
  if (conv.conversation_type !== 'group') throw badRequest('این عملیات فقط برای گروه است');
  if (conv.member_role !== 'owner' && !canManageGroups(u)) throw forbidden('فقط مالک گروه می‌تواند اعضا و تنظیمات گروه را تغییر دهد');
};

communicationsRouter.get('/communications/conversations/:id', async (req, res) => {
  const u = currentUser(req);
  const conv = await memberOr404(u, param(req, 'id'));
  const members = await query(
    `SELECT m.user_id, u.full_name, m.member_role, m.joined_at, m.last_read_at,
            (SELECT p.title FROM user_positions up JOIN positions p ON p.id = up.position_id
              WHERE up.user_id = u.id AND (up.end_date IS NULL OR up.end_date >= current_date) ORDER BY up.is_primary DESC LIMIT 1) AS position_title
       FROM communication_conversation_members m JOIN users u ON u.id = m.user_id
      WHERE m.conversation_id = $1 AND m.left_at IS NULL ORDER BY m.member_role = 'owner' DESC, u.full_name`,
    [conv.id],
  );
  const other = conv.conversation_type === 'direct' ? members.find((m) => m.user_id !== u.id) : null;
  res.json({
    id: conv.id,
    conversation_type: conv.conversation_type,
    title: other ? other.full_name : conv.title,
    description: conv.description,
    is_archived: conv.is_archived,
    member_role: conv.member_role,
    muted: conv.muted,
    can_manage: conv.conversation_type === 'group' && (conv.member_role === 'owner' || canManageGroups(u)),
    members: members.map((m) => ({ ...m, online: isOnline(m.user_id) })),
  });
});

communicationsRouter.patch('/communications/conversations/:id', async (req, res) => {
  const u = currentUser(req);
  const conv = await memberOr404(u, param(req, 'id'));
  const b = body(
    req,
    z.object({
      title: z.string().trim().min(2).max(150).optional(),
      description: z.string().trim().max(1000).nullish(),
      isArchived: z.boolean().optional(),
      muted: z.boolean().optional(),
    }),
  );
  // Muting is one's own setting.
  if (b.muted !== undefined)
    await query('UPDATE communication_conversation_members SET muted = $3 WHERE conversation_id = $1 AND user_id = $2', [conv.id, u.id, b.muted]);
  if (b.title === undefined && b.description === undefined && b.isArchived === undefined) {
    res.json({ ok: true });
    return;
  }
  requireGroupAdmin(u, conv);
  await tx(async (c) => {
    const r = await one(
      `UPDATE communication_conversations SET title = COALESCE($2, title), description = CASE WHEN $3 THEN $4 ELSE description END,
         is_archived = COALESCE($5, is_archived) WHERE id = $1 RETURNING *`,
      [conv.id, b.title ?? null, b.description !== undefined, b.description || null, b.isArchived ?? null],
      c,
    );
    if (b.title && b.title !== conv.title) await systemMessage(c, conv.id, `${u.fullName} نام گروه را به «${b.title}» تغییر داد`);
    await audit(c, req, { action: 'communications.group_updated', entity: 'communication_conversation', entityId: conv.id, before: conv, after: r });
  });
  emitToUsers(await memberIds(conv.id), 'ConversationUpdated', { conversationId: conv.id });
  res.json({ ok: true });
});

communicationsRouter.post('/communications/conversations/:id/members', async (req, res) => {
  const u = currentUser(req);
  const conv = await memberOr404(u, param(req, 'id'));
  requireGroupAdmin(u, conv);
  const b = body(req, z.object({ userIds: z.array(uuid).min(1).max(200) }));
  const added = await tx(async (c) => {
    const users = await query(`SELECT id, full_name FROM users WHERE id = ANY($1::uuid[]) AND is_active AND username <> 'system'`, [b.userIds], c);
    if (users.length !== new Set(b.userIds).size) throw badRequest('برخی کاربران یافت نشدند یا غیرفعال‌اند');
    const out: any[] = [];
    for (const m of users) {
      const r = await one(
        `INSERT INTO communication_conversation_members (conversation_id, user_id) VALUES ($1, $2)
         ON CONFLICT (conversation_id, user_id) DO UPDATE SET left_at = NULL, joined_at = now(), member_role = 'member'
           WHERE communication_conversation_members.left_at IS NOT NULL
         RETURNING user_id`,
        [conv.id, m.id],
        c,
      );
      if (r) out.push(m);
    }
    if (out.length) {
      await systemMessage(c, conv.id, `${u.fullName} ${out.map((m) => m.full_name).join('، ')} را به گروه افزود`);
      await audit(c, req, {
        action: 'communications.members_added',
        entity: 'communication_conversation',
        entityId: conv.id,
        after: { userIds: out.map((m) => m.id) },
      });
    }
    return out;
  });
  emitToUsers(await memberIds(conv.id), 'ConversationUpdated', { conversationId: conv.id });
  res.json({ added: added.length });
});

/** Removes a member (group admins) or leaves (oneself). The removed member loses access; the history stays. */
communicationsRouter.delete('/communications/conversations/:id/members/:userId', async (req, res) => {
  const u = currentUser(req);
  const conv = await memberOr404(u, param(req, 'id'));
  const target = param(req, 'userId');
  if (conv.conversation_type !== 'group') throw badRequest('از گفت‌وگوی دونفره نمی‌توان خارج شد');
  if (target !== u.id) requireGroupAdmin(u, conv);
  const before = await memberIds(conv.id);
  await tx(async (c) => {
    const r = await one(
      `UPDATE communication_conversation_members SET left_at = now() WHERE conversation_id = $1 AND user_id = $2 AND left_at IS NULL RETURNING user_id`,
      [conv.id, target],
      c,
    );
    if (!r) throw notFound('این کاربر عضو گروه نیست');
    const name = (await one('SELECT full_name FROM users WHERE id = $1', [target], c))?.full_name ?? '';
    await systemMessage(c, conv.id, target === u.id ? `${name} از گروه خارج شد` : `${u.fullName} ${name} را از گروه حذف کرد`);
    await audit(c, req, {
      action: target === u.id ? 'communications.member_left' : 'communications.member_removed',
      entity: 'communication_conversation',
      entityId: conv.id,
      before: { userId: target },
    });
  });
  emitToUsers(before, 'ConversationUpdated', { conversationId: conv.id });
  emitToUsers([target], 'ConversationRemoved', { conversationId: conv.id });
  res.status(204).end();
});

/** Messages, newest first; ?before=<ISO time> pages back. */
communicationsRouter.get('/communications/conversations/:id/messages', async (req, res) => {
  const u = currentUser(req);
  const conv = await memberOr404(u, param(req, 'id'));
  const before = typeof req.query.before === 'string' && !Number.isNaN(Date.parse(req.query.before)) ? req.query.before : null;
  const limit = Math.min(100, Math.max(1, Number(req.query.limit ?? 50) || 50));
  const items = await query(
    `SELECT ${MESSAGE_COLS} FROM communication_messages m LEFT JOIN users su ON su.id = m.sender_user_id
      WHERE m.conversation_id = $1 AND ($2::timestamptz IS NULL OR m.created_at < $2) ORDER BY m.created_at DESC LIMIT $3`,
    [conv.id, before, limit + 1],
  );
  // Read state of the others, so the sender can see «خوانده شد».
  const reads = await query(
    `SELECT m.user_id, m.last_read_at FROM communication_conversation_members m WHERE m.conversation_id = $1 AND m.left_at IS NULL AND m.user_id <> $2`,
    [conv.id, u.id],
  );
  res.json({ items: items.slice(0, limit), hasMore: items.length > limit, reads });
});

const textBody = z.string().trim().min(1, 'متن پیام خالی است').max(4000);
const clientId = z
  .string()
  .trim()
  .min(8)
  .max(64)
  .regex(/^[A-Za-z0-9_-]+$/)
  .optional();

async function writable(u: AuthUser, id: string) {
  const conv = await memberOr404(u, id);
  if (conv.is_archived) throw conflict('این گروه بایگانی شده و پیام جدید نمی‌پذیرد');
  return conv;
}

/** A send retried with the same clientId returns the first message (no duplicates on a flaky network). */
async function existingByClientId(u: AuthUser, cid: string | undefined) {
  if (!cid) return null;
  const r = await one('SELECT id FROM communication_messages WHERE sender_user_id = $1 AND client_id = $2', [u.id, cid]);
  return r ? messageById(r.id) : null;
}

async function checkReply(conversationId: string, replyToId: string | null | undefined) {
  if (!replyToId) return null;
  const r = await one('SELECT id FROM communication_messages WHERE id = $1 AND conversation_id = $2', [replyToId, conversationId]);
  if (!r) throw badRequest('پیام مورد پاسخ در این گفت‌وگو نیست');
  return replyToId;
}

communicationsRouter.post('/communications/conversations/:id/messages', sendLimiter, async (req, res) => {
  const u = currentUser(req);
  const conv = await writable(u, param(req, 'id'));
  const b = body(req, z.object({ body: textBody, clientId, replyToId: uuid.nullish() }));
  const dup = await existingByClientId(u, b.clientId);
  if (dup) {
    res.json(dup);
    return;
  }
  const replyTo = await checkReply(conv.id, b.replyToId);
  const id = await tx(async (c) => {
    const r = await one(
      `INSERT INTO communication_messages (conversation_id, sender_user_id, body, client_id, reply_to_id) VALUES ($1,$2,$3,$4,$5) RETURNING id, created_at`,
      [conv.id, u.id, b.body, b.clientId ?? null, replyTo],
      c,
    );
    // now() is the transaction time, the same instant as the message's created_at (a JS Date would lose the microseconds).
    await c.query('UPDATE communication_conversations SET last_message_at = now() WHERE id = $1', [conv.id]);
    // Writing means having read everything before.
    await c.query('UPDATE communication_conversation_members SET last_read_at = now() WHERE conversation_id = $1 AND user_id = $2', [conv.id, u.id]);
    return r!.id as string;
  });
  await deliverMessage(conv.id, id, u.id);
  res.status(201).json(await messageById(id));
});

/** A file message (multipart: file, optional caption «body» and clientId). Stored encrypted, served only to members. */
communicationsRouter.post('/communications/conversations/:id/attachments', sendLimiter, upload.single('file'), async (req: Request, res) => {
  const u = currentUser(req);
  const conv = await writable(u, param(req, 'id'));
  const f = req.file;
  if (!f) throw badRequest('فایلی ارسال نشده است');
  if (f.size > maxAttachmentMb * 1024 * 1024) throw new HttpError(413, 'file_too_large', `حداکثر حجم پیوست پیام ${maxAttachmentMb} مگابایت است`);
  const b = body(req, z.object({ body: z.string().trim().max(4000).optional(), clientId }));
  const dup = await existingByClientId(u, b.clientId);
  if (dup) {
    res.json(dup);
    return;
  }
  const name = uploadedName(f)
    .replace(/[\\/\0]/g, '_')
    .slice(0, 200);
  const mime = validateFile(name, f.buffer);
  if ((await scanFile(f.buffer)) !== 'clean') throw badRequest('فایل آلوده تشخیص داده شد');
  const stored = await putFile('messages', f.buffer);
  const id = await tx(async (c) => {
    const r = await one(
      `INSERT INTO communication_messages (conversation_id, sender_user_id, message_type, body, client_id) VALUES ($1,$2,'file',$3,$4) RETURNING id, created_at`,
      [conv.id, u.id, b.body ?? '', b.clientId ?? null],
      c,
    );
    await c.query(`INSERT INTO communication_attachments (message_id, file_name, storage_key, mime_type, size_bytes, checksum) VALUES ($1,$2,$3,$4,$5,$6)`, [
      r!.id,
      name,
      stored.storageKey,
      mime,
      stored.size,
      stored.sha256,
    ]);
    // now() is the transaction time, the same instant as the message's created_at (a JS Date would lose the microseconds).
    await c.query('UPDATE communication_conversations SET last_message_at = now() WHERE id = $1', [conv.id]);
    await c.query('UPDATE communication_conversation_members SET last_read_at = now() WHERE conversation_id = $1 AND user_id = $2', [conv.id, u.id]);
    return r!.id as string;
  });
  await deliverMessage(conv.id, id, u.id);
  res.status(201).json(await messageById(id));
});

communicationsRouter.get('/communications/attachments/:id', async (req, res) => {
  const u = currentUser(req);
  const a = await one(
    `SELECT a.*, m.conversation_id, m.deleted_at FROM communication_attachments a JOIN communication_messages m ON m.id = a.message_id WHERE a.id = $1`,
    [param(req, 'id')],
  );
  if (!a || a.deleted_at || !(await memberConversation(u.id, a.conversation_id))) throw notFound();
  sendFile(res, await getFile(a.storage_key), a.file_name, a.mime_type, req.query.inline === '1');
});

async function ownMessage(u: AuthUser, id: string) {
  const m = await one('SELECT * FROM communication_messages WHERE id = $1', [id]);
  if (!m || !(await memberConversation(u.id, m.conversation_id))) throw notFound();
  if (m.sender_user_id !== u.id) throw forbidden('فقط فرستنده می‌تواند پیام را ویرایش یا حذف کند');
  if (m.deleted_at) throw conflict('این پیام حذف شده است');
  return m;
}

communicationsRouter.patch('/communications/messages/:id', async (req, res) => {
  const u = currentUser(req);
  const m = await ownMessage(u, param(req, 'id'));
  if (m.message_type !== 'text') throw badRequest('فقط پیام متنی قابل ویرایش است');
  const b = body(req, z.object({ body: textBody }));
  await query('UPDATE communication_messages SET body = $2, edited_at = now() WHERE id = $1', [m.id, b.body]);
  const msg = await messageById(m.id);
  emitToUsers(await memberIds(m.conversation_id), 'MessageUpdated', { conversationId: m.conversation_id, message: msg });
  res.json(msg);
});

/** Deleting hides the text and files for everyone; the row stays (time and sender) and the file is kept for the record. */
communicationsRouter.delete('/communications/messages/:id', async (req, res) => {
  const u = currentUser(req);
  const m = await ownMessage(u, param(req, 'id'));
  await query('UPDATE communication_messages SET deleted_at = now() WHERE id = $1', [m.id]);
  const msg = await messageById(m.id);
  emitToUsers(await memberIds(m.conversation_id), 'MessageUpdated', { conversationId: m.conversation_id, message: msg });
  res.status(204).end();
});

/** Marks the conversation read up to this message (never moves backwards) and clears its notifications. */
communicationsRouter.post('/communications/messages/:id/read', async (req, res) => {
  const u = currentUser(req);
  const m = await one('SELECT id, conversation_id FROM communication_messages WHERE id = $1', [param(req, 'id')]);
  if (!m || !(await memberConversation(u.id, m.conversation_id))) throw notFound();
  // The time is taken in SQL (microseconds kept), so "read up to this message" compares exactly.
  const r = await one(
    `UPDATE communication_conversation_members SET last_read_at = GREATEST(COALESCE(last_read_at, '-infinity'), (SELECT created_at FROM communication_messages WHERE id = $3))
      WHERE conversation_id = $1 AND user_id = $2 RETURNING last_read_at`,
    [m.conversation_id, u.id, m.id],
  );
  await query(
    `UPDATE notifications SET read_at = now() WHERE user_id = $1 AND event = 'message.received' AND read_at IS NULL AND data->>'conversationId' = $2`,
    [u.id, m.conversation_id],
  );
  emitToUsers(await memberIds(m.conversation_id), 'MessageRead', { conversationId: m.conversation_id, userId: u.id, lastReadAt: r!.last_read_at });
  res.json({ lastReadAt: r!.last_read_at });
});

/** Text search, only in the user's own conversations. */
communicationsRouter.get('/communications/messages/search', searchLimiter, async (req, res) => {
  const u = currentUser(req);
  const q = typeof req.query.q === 'string' ? req.query.q.trim().slice(0, 100) : '';
  if (q.length < 2) throw badRequest('عبارت جستجو باید دست‌کم ۲ حرف باشد');
  const like = `%${q.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;
  res.json(
    await query(
      `SELECT ${MESSAGE_COLS}, CASE WHEN c.conversation_type = 'direct' THEN
                (SELECT ou.full_name FROM communication_conversation_members om JOIN users ou ON ou.id = om.user_id WHERE om.conversation_id = c.id AND om.user_id <> $1 LIMIT 1)
              ELSE c.title END AS conversation_title
         FROM communication_messages m
         JOIN communication_conversations c ON c.id = m.conversation_id
         JOIN communication_conversation_members cm ON cm.conversation_id = c.id AND cm.user_id = $1 AND cm.left_at IS NULL
         LEFT JOIN users su ON su.id = m.sender_user_id
        WHERE m.deleted_at IS NULL AND m.message_type <> 'system'
          AND (m.body ILIKE $2 OR EXISTS (SELECT 1 FROM communication_attachments a WHERE a.message_id = m.id AND a.file_name ILIKE $2))
        ORDER BY m.created_at DESC LIMIT 50`,
      [u.id, like],
    ),
  );
});
