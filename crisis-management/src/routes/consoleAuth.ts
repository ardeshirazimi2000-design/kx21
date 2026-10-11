/**
 * Console (management web panel) sign-in: username + password → SMS OTP to the Shahkar-verified mobile → session.
 * Staff accounts are created only by a user administrator after a Shahkar match.
 */
import { Router } from 'express';
import { z } from 'zod';
import { config } from '../config.js';
import { one, pool, tx } from '../db/pool.js';
import { audit, auditReq } from '../lib/audit.js';
import { badRequest, HttpError, unauthorized } from '../lib/errors.js';
import { parse } from '../lib/validate.js';
import { authenticate, currentUser } from '../security/middleware.js';
import { assertNotReused, passwordProblems, setPassword, verifyPassword } from '../security/password.js';
import { loadAccess } from '../security/roles.js';
import { createSession, revokeSession, rotateRefresh } from '../security/sessions.js';
import { issueOtp, verifyOtp } from '../services/otp.js';
import { requireShahkarMatch, shahkarIsStale } from '../services/shahkar.js';
import { loginLimiter, otpLimiter } from './limiters.js';

export const consoleAuthRouter = Router();

const GENERIC = 'نام کاربری یا رمز عبور نادرست است';

interface ConsoleUserRow {
  id: string; username: string; password_hash: string | null; mobile: string; national_code: string; kind: string;
  status: string; console_access: boolean; failed_logins: number; locked: boolean; shahkar_verified_at: string | null;
}

consoleAuthRouter.post('/login', loginLimiter, async (req, res) => {
  const body = parse(z.object({ username: z.string().min(1).max(64), password: z.string().min(1).max(128) }), req.body);
  const username = body.username.trim().toLowerCase();
  const u = await one<ConsoleUserRow>(
    `SELECT id, username, password_hash, mobile, national_code, kind, status, console_access, failed_logins,
            (locked_until IS NOT NULL AND locked_until > now()) AS locked, shahkar_verified_at
       FROM users WHERE username = $1`,
    [username],
  );
  const pwOk = await verifyPassword(body.password, u?.password_hash ?? null);
  const fail = async (reason: string, message = GENERIC, status = 401) => {
    await audit({ action: 'console.login', actorId: u?.id ?? null, outcome: 'failure', ip: req.ip, channel: 'console', details: { username, reason } });
    throw new HttpError(status, message, 'login_failed');
  };

  if (!u) return fail('unknown_user');
  if (u.locked) return fail('locked', `حساب به‌طور موقت قفل شده است؛ ${config.LOCKOUT_MINUTES} دقیقه بعد تلاش کنید`, 423);
  if (!pwOk) {
    const r = await one<{ failed_logins: number }>(
      `UPDATE users SET failed_logins = failed_logins + 1,
              locked_until = CASE WHEN failed_logins + 1 >= $2 THEN now() + make_interval(mins => $3) ELSE locked_until END
        WHERE id = $1 RETURNING failed_logins`,
      [u.id, config.LOGIN_MAX_FAILURES, config.LOCKOUT_MINUTES],
    );
    if (r && r.failed_logins >= config.LOGIN_MAX_FAILURES) {
      await audit({ action: 'account.locked', actorId: u.id, targetType: 'user', targetId: u.id, outcome: 'failure', ip: req.ip, channel: 'console' });
    }
    return fail('bad_password');
  }
  if (u.status !== 'active' || !u.console_access || u.kind !== 'staff') return fail('not_allowed');
  const access = await loadAccess(u.id, 'console');
  if (!access.permissions.has('console.access')) return fail('no_console_role');

  // Periodic re-verification of SIM ownership before trusting the mobile as second factor.
  if (shahkarIsStale(u.shahkar_verified_at)) {
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
  await audit({ action: 'console.login.password_ok', actorId: u.id, ip: req.ip, channel: 'console' });
  res.json({ step: 'otp', ...ch });
});

consoleAuthRouter.post('/verify', otpLimiter, async (req, res) => {
  const body = parse(z.object({ challengeId: z.string(), code: z.string().max(10) }), req.body);
  let c;
  try {
    c = await verifyOtp(body.challengeId, body.code, 'console');
  } catch (e) {
    await audit({ action: 'console.login.otp', outcome: 'failure', ip: req.ip, channel: 'console', details: { challengeId: body.challengeId.slice(0, 36) } });
    throw e;
  }
  if (c.purpose !== 'console_login' || !c.userId) throw unauthorized();
  const user = await one<{ status: string; must_change_password: boolean; password_expired: boolean }>(
    `SELECT status, must_change_password,
            (password_changed_at IS NULL OR password_changed_at < now() - make_interval(days => $2)) AS password_expired
       FROM users WHERE id = $1`,
    [c.userId, config.PASSWORD_MAX_AGE_DAYS],
  );
  if (!user || user.status !== 'active') throw unauthorized('حساب کاربری غیرفعال است');

  const tokens = await tx(async (db) => {
    await db.query('UPDATE users SET failed_logins = 0, locked_until = NULL, last_login_at = now() WHERE id = $1', [c.userId]);
    return createSession(db, c.userId!, 'console', { ip: req.ip, userAgent: req.get('user-agent') });
  });
  await audit({ action: 'console.login', actorId: c.userId, ip: req.ip, channel: 'console' });
  res.json({ ...tokens, passwordChangeRequired: user.must_change_password || user.password_expired });
});

consoleAuthRouter.post('/refresh', async (req, res) => {
  const body = parse(z.object({ refreshToken: z.string().min(10).max(200) }), req.body);
  res.json(await rotateRefresh(body.refreshToken, 'console', req.ip ?? null));
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
    await auditReq(req, { action: 'password.change', outcome: 'failure', details: { reason: 'bad_current' } });
    throw badRequest('رمز عبور فعلی نادرست است');
  }
  const problems = passwordProblems(body.newPassword, { username: row.username, nationalCode: row.national_code, mobile: row.mobile });
  if (problems.length) throw badRequest(`رمز عبور با خط‌مشی سازگار نیست: ${problems.join('، ')}`, problems);
  await tx(async (db) => {
    await assertNotReused(db, u.id, body.newPassword);
    await setPassword(db, u.id, body.newPassword, false);
    // Sign out every other session of the user.
    await db.query(
      `UPDATE sessions SET revoked_at = now(), revoked_reason = 'password_change' WHERE user_id = $1 AND id <> $2 AND revoked_at IS NULL`,
      [u.id, u.sessionId],
    );
  });
  await auditReq(req, { action: 'password.change', targetType: 'user', targetId: u.id });
  res.status(204).end();
});
