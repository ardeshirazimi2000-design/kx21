/**
 * Mobile app sign-in.
 *  - Initial sign-in (not yet enrolled, new device, changed mobile, or Shahkar match older than SHAHKAR_REVERIFY_DAYS):
 *      national code + mobile → Shahkar match (api.ir) → SMS OTP → session.
 *  - Later sign-ins: SMS OTP only (no Shahkar call).
 *  - Citizens without an account can self-enrol the same way (when APP_CITIZEN_SIGNUP is on).
 */
import { Router } from 'express';
import { z } from 'zod';
import { config } from '../config.js';
import { one, pool, tx } from '../db/pool.js';
import { audit, auditReq } from '../lib/audit.js';
import { forbidden, HttpError, unauthorized } from '../lib/errors.js';
import { isValidNationalCode, normalizeMobile, normalizeNationalCode } from '../lib/identity.js';
import { parse } from '../lib/validate.js';
import { authenticate, currentUser } from '../security/middleware.js';
import { loadAccess } from '../security/roles.js';
import { createSession, revokeSession, rotateRefresh } from '../security/sessions.js';
import { issueOtp, verifyOtp, type OtpPurpose } from '../services/otp.js';
import { requireShahkarMatch, shahkarIsStale } from '../services/shahkar.js';
import { loginLimiter, otpLimiter } from './limiters.js';

export const appAuthRouter = Router();

const deviceId = z.string().regex(/^[A-Za-z0-9._:-]{8,100}$/, 'شناسه دستگاه نامعتبر است');

const identityInput = z.object({
  nationalCode: z.string().transform(normalizeNationalCode).refine(isValidNationalCode, 'کد ملی نامعتبر است'),
  mobile: z.string().transform((m, ctx) => {
    const n = normalizeMobile(m);
    if (!n) {
      ctx.addIssue({ code: 'custom', message: 'شماره موبایل نامعتبر است' });
      return z.NEVER;
    }
    return n;
  }),
  deviceId,
});

const MISMATCH = 'کد ملی یا شماره موبایل با اطلاعات ثبت‌شده مطابقت ندارد';

appAuthRouter.post('/start', loginLimiter, async (req, res) => {
  const body = parse(identityInput, req.body);
  const user = await one<{
    id: string; kind: string; mobile: string; status: string; app_access: boolean; app_enrolled_at: string | null;
    shahkar_verified_at: string | null; device_known: boolean;
  }>(
    `SELECT u.id, u.kind, u.mobile, u.status, u.app_access, u.app_enrolled_at, u.shahkar_verified_at,
            EXISTS (SELECT 1 FROM user_devices d WHERE d.user_id = u.id AND d.device_id = $2 AND d.revoked_at IS NULL) AS device_known
       FROM users u WHERE u.national_code = $1`,
    [body.nationalCode, body.deviceId],
  );
  const deny = async (reason: string, err: HttpError) => {
    await audit({ action: 'app.login.start', actorId: user?.id ?? null, outcome: 'failure', ip: req.ip, channel: 'app', details: { reason } });
    throw err;
  };

  let purpose: OtpPurpose;
  let mobileChange = false;
  if (user) {
    if (user.mobile !== body.mobile) {
      // Staff mobiles are managed by the user administrator; citizens may move to a new SIM registered to them.
      if (user.kind !== 'citizen') return deny('mobile_mismatch', new HttpError(400, MISMATCH, 'identity_mismatch'));
      mobileChange = true;
    }
    if (user.status !== 'active' || !user.app_access) return deny('inactive', forbidden('حساب کاربری شما برای اپلیکیشن فعال نیست'));
    const access = await loadAccess(user.id, 'app');
    if (!access.permissions.has('app.access')) return deny('no_app_role', forbidden('نقشی با دسترسی اپلیکیشن برای شما تعریف نشده است'));
    const initial =
      !user.app_enrolled_at || mobileChange || shahkarIsStale(user.shahkar_verified_at) || (config.SHAHKAR_ON_NEW_DEVICE && !user.device_known);
    purpose = initial ? 'app_enroll' : 'app_login';
  } else {
    if (!config.APP_CITIZEN_SIGNUP) return deny('unknown_user', forbidden('حساب کاربری یافت نشد؛ با مدیر سامانه تماس بگیرید'));
    purpose = 'app_signup';
  }

  const shahkarRequired = purpose !== 'app_login';
  if (shahkarRequired) {
    try {
      await requireShahkarMatch({ nationalCode: body.nationalCode, mobile: body.mobile, context: purpose === 'app_signup' ? 'app_signup' : 'app_enroll', userId: user?.id });
    } catch (e) {
      if (e instanceof HttpError && e.code === 'shahkar_mismatch') await audit({ action: 'shahkar.mismatch', actorId: user?.id ?? null, outcome: 'failure', ip: req.ip, channel: 'app', details: { purpose } });
      throw e;
    }
  }

  const challenge = await issueOtp({
    channel: 'app',
    purpose,
    mobile: body.mobile,
    userId: user?.id ?? null,
    nationalCode: body.nationalCode,
    pendingProfile: mobileChange ? { mobileChange: true } : null,
    ip: req.ip,
    deviceId: body.deviceId,
  });
  res.json({ step: 'otp', firstLogin: shahkarRequired, shahkarVerified: shahkarRequired, ...challenge });
});

