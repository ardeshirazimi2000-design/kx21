/** Console: Shahkar inquiries, audit trail, integrity, security settings, notifications, districts. */
import { createHash } from 'node:crypto';
import { Router } from 'express';
import { z } from 'zod';
import { config } from '../config.js';
import { one, query, tx } from '../db/pool.js';
import { auditReq, SELECTABLE_EVENTS, verifyAuditChain } from '../lib/audit.js';
import { hmac } from '../lib/crypto.js';
import { badRequest, conflict, forbidden, notFound } from '../lib/errors.js';
import { isValidNationalCode, maskMobile, maskNationalCode, normalizeMobile, normalizeNationalCode } from '../lib/identity.js';
import { parse } from '../lib/validate.js';
import { APP_VERSION } from '../lib/version.js';
import { can, currentUser, requirePermission } from '../security/middleware.js';
import { DEFAULTS, getSettings, setSetting, SETTING_SCHEMAS, SETTING_TITLES, settingPermission, type SettingKey } from '../security/settings.js';
import { checkAuditCapacity } from '../services/auditStorage.js';
import { runIntegrityCheck } from '../services/integrity.js';
import { ipAllowed } from '../services/loginGuard.js';
import { openNotifications } from '../services/notifications.js';
import { inquireShahkar } from '../services/shahkar.js';

export const securityRouter = Router();

/** Manual Shahkar inquiry from the console (e.g. before creating a user). Requires a stated purpose. */
securityRouter.post('/shahkar/inquiry', requirePermission('shahkar.inquire'), async (req, res) => {
  const body = parse(
    z.object({
      nationalCode: z.string().transform(normalizeNationalCode).refine(isValidNationalCode, 'کد ملی نامعتبر است'),
      mobile: z.string().transform((m) => normalizeMobile(m) ?? '').refine((m) => m !== '', 'شماره موبایل نامعتبر است'),
      purpose: z.string().trim().min(5, 'هدف استعلام را بنویسید').max(200),
    }),
    req.body,
  );
  const r = await inquireShahkar({ nationalCode: body.nationalCode, mobile: body.mobile, context: 'console_manual', requestedBy: currentUser(req).id });
  await auditReq(req, { action: 'shahkar.inquiry', outcome: r.matched ? 'success' : 'failure', details: { nationalCode: maskNationalCode(body.nationalCode), mobile: maskMobile(body.mobile), purpose: body.purpose } });
  res.json({ matched: r.matched, endpoint: r.endpoint });
});

securityRouter.get('/shahkar/inquiries', requirePermission('shahkar.log.read'), async (req, res) => {
  const q = parse(z.object({ limit: z.coerce.number().int().min(1).max(500).default(100), offset: z.coerce.number().int().min(0).default(0) }), req.query);
  res.json(
    await query(
      `SELECT s.id, s.context, s.national_code_masked, s.mobile_masked, s.endpoint, s.matched, s.success, s.provider_code,
              s.provider_message, s.duration_ms, s.created_at,
              s.user_id, u.first_name || ' ' || u.last_name AS user_name,
              s.requested_by, rb.first_name || ' ' || rb.last_name AS requested_by_name
         FROM shahkar_inquiries s
         LEFT JOIN users u ON u.id = s.user_id
         LEFT JOIN users rb ON rb.id = s.requested_by
        ORDER BY s.id DESC LIMIT $1 OFFSET $2`,
      [q.limit, q.offset],
    ),
  );
});

const auditFilter = z.object({
  action: z.string().max(64).optional(),
  actor: z.string().max(64).optional(),
  outcome: z.enum(['success', 'failure', 'denied']).optional(),
  severity: z.enum(['info', 'low', 'medium', 'high', 'critical']).optional(),
  ip: z.string().max(64).optional(),
  channel: z.enum(['console', 'app']).optional(),
  from: z.iso.datetime({ offset: true }).optional(),
  to: z.iso.datetime({ offset: true }).optional(),
  sort: z.enum(['at_desc', 'at_asc', 'severity_desc']).default('at_desc'),
  limit: z.coerce.number().int().min(1).max(500).default(100),
  offset: z.coerce.number().int().min(0).default(0),
});

const SEVERITY_ORDER = `CASE a.severity WHEN 'critical' THEN 5 WHEN 'high' THEN 4 WHEN 'medium' THEN 3 WHEN 'low' THEN 2 ELSE 1 END`;

