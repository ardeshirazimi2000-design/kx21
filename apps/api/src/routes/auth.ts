import bcrypt from 'bcryptjs';
import { formatTime, toPersianDigits } from '@kx/shared';
import { Router, type Request } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { authenticate, currentUser } from '../auth/middleware.js';
import { revokeRefreshToken, rotateRefreshToken, signMfaToken, startSession, verifyToken, type SessionClient } from '../auth/tokens.js';
import { generateSecret, otpauthUrl, verifyTotp } from '../auth/totp.js';
import { config } from '../config.js';
import { one, query, tx } from '../db/pool.js';
import { audit } from '../lib/audit.js';
import { badRequest, HttpError, unauthorized } from '../lib/errors.js';
import { body } from '../lib/validate.js';
import { assertPasswordAllowed, createCaptcha, ipFailures, recordIpFailure, securityPolicy, verifyCaptcha } from '../services/security.js';
import { webinarEnabled } from '../services/webinar.js';

export const authRouter = Router();

// Used so a login for an unknown user costs the same as one with a wrong password.
const DUMMY_HASH = bcrypt.hashSync('not-a-real-password', 10);

const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: config.isTest ? 1000 : 20,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: { error: { code: 'rate_limited', message: 'تعداد تلاش‌ها بیش از حد مجاز است؛ کمی بعد تلاش کنید' } },
});

const captchaLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: config.isTest ? 1000 : 60,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: { error: { code: 'rate_limited', message: 'تعداد درخواست‌ها بیش از حد مجاز است؛ کمی بعد تلاش کنید' } },
});

const clientOf = (device: string | undefined): SessionClient => (device === 'mobile' ? 'mobile' : 'web');
const timeFa = (d: Date) => toPersianDigits(formatTime(d));

interface LoginUser {
  id: string;
  chamber_id: string | null;
  failed_logins: number;
  locked_until: Date | null;
}

/** A failed password or second-factor code: counts toward the temporary lock (AFTA 2-3) and the CAPTCHA. */
async function registerFailure(req: Request, user: LoginUser | null, identifier: string, step: 'password' | 'mfa' | 'captcha') {
  const policy = await securityPolicy();
  recordIpFailure(req.ip);
  let lockedUntil: Date | null = null;
  let failures = 0;
  if (user && step !== 'captcha') {
    const r = await one<{ failed_logins: number; locked_until: Date | null; locked_now: boolean }>(
      `UPDATE users SET
          failed_since_login = failed_since_login + 1,
          last_failed_login_at = now(),
          locked_until = CASE WHEN failed_logins + 1 >= $2 THEN now() + make_interval(mins => $3) ELSE locked_until END,
          failed_logins = CASE WHEN failed_logins + 1 >= $2 THEN 0 ELSE failed_logins + 1 END
        WHERE id = $1
        RETURNING failed_logins, locked_until, (failed_logins = 0) AS locked_now`,
      [user.id, policy.lockout.maxFailures, policy.lockout.lockMinutes],
    );
    failures = r?.failed_logins ?? 0;
    if (r?.locked_now) lockedUntil = r.locked_until;
  }
  await tx(async (c) => {
    await audit(c, req, { chamberId: user?.chamber_id ?? null, action: 'auth.login_failed', entity: 'user', entityId: user?.id ?? null, after: { identifier, step } });
    if (lockedUntil) {
      await audit(c, req, { chamberId: user!.chamber_id, action: 'auth.account_locked', entity: 'user', entityId: user!.id, after: { until: lockedUntil, minutes: policy.lockout.lockMinutes } });
    }
  });
  if (lockedUntil) {
    throw new HttpError(423, 'account_locked', `به‌دلیل تلاش‌های ناموفق، حساب تا ساعت ${timeFa(lockedUntil)} موقتاً قفل شد`, { lockedUntil });
  }
  const captchaRequired = failures >= policy.lockout.captchaAfter || ipFailures(req.ip) >= policy.lockout.captchaAfter;
  return captchaRequired;
}

/** Starts the session and reports the previous sign-in to the user (AFTA 2-8: last successful sign-in and failures since). */
async function signIn(req: Request, userId: string, chamberId: string | null, device: string | undefined, mfa: boolean) {
  const before = await one<{ last_login_at: Date | null; last_login_ip: string | null; failed_since_login: number; last_failed_login_at: Date | null }>(
    'SELECT last_login_at, last_login_ip, failed_since_login, last_failed_login_at FROM users WHERE id = $1',
    [userId],
  );
  const client = clientOf(device);
  const s = await startSession(userId, client, device === 'web' || device === 'mobile' ? (req.headers['user-agent'] ?? device) : device, req.ip);
  await query(
    `UPDATE users SET last_login_at = now(), last_login_ip = $2, failed_logins = 0, failed_since_login = 0, locked_until = NULL WHERE id = $1`,
    [userId, req.ip ?? null],
  );
  await tx((c) =>
    audit(c, req, { chamberId, action: 'auth.login', entity: 'user', entityId: userId, after: { client, ...(mfa ? { mfa: true } : {}), ...(s.evicted ? { endedSessions: s.evicted } : {}) } }),
  );
  return {
    accessToken: s.accessToken,
    refreshToken: s.refreshToken,
    lastLogin: before?.last_login_at
      ? { at: before.last_login_at, ip: before.last_login_ip, failedSince: before.failed_since_login, lastFailedAt: before.last_failed_login_at }
      : null,
    endedSessions: s.evicted,
  };
}