const verifyInput = z.object({
  challengeId: z.string(),
  code: z.string().max(10),
  deviceId,
  deviceName: z.string().max(100).optional(),
  firstName: z.string().trim().min(2).max(50).optional(),
  lastName: z.string().trim().min(2).max(50).optional(),
});

appAuthRouter.post('/verify', otpLimiter, async (req, res) => {
  const body = parse(verifyInput, req.body);
  const needsProfile = !(body.firstName && body.lastName);
  // Peek first: a new citizen must also supply a name, without burning the code.
  const peek = await verifyOtp(body.challengeId, body.code, 'app', false).catch(async (e) => {
    await audit({ action: 'app.login.otp', outcome: 'failure', ip: req.ip, channel: 'app' });
    throw e;
  });
  if (peek.deviceId !== body.deviceId) throw unauthorized('کد برای این دستگاه صادر نشده است');
  if (peek.purpose === 'app_signup' && needsProfile) {
    throw new HttpError(400, 'برای تکمیل ثبت‌نام نام و نام خانوادگی را وارد کنید', 'profile_required');
  }
  const c = await verifyOtp(body.challengeId, body.code, 'app');

  const result = await tx(async (db) => {
    let userId = c.userId;
    if (c.purpose === 'app_signup') {
      const created = await one<{ id: string }>(
        `INSERT INTO users (national_code, mobile, first_name, last_name, kind, app_access, shahkar_verified_at, app_enrolled_at)
         VALUES ($1,$2,$3,$4,'citizen',true,now(),now())
         ON CONFLICT (national_code) DO NOTHING RETURNING id`,
        [c.nationalCode, c.mobile, body.firstName, body.lastName],
        db,
      );
      if (!created) throw new HttpError(409, 'این کد ملی هم‌اکنون ثبت شده است؛ دوباره وارد شوید', 'conflict');
      userId = created.id;
      await db.query(`INSERT INTO user_roles (user_id, role_key) VALUES ($1, 'citizen')`, [userId]);
    } else if (c.purpose === 'app_enroll') {
      await db.query(
        `UPDATE users SET shahkar_verified_at = now(), app_enrolled_at = COALESCE(app_enrolled_at, now()), mobile = $2, updated_at = now() WHERE id = $1`,
        [userId, c.mobile],
      );
      if (c.pendingProfile?.mobileChange) {
        await db.query(`UPDATE sessions SET revoked_at = now(), revoked_reason = 'mobile_change' WHERE user_id = $1 AND revoked_at IS NULL`, [userId]);
      }
    } else if (c.purpose !== 'app_login') {
      throw unauthorized();
    }
    const u = await one<{ status: string; app_access: boolean }>('SELECT status, app_access FROM users WHERE id = $1', [userId], db);
    if (!u || u.status !== 'active' || !u.app_access) throw unauthorized('حساب کاربری غیرفعال است');

    await db.query(
      `INSERT INTO user_devices (user_id, device_id, device_name) VALUES ($1,$2,$3)
       ON CONFLICT (user_id, device_id) DO UPDATE SET last_seen_at = now(), device_name = COALESCE(EXCLUDED.device_name, user_devices.device_name), revoked_at = NULL`,
      [userId, body.deviceId, body.deviceName ?? null],
    );
    await db.query('UPDATE users SET last_login_at = now() WHERE id = $1', [userId]);
    const tokens = await createSession(db, userId!, 'app', { ip: req.ip, userAgent: req.get('user-agent'), deviceId: body.deviceId, deviceName: body.deviceName });
    return { userId: userId!, tokens };
  });

  await audit({ action: c.purpose === 'app_signup' ? 'app.signup' : 'app.login', actorId: result.userId, ip: req.ip, channel: 'app', details: { purpose: c.purpose, deviceId: body.deviceId } });
  res.json({ ...result.tokens, firstLogin: c.purpose !== 'app_login' });
});

appAuthRouter.post('/refresh', async (req, res) => {
  const body = parse(z.object({ refreshToken: z.string().min(10).max(200) }), req.body);
  res.json(await rotateRefresh(body.refreshToken, 'app', req.ip ?? null));
});

appAuthRouter.post('/logout', authenticate('app'), async (req, res) => {
  const u = currentUser(req);
  await revokeSession(pool, u.sessionId, 'logout');
  await auditReq(req, { action: 'app.logout' });
  res.status(204).end();
});
