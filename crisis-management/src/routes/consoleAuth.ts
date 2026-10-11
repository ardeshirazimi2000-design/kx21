/**
 * Console (management web panel) sign-in: username + password → SMS OTP to the Shahkar-verified mobile → session.
 * PP: FIA_UAU.1/5 (MFA for remote administration), FIA_AFL.1, FTA_TSE.1, FTA_MCS.1, FTA_TAH.1, FIA_PMG_EXT.1.
 */
import { Router } from 'express';
import { z } from 'zod';
import { one, pool, tx } from '../db/pool.js';
import { audit, auditReq } from '../lib/audit.js';
import { badRequest, HttpError, unauthorized } from '../lib/errors.js';
import { parse } from '../lib/validate.js';
import { authenticate, currentUser } from '../security/middleware.js';
import { assertNotReused, passwordProblems, setPassword, verifyPassword } from '../security/password.js';
import { loadAccess } from '../security/roles.js';
import { createSession, recordSuccessfulLogin, revokeSession, rotateRefresh } from '../security/sessions.js';
import { getSettings } from '../security/settings.js';
import { assertConsoleSessionAllowed, lockedMinutesLeft, recordAuthFailure } from '../services/loginGuard.js';
import { issueOtp, verifyOtp } from '../services/otp.js';
import { requireShahkarMatch, shahkarIsStale } from '../services/shahkar.js';
import { loginLimiter, otpLimiter } from './limiters.js';

export const consoleAuthRouter = Router();

const GENERIC = 'نام کاربری یا رمز عبور نادرست است';

/** FIA_UAU.1.1: the only action allowed before authentication besides identification is reading this help. */
consoleAuthRouter.get('/help', (_req, res) => {
  res.json({
    steps: [
      'نام کاربری و رمز عبوری را که مدیر امنیت به شما تحویل داده وارد کنید.',
      'کد یکبارمصرف به شماره موبایلی که با سامانه شاهکار به نام شما احراز شده پیامک می‌شود؛ آن را وارد کنید.',
      'در اولین ورود، رمز موقت را تغییر دهید.',
      'در صورت فراموشی رمز یا قفل شدن حساب، با مدیر امنیت سامانه تماس بگیرید (بازیابی خودکار رمز وجود ندارد).',
    ],
  });
});

interface ConsoleUserRow {
  id: string; username: string; password_hash: string | null; mobile: string; national_code: string; kind: string;
  status: string; console_access: boolean; locked: boolean; shahkar_verified_at: string | null; allowed_cidrs: string[];
}

consoleAuthRouter.post('/login', loginLimiter, async (req, res) => {
  const body = parse(z.object({ username: z.string().min(1).max(64), password: z.string().min(1).max(128) }), req.body);
  const username = body.username.trim().toLowerCase();
  const u = await one<ConsoleUserRow>(
    `SELECT id, username, password_hash, mobile, national_code, kind, status, console_access, allowed_cidrs,
            (locked_until IS NOT NULL AND locked_until > now()) AS locked, shahkar_verified_at
       FROM users WHERE username = $1`,
    [username],
  );
  const pwOk = await verifyPassword(body.password, u?.password_hash ?? null);
  const fail = async (reason: string, message = GENERIC, status = 401): Promise<never> => {
    await audit({ action: 'console.login', actorId: u?.id ?? null, outcome: 'failure', ip: req.ip, channel: 'console', userAgent: req.get('user-agent'), details: { username, reason } });
    throw new HttpError(status, message, 'login_failed');
  };

  if (!u) return fail('unknown_user');
  if (u.locked) return fail('locked', `حساب به‌طور موقت قفل شده است؛ ${await lockedMinutesLeft(u.id)} دقیقه دیگر تلاش کنید`, 423);
  if (!pwOk) {
    await recordAuthFailure(u.id, req.ip ?? null, 'console', 'password');
    return fail('bad_password');
  }
  if (u.status !== 'active' || !u.console_access || u.kind !== 'staff') return fail('not_allowed');
  const access = await loadAccess(u.id, 'console');
  if (!access.permissions.has('console.access')) return fail('no_console_role');
  await assertConsoleSessionAllowed(u, req.ip ?? null);

  // Periodic re-verification of SIM ownership before trusting the mobile as second factor.
  const st = await getSettings();
  if (shahkarIsStale(u.shahkar_verified_at, st['shahkar.reverifyDays'])) {
    try {
      await requireShahkarMatch({ nationalCode: u.national_code, mobile: u.mobile, context: 'console_login', userId: u.id });
    } catch (e) {
      if (e instanceof HttpError && e.code === 'shahkar_mismatch') {
        await one(`UPDATE users SET status = 'suspended', updated_at = now() WHERE id = $1`, [u.id]);
        await audit({ action: 'shahkar.mismatch_suspend', actorId: u.id, targetType: 'user', targetId: u.id, outcome: 'failure', ip: req.ip, channel: 'console' });
        throw new HttpError(403, 'مالکیت شماره موبایل تأیید نشد؛ حساب تعلیق شد. با مدیر امنیت تماس بگیرید', 'shahkar_mismatch');
      }
      throw e;
    }
    await one('UPDATE users SET shahkar_verified_at = now() WHERE id = $1', [u.id]);
  }

  const ch = await issueOtp({ channel: 'console', purpose: 'console_login', mobile: u.mobile, userId: u.id, ip: req.ip });
  await audit({ action: 'console.login.password_ok', actorId: u.id, ip: req.ip, channel: 'console', userAgent: req.get('user-agent') });
  res.json({ step: 'otp', ...ch });
});