/** A self-hosted image CAPTCHA, asked after repeated failed sign-ins. */
authRouter.get('/captcha', captchaLimiter, (_req, res) => {
  res.set('Cache-Control', 'no-store').json(createCaptcha());
});

authRouter.post('/login', limiter, async (req, res) => {
  const b = body(
    req,
    z.object({
      identifier: z.string().min(3),
      password: z.string().min(1),
      device: z.string().optional(),
      captchaId: z.string().optional(),
      captchaAnswer: z.string().max(12).optional(),
    }),
  );
  const id = b.identifier.trim();
  const policy = await securityPolicy();
  const user = await one<LoginUser & { password_hash: string | null; is_active: boolean; mfa_enabled: boolean }>(
    'SELECT id, chamber_id, password_hash, is_active, mfa_enabled, failed_logins, locked_until FROM users WHERE lower(email) = lower($1) OR mobile = $1',
    [id],
  );
  // The CAPTCHA comes first: after repeated failures for this account or from this address, nothing else is tried without it.
  const needCaptcha = (user?.failed_logins ?? 0) >= policy.lockout.captchaAfter || ipFailures(req.ip) >= policy.lockout.captchaAfter;
  if (needCaptcha && !verifyCaptcha(b.captchaId, b.captchaAnswer)) {
    await registerFailure(req, user, id, 'captcha');
    throw new HttpError(401, 'captcha_required', b.captchaId ? 'کد امنیتی نادرست است' : 'کد امنیتی تصویر را وارد کنید', { captchaRequired: true });
  }
  // Constant-ish time: always run bcrypt.
  const ok = await bcrypt.compare(b.password, user?.password_hash ?? DUMMY_HASH);
  if (user?.locked_until && user.locked_until > new Date()) {
    await tx((c) => audit(c, req, { chamberId: user.chamber_id, action: 'auth.login_failed', entity: 'user', entityId: user.id, after: { identifier: id, step: 'locked' } }));
    throw new HttpError(423, 'account_locked', `حساب به‌دلیل تلاش‌های ناموفق تا ساعت ${timeFa(user.locked_until)} موقتاً قفل است`, { lockedUntil: user.locked_until });
  }
  if (!user || !user.is_active || !user.password_hash || !ok) {
    const captchaRequired = await registerFailure(req, user && user.is_active ? user : null, id, 'password');
    throw new HttpError(401, 'unauthorized', 'نام کاربری یا رمز عبور اشتباه است', { captchaRequired });
  }
  if (user.mfa_enabled) {
    res.json({ mfaRequired: true, mfaToken: signMfaToken(user.id) });
    return;
  }
  res.json(await signIn(req, user.id, user.chamber_id, b.device, false));
});

authRouter.post('/mfa/verify', limiter, async (req, res) => {
  const b = body(req, z.object({ mfaToken: z.string(), code: z.string().regex(/^\d{6}$/), device: z.string().optional() }));
  const p = verifyToken(b.mfaToken, 'mfa');
  if (!p) throw unauthorized('مهلت ورود منقضی شده است');
  const user = await one<LoginUser & { mfa_secret: string | null }>(
    'SELECT id, chamber_id, mfa_secret, failed_logins, locked_until FROM users WHERE id = $1 AND is_active',
    [p.sub],
  );
  if (!user) throw unauthorized('مهلت ورود منقضی شده است');
  if (user.locked_until && user.locked_until > new Date()) {
    throw new HttpError(423, 'account_locked', `حساب به‌دلیل تلاش‌های ناموفق تا ساعت ${timeFa(user.locked_until)} موقتاً قفل است`, { lockedUntil: user.locked_until });
  }
  if (!user.mfa_secret || !verifyTotp(user.mfa_secret, b.code)) {
    await registerFailure(req, user, user.id, 'mfa');
    throw unauthorized('کد تأیید نادرست است');
  }
  res.json(await signIn(req, user.id, user.chamber_id, b.device, true));
});

