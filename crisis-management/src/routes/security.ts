/** Console: Shahkar inquiries, audit trail, security settings, districts. */
import { Router } from 'express';
import { z } from 'zod';
import { config } from '../config.js';
import { query } from '../db/pool.js';
import { auditReq } from '../lib/audit.js';
import { isValidNationalCode, maskMobile, maskNationalCode, normalizeMobile, normalizeNationalCode } from '../lib/identity.js';
import { parse } from '../lib/validate.js';
import { currentUser, requirePermission } from '../security/middleware.js';
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

securityRouter.get('/audit', requirePermission('audit.read'), async (req, res) => {
  const q = parse(
    z.object({
      action: z.string().max(64).optional(),
      actorId: z.uuid().optional(),
      outcome: z.enum(['success', 'failure', 'denied']).optional(),
      from: z.iso.datetime({ offset: true }).optional(),
      to: z.iso.datetime({ offset: true }).optional(),
      limit: z.coerce.number().int().min(1).max(500).default(100),
      offset: z.coerce.number().int().min(0).default(0),
    }),
    req.query,
  );
  res.json(
    await query(
      `SELECT a.id, a.at, a.actor_id, u.first_name || ' ' || u.last_name AS actor_name, a.action, a.target_type, a.target_id,
              a.outcome, a.ip, a.channel, a.details
         FROM audit_log a LEFT JOIN users u ON u.id = a.actor_id
        WHERE ($1::text IS NULL OR a.action LIKE $1 || '%') AND ($2::uuid IS NULL OR a.actor_id = $2)
          AND ($3::text IS NULL OR a.outcome = $3) AND ($4::timestamptz IS NULL OR a.at >= $4) AND ($5::timestamptz IS NULL OR a.at < $5)
        ORDER BY a.id DESC LIMIT $6 OFFSET $7`,
      [q.action ?? null, q.actorId ?? null, q.outcome ?? null, q.from ?? null, q.to ?? null, q.limit, q.offset],
    ),
  );
});

/** Effective security policy (no secrets). */
securityRouter.get('/settings', requirePermission('settings.read'), (_req, res) => {
  res.json({
    password: { minLength: config.PASSWORD_MIN_LENGTH, maxAgeDays: config.PASSWORD_MAX_AGE_DAYS, history: 5, complexity: 'upper+lower+digit+symbol' },
    lockout: { maxFailures: config.LOGIN_MAX_FAILURES, minutes: config.LOCKOUT_MINUTES },
    otp: { length: config.OTP_LENGTH, ttlSec: config.OTP_TTL_SEC, maxAttempts: config.OTP_MAX_ATTEMPTS, resendCooldownSec: config.OTP_RESEND_COOLDOWN_SEC, maxPerHour: config.OTP_MAX_PER_HOUR },
    sessions: { accessTtlSec: config.ACCESS_TOKEN_TTL_SEC, consoleRefreshTtlSec: config.CONSOLE_REFRESH_TTL_SEC, consoleIdleTimeoutSec: config.CONSOLE_IDLE_TIMEOUT_SEC, appRefreshTtlSec: config.APP_REFRESH_TTL_SEC },
    shahkar: { mode: config.APIIR_MODE, endpoint: config.APIIR_SHAHKAR_ENDPOINT, reverifyDays: config.SHAHKAR_REVERIFY_DAYS, onNewDevice: config.SHAHKAR_ON_NEW_DEVICE },
    app: { citizenSignup: config.APP_CITIZEN_SIGNUP },
  });
});

securityRouter.get('/districts', async (_req, res) => {
  res.json(await query('SELECT id, code, name FROM districts ORDER BY id'));
});