/** FAU_SAR.1–3: readable, restricted, selectable and sortable audit review. */
securityRouter.get('/audit', requirePermission('audit.read'), async (req, res) => {
  const q = parse(auditFilter, req.query);
  const order = q.sort === 'at_asc' ? 'a.id ASC' : q.sort === 'severity_desc' ? `${SEVERITY_ORDER} DESC, a.id DESC` : 'a.id DESC';
  res.json(
    await query(
      `SELECT a.id, a.at, a.actor_id, a.actor_name, a.action, a.target_type, a.target_id, a.outcome, a.severity, a.ip, a.channel, a.user_agent, a.details
         FROM audit_log a
        WHERE ($1::text IS NULL OR a.action LIKE $1 || '%') AND ($2::text IS NULL OR a.actor_name ILIKE '%' || $2 || '%')
          AND ($3::text IS NULL OR a.outcome = $3) AND ($4::text IS NULL OR a.severity = $4) AND ($5::text IS NULL OR a.ip LIKE $5 || '%')
          AND ($6::text IS NULL OR a.channel = $6) AND ($7::timestamptz IS NULL OR a.at >= $7) AND ($8::timestamptz IS NULL OR a.at < $8)
        ORDER BY ${order} LIMIT $9 OFFSET $10`,
      [q.action ?? null, q.actor ?? null, q.outcome ?? null, q.severity ?? null, q.ip ?? null, q.channel ?? null, q.from ?? null, q.to ?? null, q.limit, q.offset],
    ),
  );
});

/** Recomputes the audit hash chain and the incident seals (FAU_STG.1.2, FDP_SDI.2). */
securityRouter.post('/integrity/check', requirePermission('integrity.check'), async (req, res) => {
  res.json(await runIntegrityCheck(currentUser(req).id));
});

/**
 * FDP_ETC.2 / FAU_STG.4: export of the audit trail (oldest rows first) with a SHA-256 digest and an HMAC
 * signature over the content. The export is recorded so that the same rows can later be archived.
 */
securityRouter.post('/audit/export', requirePermission('audit.configure'), async (req, res) => {
  const body = parse(z.object({ limit: z.number().int().min(1).max(100000).default(10000) }), req.body ?? {});
  const actor = currentUser(req);
  const rows = await query<{ id: string }>('SELECT * FROM audit_log ORDER BY id ASC LIMIT $1', [body.limit]);
  if (rows.length === 0) throw badRequest('رکوردی برای خروجی وجود ندارد');
  const content = JSON.stringify(rows);
  const sha256 = createHash('sha256').update(content).digest('hex');
  const exp = await one<{ id: string; exported_at: string }>(
    'INSERT INTO audit_exports (from_id, to_id, row_count, sha256, exported_by) VALUES ($1,$2,$3,$4,$5) RETURNING id, exported_at',
    [rows[0].id, rows[rows.length - 1].id, rows.length, sha256, actor.id],
  );
  await auditReq(req, { action: 'audit.export', targetType: 'audit_export', targetId: exp!.id, details: { fromId: rows[0].id, toId: rows[rows.length - 1].id, rows: rows.length, sha256 } });
  res.json({
    exportId: exp!.id,
    meta: {
      system: 'crisis-management', type: 'audit_log', exportedBy: actor.fullName, exportedAt: exp!.exported_at, rows: rows.length,
      fromId: rows[0].id, toId: rows[rows.length - 1].id, classification: 'محرمانه', sha256, signature: hmac(sha256, config.AUDIT_KEY),
    },
    records: rows,
  });
});

/**
 * FAU_STG.4: frees audit capacity by removing rows that were exported (the caller confirms the digest of the
 * file they kept). A checkpoint keeps the hash chain of the remaining rows verifiable.
 */
securityRouter.post('/audit/archive', requirePermission('audit.configure'), async (req, res) => {
  const body = parse(z.object({ exportId: z.coerce.number().int().positive(), sha256: z.string().regex(/^[0-9a-f]{64}$/) }), req.body);
  const actor = currentUser(req);
  const exp = await one<{ id: string; from_id: string; to_id: string; sha256: string }>('SELECT * FROM audit_exports WHERE id = $1', [body.exportId]);
  if (!exp || exp.sha256 !== body.sha256) throw badRequest('خروجی معتبری با این مشخصات ثبت نشده است');
  if (await one('SELECT 1 FROM audit_archives WHERE export_id = $1', [exp.id])) throw conflict('این خروجی قبلاً بایگانی شده است');
  const first = await one<{ id: string }>('SELECT id FROM audit_log ORDER BY id ASC LIMIT 1');
  if (!first || first.id !== exp.from_id) throw conflict('بایگانی باید از قدیمی‌ترین رکورد موجود شروع شود؛ خروجی جدید بگیرید');
  if (!(await verifyAuditChain()).ok) throw conflict('زنجیره صحت ممیزی شکسته است؛ پیش از بایگانی بررسی شود');
  const result = await tx(async (db) => {
    const last = await one<{ id: string; hash: string }>('SELECT id, hash FROM audit_log WHERE id = $1', [exp.to_id], db);
    if (!last) throw conflict('رکوردهای خروجی دیگر موجود نیستند');
    await db.query(`SET LOCAL crisis.audit_archive = 'on'`);
    const del = await db.query('DELETE FROM audit_log WHERE id BETWEEN $1 AND $2', [exp.from_id, exp.to_id]);
    await db.query(`SET LOCAL crisis.audit_archive = 'off'`);
    await db.query('INSERT INTO audit_archives (export_id, last_id, last_hash, row_count, archived_by) VALUES ($1,$2,$3,$4,$5)', [exp.id, last.id, last.hash, del.rowCount, actor.id]);
    return { archived: del.rowCount ?? 0, lastId: last.id };
  });
  await auditReq(req, { action: 'audit.archive', targetType: 'audit_export', targetId: exp.id, details: result });
  await checkAuditCapacity();
  res.json(result);
});

