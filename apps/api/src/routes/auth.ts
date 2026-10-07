import bcrypt from 'bcryptjs';
import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { authenticate, currentUser } from '../auth/middleware.js';
import { issueRefreshToken, revokeRefreshToken, rotateRefreshToken, signAccessToken, signMfaToken, verifyToken } from '../auth/tokens.js';
import { generateSecret, otpauthUrl, verifyTotp } from '../auth/totp.js';
import { config } from '../config.js';
import { one, query, tx } from '../db/pool.js';
import { audit } from '../lib/audit.js';
import { badRequest, unauthorized } from '../lib/errors.js';
import { body } from '../lib/validate.js';

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

async function sessionResponse(userId: string, device: string | undefined, ip: string | undefined) {
  await query('UPDATE users SET last_login_at = now() WHERE id = $1', [userId]);
  return {
    accessToken: signAccessToken(userId),
    refreshToken: await issueRefreshToken(userId, device, ip),
  };
}

authRouter.post('/login', limiter, async (req, res) => {
  const b = body(req, z.object({ identifier: z.string().min(3), password: z.string().min(1), device: z.string().optional() }));
  const id = b.identifier.trim();
  const user = await one<{ id: string; chamber_id: string | null; password_hash: string | null; is_active: boolean; mfa_enabled: boolean }>(
    'SELECT id, chamber_id, password_hash, is_active, mfa_enabled FROM users WHERE lower(email) = lower($1) OR mobile = $1',
    [id],
  );
  // Constant-ish time: always run bcrypt.
  const ok = await bcrypt.compare(b.password, user?.password_hash ?? DUMMY_HASH);
  if (!user || !user.is_active || !user.password_hash || !ok) {
    await tx((c) => audit(c, req, { chamberId: user?.chamber_id ?? null, action: 'auth.login_failed', entity: 'user', entityId: user?.id ?? null, after: { identifier: id } }));
    throw unauthorized('نام کاربری یا رمز عبور اشتباه است');
  }
  if (user.mfa_enabled) {
    res.json({ mfaRequired: true, mfaToken: signMfaToken(user.id) });
    return;
  }
  await tx((c) => audit(c, req, { chamberId: user.chamber_id, action: 'auth.login', entity: 'user', entityId: user.id }));
  res.json(await sessionResponse(user.id, b.device ?? req.headers['user-agent'], req.ip));
});

authRouter.post('/mfa/verify', limiter, async (req, res) => {
  const b = body(req, z.object({ mfaToken: z.string(), code: z.string().regex(/^\d{6}$/), device: z.string().optional() }));
  const p = verifyToken(b.mfaToken, 'mfa');
  if (!p) throw unauthorized('مهلت ورود منقضی شده است');
  const user = await one<{ id: string; chamber_id: string | null; mfa_secret: string | null }>(
    'SELECT id, chamber_id, mfa_secret FROM users WHERE id = $1 AND is_active',
    [p.sub],
  );
  if (!user?.mfa_secret || !verifyTotp(user.mfa_secret, b.code)) throw unauthorized('کد تأیید نادرست است');
  await tx((c) => audit(c, req, { chamberId: user.chamber_id, action: 'auth.login', entity: 'user', entityId: user.id, after: { mfa: true } }));
  res.json(await sessionResponse(user.id, b.device ?? req.headers['user-agent'], req.ip));
});

authRouter.post('/refresh', limiter, async (req, res) => {
  const b = body(req, z.object({ refreshToken: z.string().min(10) }));
  const r = await rotateRefreshToken(b.refreshToken, req.ip);
  if (!r) throw unauthorized('نشست منقضی شده است؛ دوباره وارد شوید');
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
  res.json({ ...profile, adminChambers: u.adminChambers, memberships });
});

authRouter.post('/password', authenticate, limiter, async (req, res) => {
  const u = currentUser(req);
  const b = body(req, z.object({ currentPassword: z.string(), newPassword: z.string().min(8, 'رمز عبور باید حداقل ۸ کاراکتر باشد') }));
  const row = await one<{ password_hash: string | null }>('SELECT password_hash FROM users WHERE id = $1', [u.id]);
  if (!row?.password_hash || !(await bcrypt.compare(b.currentPassword, row.password_hash))) throw badRequest('رمز عبور فعلی اشتباه است');
  const hash = await bcrypt.hash(b.newPassword, 10);
  await tx(async (c) => {
    await c.query('UPDATE users SET password_hash = $2, updated_at = now() WHERE id = $1', [u.id, hash]);
    await c.query('UPDATE refresh_tokens SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL', [u.id]);
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