authRouter.post('/refresh', limiter, async (req, res) => {
  const b = body(req, z.object({ refreshToken: z.string().min(10) }));
  const r = await rotateRefreshToken(b.refreshToken, req.ip);
  if ('reason' in r) {
    if (r.reason === 'idle') throw new HttpError(401, 'session_idle', 'نشست به‌دلیل بی‌کاری بسته شد؛ دوباره وارد شوید');
    throw unauthorized('نشست منقضی شده است؛ دوباره وارد شوید');
  }
  res.json({ accessToken: r.accessToken, refreshToken: r.refreshToken });
});

authRouter.post('/logout', async (req, res) => {
  const b = body(req, z.object({ refreshToken: z.string().optional() }));
  if (b.refreshToken) await revokeRefreshToken(b.refreshToken);
  res.status(204).end();
});

authRouter.get('/me', authenticate, async (req, res) => {
  const u = currentUser(req);
  const profile = await one(
    'SELECT id, full_name, email, mobile, organization, job_title, chamber_id, is_super_admin, mfa_enabled FROM users WHERE id = $1',
    [u.id],
  );
  const memberships = await query(
    `SELECT m.id, m.commission_id, m.position, cr.title AS role_title, m.has_vote, c.name AS commission_name, c.chamber_id, ch.name AS chamber_name
       FROM commission_memberships m JOIN commissions c ON c.id = m.commission_id JOIN chambers ch ON ch.id = c.chamber_id
       LEFT JOIN custom_roles cr ON cr.chamber_id = m.chamber_id AND cr.key = m.position
      WHERE m.user_id = $1 AND m.status = 'active' ORDER BY c.name`,
    [u.id],
  );
  res.json({ ...profile, adminChambers: u.adminChambers, memberships, features: { webinar: webinarEnabled() } });
});

authRouter.post('/password', authenticate, limiter, async (req, res) => {
  const u = currentUser(req);
  const b = body(req, z.object({ currentPassword: z.string(), newPassword: z.string().max(128) }));
  const row = await one<{ password_hash: string | null; email: string | null; mobile: string | null }>('SELECT password_hash, email, mobile FROM users WHERE id = $1', [u.id]);
  if (!row?.password_hash || !(await bcrypt.compare(b.currentPassword, row.password_hash))) throw badRequest('رمز عبور فعلی اشتباه است');
  await assertPasswordAllowed(b.newPassword, row);
  if (await bcrypt.compare(b.newPassword, row.password_hash)) throw badRequest('رمز عبور جدید باید با رمز فعلی فرق داشته باشد');
  const hash = await bcrypt.hash(b.newPassword, 10);
  await tx(async (c) => {
    await c.query('UPDATE users SET password_hash = $2, updated_at = now() WHERE id = $1', [u.id, hash]);
    // Every other session ends; this one stays signed in.
    await c.query('UPDATE refresh_tokens SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL AND session_id IS DISTINCT FROM $2::uuid', [u.id, u.sessionId ?? null]);
    await audit(c, req, { chamberId: u.chamberId, action: 'auth.password_changed', entity: 'user', entityId: u.id });
  });
  res.status(204).end();
});

authRouter.post('/mfa/setup', authenticate, async (req, res) => {
  const u = currentUser(req);
  const secret = generateSecret();
  await query('UPDATE users SET mfa_secret = $2, mfa_enabled = false WHERE id = $1', [u.id, secret]);
  res.json({ secret, otpauthUrl: otpauthUrl(secret, u.fullName) });
});

authRouter.post('/mfa/enable', authenticate, async (req, res) => {
  const u = currentUser(req);
  const b = body(req, z.object({ code: z.string().regex(/^\d{6}$/) }));
  const row = await one<{ mfa_secret: string | null }>('SELECT mfa_secret FROM users WHERE id = $1', [u.id]);
  if (!row?.mfa_secret || !verifyTotp(row.mfa_secret, b.code)) throw badRequest('کد تأیید نادرست است');
  await tx(async (c) => {
    await c.query('UPDATE users SET mfa_enabled = true WHERE id = $1', [u.id]);
    await audit(c, req, { chamberId: u.chamberId, action: 'auth.mfa_enabled', entity: 'user', entityId: u.id });
  });
  res.status(204).end();
});

/** Register an Expo push token for the current device. */
authRouter.post('/devices', authenticate, async (req, res) => {
  const u = currentUser(req);
  const b = body(req, z.object({ pushToken: z.string().min(10).max(300), platform: z.enum(['ios', 'android', 'web']) }));
  await query(
    `INSERT INTO devices (user_id, push_token, platform) VALUES ($1,$2,$3)
     ON CONFLICT (push_token) DO UPDATE SET user_id = EXCLUDED.user_id, platform = EXCLUDED.platform, last_seen = now()`,
    [u.id, b.pushToken, b.platform],
  );
  res.status(204).end();
});