/** FMT_SMF.1 / FMT_MOF.1: security settings with who may change each one. */
securityRouter.get('/settings', requirePermission('settings.read'), async (_req, res) => {
  const values = await getSettings();
  const cap = await checkAuditCapacity();
  res.json({
    settings: (Object.keys(SETTING_TITLES) as SettingKey[]).map((key) => ({ key, title: SETTING_TITLES[key], value: values[key], default: DEFAULTS[key], managedBy: settingPermission(key) })),
    fixed: {
      otp: { length: config.OTP_LENGTH, resendCooldownSec: config.OTP_RESEND_COOLDOWN_SEC, maxPerHour: config.OTP_MAX_PER_HOUR },
      tokens: { accessTtlSec: config.ACCESS_TOKEN_TTL_SEC, consoleRefreshTtlSec: config.CONSOLE_REFRESH_TTL_SEC, appRefreshTtlSec: config.APP_REFRESH_TTL_SEC },
      shahkar: { mode: config.APIIR_MODE, endpoint: config.APIIR_SHAHKAR_ENDPOINT },
      crypto: { passwordHash: `bcrypt (cost ${config.BCRYPT_COST})`, otpAndTokens: 'HMAC-SHA256', auditChain: 'HMAC-SHA256', recordSeal: 'HMAC-SHA256', jwt: 'HS256' },
      transport: { requireHttps: config.REQUIRE_HTTPS, builtInTls: !!config.TLS_CERT_FILE, mutualTlsConsole: config.TLS_REQUIRE_CLIENT_CERT_CONSOLE, databaseTls: config.DATABASE_SSL },
      selectableAuditEvents: SELECTABLE_EVENTS,
      serverTime: new Date().toISOString(),
      timeZone: config.TIME_ZONE,
      version: APP_VERSION,
    },
    audit: cap,
  });
});

securityRouter.put('/settings/:key', requirePermission('settings.manage', 'audit.configure'), async (req, res) => {
  const user = currentUser(req);
  const key = req.params.key as string;
  if (!(key in SETTING_SCHEMAS)) throw notFound('تنظیم یافت نشد');
  const needed = settingPermission(key as SettingKey);
  if (!can(user, needed)) {
    await auditReq(req, { action: 'access.denied', outcome: 'denied', details: { required: [needed], setting: key } });
    throw forbidden(needed === 'audit.configure' ? 'تنظیمات ممیزی فقط توسط ممیز امنیتی قابل تغییر است' : 'مجوز تغییر این تنظیم را ندارید');
  }
  const body = parse(z.object({ value: z.unknown() }), req.body);
  if (key === 'audit.disabledEvents' && Array.isArray(body.value) && body.value.some((e) => !(SELECTABLE_EVENTS as readonly string[]).includes(String(e)))) {
    throw badRequest('فقط رویدادهای عملیاتی قابل غیرفعال‌سازی هستند؛ رویدادهای امنیتی همیشه ثبت می‌شوند');
  }
  if (key === 'access.consoleCidrs' && Array.isArray(body.value) && body.value.length && !ipAllowed(req.ip ?? null, body.value as string[])) {
    throw badRequest('آدرس فعلی شما در فهرست جدید نیست؛ برای جلوگیری از قفل شدن کنسول، ابتدا آن را اضافه کنید');
  }
  const change = await tx(async (db) => {
    const r = await setSetting(db, key, body.value, user.id);
    await auditReq(req, { action: key.startsWith('audit.') ? 'audit.config' : 'settings.update', targetType: 'setting', targetId: key, details: r }, db);
    return r;
  });
  if (key.startsWith('audit.')) await checkAuditCapacity();
  res.json({ key, ...change });
});

securityRouter.get('/notifications', requirePermission('settings.manage', 'audit.read'), async (_req, res) => {
  res.json(await openNotifications());
});

securityRouter.post('/notifications/:id/ack', requirePermission('settings.manage', 'audit.read'), async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) throw notFound();
  await query('UPDATE security_notifications SET acknowledged_by = $2, acknowledged_at = now() WHERE id = $1 AND acknowledged_at IS NULL', [id, currentUser(req).id]);
  await auditReq(req, { action: 'security.notification_ack', targetType: 'notification', targetId: String(id) });
  res.status(204).end();
});

securityRouter.get('/districts', async (_req, res) => {
  res.json(await query('SELECT id, code, name FROM districts ORDER BY id'));
});