consoleAuthRouter.post('/verify', otpLimiter, async (req, res) => {
  const body = parse(z.object({ challengeId: z.string(), code: z.string().max(10) }), req.body);
  let c;
  try {
    c = await verifyOtp(body.challengeId, body.code, 'console');
  } catch (e) {
    const userId = (e as { userId?: string | null }).userId ?? null;
    if (userId) await recordAuthFailure(userId, req.ip ?? null, 'console', 'otp');
    await audit({ action: 'console.login.otp', actorId: userId, outcome: 'failure', ip: req.ip, channel: 'console', userAgent: req.get('user-agent') });
    throw e;
  }
  if (c.purpose !== 'console_login' || !c.userId) throw unauthorized();
  const st = await getSettings();
  const user = await one<{ status: string; must_change_password: boolean; password_expired: boolean; locked: boolean; allowed_cidrs: string[] }>(
    `SELECT status, must_change_password, allowed_cidrs, (locked_until IS NOT NULL AND locked_until > now()) AS locked,
            ($2::int > 0 AND (password_changed_at IS NULL OR password_changed_at < now() - make_interval(days => $2::int))) AS password_expired
       FROM users WHERE id = $1`,
    [c.userId, st['password.maxAgeDays']],
  );
  if (!user || user.status !== 'active' || user.locked) throw unauthorized('حساب کاربری غیرفعال یا قفل است');
  await assertConsoleSessionAllowed({ id: c.userId, allowed_cidrs: user.allowed_cidrs }, req.ip ?? null);

  const { tokens, history } = await tx(async (db) => {
    const history = await recordSuccessfulLogin(db, c.userId!, req.ip ?? null);
    return { history, tokens: await createSession(db, c.userId!, 'console', { ip: req.ip, userAgent: req.get('user-agent') }, history) };
  });
  await audit({ action: 'console.login', actorId: c.userId, ip: req.ip, channel: 'console', userAgent: req.get('user-agent') });
  res.json({ ...tokens, passwordChangeRequired: user.must_change_password || user.password_expired, accessHistory: history });
});

consoleAuthRouter.post('/refresh', async (req, res) => {
  const body = parse(z.object({ refreshToken: z.string().min(10).max(200) }), req.body);
  res.json(await rotateRefresh(body.refreshToken, 'console', req.ip ?? null, req.get('user-agent') ?? null));
});

consoleAuthRouter.post('/logout', authenticate('console'), async (req, res) => {
  const u = currentUser(req);
  await revokeSession(pool, u.sessionId, 'logout');
  await auditReq(req, { action: 'console.logout' });
  res.status(204).end();
});

consoleAuthRouter.post('/change-password', authenticate('console'), async (req, res) => {
  const u = currentUser(req);
  const body = parse(z.object({ currentPassword: z.string().max(128), newPassword: z.string().max(128) }), req.body);
  const row = await one<{ password_hash: string | null; username: string; national_code: string; mobile: string }>(
    'SELECT password_hash, username, national_code, mobile FROM users WHERE id = $1',
    [u.id],
  );
  if (!row || !(await verifyPassword(body.currentPassword, row.password_hash))) {
    await recordAuthFailure(u.id, req.ip ?? null, 'console', 'password_change');
    await auditReq(req, { action: 'password.change', outcome: 'failure', details: { reason: 'bad_current' } });
    throw badRequest('رمز عبور فعلی نادرست است');
  }
  const st = await getSettings();
  const problems = passwordProblems(body.newPassword, st['password.minLength'], { username: row.username, nationalCode: row.national_code, mobile: row.mobile });
  if (problems.length) {
    // FAU_GEN.1: rejected passwords are audited (never the password itself).
    await auditReq(req, { action: 'password.rejected', outcome: 'failure', details: { problems } });
    throw badRequest(`رمز عبور با خط‌مشی سازگار نیست: ${problems.join('، ')}`, problems);
  }
  await tx(async (db) => {
    await assertNotReused(db, u.id, body.newPassword, st['password.history']);
    await setPassword(db, u.id, body.newPassword, false);
    // Sign out every other session of the user.
    await db.query(
      `UPDATE sessions SET revoked_at = now(), revoked_reason = 'password_change' WHERE user_id = $1 AND id <> $2 AND revoked_at IS NULL`,
      [u.id, u.sessionId],
    );
    await auditReq(req, { action: 'password.change', targetType: 'user', targetId: u.id }, db);
  });
  res.status(204).end();
});
