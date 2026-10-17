import bcrypt from 'bcryptjs';
import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { authenticate, currentUser } from '../auth/middleware.js';
import { issueRefreshToken, revokeAllSessions, revokeRefreshToken, rotateRefreshToken, signAccessToken, signMfaToken, verifyToken } from '../auth/tokens.js';
import { generateSecret, otpauthUrl, verifyTotp } from '../auth/totp.js';
import { config } from '../config.js';
import { one, query, tx } from '../db/pool.js';
import { audit } from '../lib/audit.js';
import { decryptText, encryptText } from '../lib/crypto.js';
import { badRequest, unauthorized } from '../lib/errors.js';
import { body } from '../lib/validate.js';

export const authRouter = Router();

const DUMMY_HASH = bcrypt.hashSync('not-a-real-password', 10);

const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: config.isTest ? 1000 : 20,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: { error: { code: 'rate_limited', message: 'تعداد تلاش‌ها بیش از حد مجاز است؛ کمی بعد تلاش کنید' } },
});

export const passwordSchema = z
  .string()
  .min(8, 'رمز عبور باید حداقل ۸ کاراکتر باشد')
  .refine((p) => /[A-Za-z]/.test(p) && /\d/.test(p), 'رمز عبور باید شامل حرف و عدد باشد');

async function sessionResponse(userId: string, device: string | undefined, ip: string | undefined) {
  await query('UPDATE users SET last_login_at = now() WHERE id = $1', [userId]);
  return { accessToken: signAccessToken(userId), refreshToken: await issueRefreshToken(userId, device, ip) };
}

authRouter.post('/login', limiter, async (req, res) => {
  const b = body(req, z.object({ identifier: z.string().min(2), password: z.string().min(1), device: z.string().optional() }));
  const id = b.identifier.trim();
  const user = await one(
    'SELECT id, password_hash, is_active, mfa_enabled FROM users WHERE lower(username) = lower($1) OR lower(email) = lower($1) OR mobile = $1 LIMIT 1',
    [id],
  );
  const ok = await bcrypt.compare(b.password, user?.password_hash ?? DUMMY_HASH);
  if (!user || !user.is_active || !user.password_hash || !ok) {
    await tx((c) => audit(c, req, { action: 'auth.login_failed', entity: 'user', entityId: user?.id ?? null, after: { identifier: id } }));
    throw unauthorized('نام کاربری یا رمز عبور اشتباه است');
  }
  if (user.mfa_enabled) {
    res.json({ mfaRequired: true, mfaToken: signMfaToken(user.id) });
    return;
  }
  await tx((c) => audit(c, req, { action: 'auth.login', entity: 'user', entityId: user.id, userId: user.id }));
  res.json(await sessionResponse(user.id, b.device ?? req.headers['user-agent'], req.ip));
});

authRouter.post('/mfa/verify', limiter, async (req, res) => {
  const b = body(req, z.object({ mfaToken: z.string(), code: z.string().regex(/^\d{6}$/), device: z.string().optional() }));
  const p = verifyToken(b.mfaToken, 'mfa');
  if (!p) throw unauthorized('مهلت ورود منقضی شده است');
  const user = await one('SELECT id, mfa_secret_enc FROM users WHERE id = $1 AND is_active', [p.sub]);
  if (!user?.mfa_secret_enc || !verifyTotp(decryptText(user.mfa_secret_enc), b.code)) throw unauthorized('کد تأیید نادرست است');
  await tx((c) => audit(c, req, { action: 'auth.login', entity: 'user', entityId: user.id, after: { mfa: true }, userId: user.id }));
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
  const profile = await one('SELECT id, username, full_name, email, mobile, national_id, clearance, mfa_enabled FROM users WHERE id = $1', [u.id]);
  res.json({
    ...profile,
    roles: u.roles,
    permissions: [...u.perms.keys()],
    positions: u.positions,
    mfaRequired: u.roles.some((r) => config.mfaRequiredRoles.includes(r)),
  });
});

authRouter.post('/password', authenticate, limiter, async (req, res) => {
  const u = currentUser(req);
  const b = body(req, z.object({ currentPassword: z.string(), newPassword: passwordSchema }));
  const row = await one('SELECT password_hash FROM users WHERE id = $1', [u.id]);
  if (!row?.password_hash || !(await bcrypt.compare(b.currentPassword, row.password_hash))) throw badRequest('رمز عبور فعلی اشتباه است');
  const hash = await bcrypt.hash(b.newPassword, 10);
  await tx(async (c) => {
    await c.query('UPDATE users SET password_hash = $2, updated_at = now() WHERE id = $1', [u.id, hash]);
    await revokeAllSessions(u.id, c);
    await audit(c, req, { action: 'auth.password_changed', entity: 'user', entityId: u.id });
  });
  res.status(204).end();
});

authRouter.post('/mfa/setup', authenticate, async (req, res) => {
  const u = currentUser(req);
  const secret = generateSecret();
  await query('UPDATE users SET mfa_secret_enc = $2, mfa_enabled = false WHERE id = $1', [u.id, encryptText(secret)]);
  res.json({ secret, otpauthUrl: otpauthUrl(secret, u.fullName) });
});

authRouter.post('/mfa/enable', authenticate, async (req, res) => {
  const u = currentUser(req);
  const b = body(req, z.object({ code: z.string().regex(/^\d{6}$/) }));
  const row = await one('SELECT mfa_secret_enc FROM users WHERE id = $1', [u.id]);
  if (!row?.mfa_secret_enc || !verifyTotp(decryptText(row.mfa_secret_enc), b.code)) throw badRequest('کد تأیید نادرست است');
  await tx(async (c) => {
    await c.query('UPDATE users SET mfa_enabled = true WHERE id = $1', [u.id]);
    await audit(c, req, { action: 'auth.mfa_enabled', entity: 'user', entityId: u.id });
  });
  res.status(204).end();
});
