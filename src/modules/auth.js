// Auth service (Keycloak in production): phone OTP, JWT issuance, RBAC and mandatory MFA
// for doctor/admin/operator accounts.
import { ApiError, badRequest, forbidden, requireFields } from '../lib/http.js';
import { signJwt, verifyJwt, sha256, randomDigits, safeEqualHex } from '../lib/crypto.js';
import { uuid, nowIso } from '../lib/db.js';
import { normalizePhone } from '../lib/fa.js';

const OTP_TTL_MS = 2 * 60 * 1000;
const OTP_MAX_ATTEMPTS = 5;
const ACCESS_TTL_S = 60 * 60 * 8;
const MFA_TTL_S = 5 * 60;
const MFA_ROLES = new Set(['doctor', 'admin', 'operator']);

export function authenticate(ctx, keys) {
  const h = ctx.req.headers.authorization || '';
  if (!h.startsWith('Bearer ')) return;
  const claims = verifyJwt(keys, h.slice(7));
  if (!claims || claims.typ !== 'access') return;
  ctx.user = claims;
  ctx.tenantId = claims.tid;
}

export function requireUser(ctx, ...roles) {
  if (!ctx.user) throw new ApiError(401, 'unauthenticated', 'ابتدا وارد شوید');
  if (roles.length && !roles.includes(ctx.user.role)) throw forbidden('نقش شما مجوز این عملیات را ندارد');
  return ctx.user;
}

export function register(router, { db, keys, platform, config, limiter }) {
  const issueOtp = (ctx, target, purpose) => {
    const code = randomDigits(6);
    db.run(
      `UPDATE otp_codes SET used_at = ? WHERE tenant_id = ? AND target = ? AND purpose = ? AND used_at IS NULL`,
      nowIso(), ctx.tenantId, target, purpose,
    );
    db.run(
      'INSERT INTO otp_codes (id, tenant_id, target, purpose, code_hash, expires_at, created_at) VALUES (?,?,?,?,?,?,?)',
      uuid(), ctx.tenantId, target, purpose, sha256(`${target}:${code}`),
      new Date(Date.now() + OTP_TTL_MS).toISOString(), nowIso(),
    );
    return code;
  };

  const consumeOtp = (ctx, target, purpose, code) => {
    const row = db.get(
      `SELECT * FROM otp_codes WHERE tenant_id = ? AND target = ? AND purpose = ? AND used_at IS NULL
       ORDER BY created_at DESC LIMIT 1`,
      ctx.tenantId, target, purpose,
    );
    const invalid = new ApiError(401, 'invalid_otp', 'کد وارد شده نادرست یا منقضی است');
    if (!row || row.expires_at < nowIso()) throw invalid;
    if (row.attempts >= OTP_MAX_ATTEMPTS) {
      throw new ApiError(429, 'otp_locked', 'تعداد تلاش‌ها بیش از حد مجاز است؛ کد جدید درخواست کنید');
    }
    if (!safeEqualHex(row.code_hash, sha256(`${target}:${String(code).trim()}`))) {
      db.run('UPDATE otp_codes SET attempts = attempts + 1 WHERE id = ?', row.id);
      throw invalid;
    }
    db.run('UPDATE otp_codes SET used_at = ? WHERE id = ?', nowIso(), row.id);
  };

  const accessToken = (user) => {
    const claims = { typ: 'access', sub: user.id, tid: user.tenant_id, role: user.role };
    const patient = db.get('SELECT id FROM patients WHERE user_id = ? AND deleted_at IS NULL', user.id);
    const doctor = db.get('SELECT id FROM doctors WHERE user_id = ? AND deleted_at IS NULL', user.id);
    if (patient) claims.pid = patient.id;
    if (doctor) claims.did = doctor.id;
    return signJwt(keys, claims, ACCESS_TTL_S);
  };

  const session = (user) => ({
    access_token: accessToken(user),
    token_type: 'Bearer',
    expires_in: ACCESS_TTL_S,
    user: { id: user.id, role: user.role, full_name: user.full_name, phone: user.phone },
  });

  router.post('/v1/auth/otp/request', async (ctx) => {
    requireFields(ctx.body, ['phone']);
    const phone = normalizePhone(ctx.body.phone);
    if (!phone) throw badRequest('شماره موبایل معتبر نیست (مثال: 09121234567)', 'invalid_phone');
    limiter.hit(`otp:${ctx.tenantId}:${phone}`, 3, 10 * 60 * 1000);
    const code = issueOtp(ctx, phone, 'login');
    platform.notify(ctx, { channel: 'sms', target: phone, body: `کد ورود شما: ${code}` });
    platform.audit(ctx, 'auth.otp_requested', `phone:${phone}`);
    return { status: 202, body: { sent: true, expires_in: OTP_TTL_MS / 1000, ...(config.devMode ? { dev_code: code } : {}) } };
  });

  router.post('/v1/auth/otp/verify', async (ctx) => {
    requireFields(ctx.body, ['phone', 'code']);
    const phone = normalizePhone(ctx.body.phone);
    if (!phone) throw badRequest('شماره موبایل معتبر نیست', 'invalid_phone');
    consumeOtp(ctx, phone, 'login', ctx.body.code);

    let user = db.get('SELECT * FROM users WHERE tenant_id = ? AND phone = ?', ctx.tenantId, phone);
    if (user?.deleted_at) throw forbidden('این حساب غیرفعال شده است', 'account_disabled');
    if (!user) {
      user = {
        id: uuid(), tenant_id: ctx.tenantId, role: 'patient', phone, email: null,
        full_name: null, mfa_enabled: 0, created_at: nowIso(),
      };
      db.run(
        'INSERT INTO users (id, tenant_id, role, phone, full_name, created_at) VALUES (?,?,?,?,?,?)',
        user.id, user.tenant_id, user.role, user.phone, null, user.created_at,
      );
      platform.publish(ctx, 'user.registered', { user_id: user.id, role: 'patient' });
    }
    ctx.user = { sub: user.id };

    if (MFA_ROLES.has(user.role)) {
      // Second factor goes to a different channel (email; falls back to push in production).
      const code = issueOtp(ctx, `mfa:${user.id}`, 'mfa');
      platform.notify(ctx, {
        userId: user.id, channel: 'email', target: user.email || user.phone, body: `کد تأیید دومرحله‌ای: ${code}`,
      });
      platform.audit(ctx, 'auth.mfa_challenge', `user:${user.id}`);
      return {
        body: {
          mfa_required: true,
          mfa_token: signJwt(keys, { typ: 'mfa', sub: user.id, tid: user.tenant_id }, MFA_TTL_S),
          ...(config.devMode ? { dev_code: code } : {}),
        },
      };
    }
    platform.audit(ctx, 'auth.login', `user:${user.id}`);
    return { body: session(user) };
  });

  router.post('/v1/auth/mfa/verify', async (ctx) => {
    requireFields(ctx.body, ['mfa_token', 'code']);
    const claims = verifyJwt(keys, ctx.body.mfa_token);
    if (!claims || claims.typ !== 'mfa') throw new ApiError(401, 'invalid_mfa_token', 'نشست تأیید دومرحله‌ای منقضی شده است');
    ctx.tenantId = claims.tid;
    limiter.hit(`mfa:${claims.sub}`, 10, 5 * 60 * 1000);
    consumeOtp(ctx, `mfa:${claims.sub}`, 'mfa', ctx.body.code);
    const user = db.get('SELECT * FROM users WHERE id = ? AND deleted_at IS NULL', claims.sub);
    if (!user) throw new ApiError(401, 'unauthenticated', 'کاربر یافت نشد');
    if (!user.mfa_enabled) db.run('UPDATE users SET mfa_enabled = 1 WHERE id = ?', user.id);
    ctx.user = { sub: user.id };
    platform.audit(ctx, 'auth.login', `user:${user.id}`, { mfa: true });
    return { body: session(user) };
  });

  // Re-issue a token (e.g. after the patient profile is created so the token carries `pid`).
  router.post('/v1/auth/refresh', async (ctx) => {
    requireUser(ctx);
    const user = db.get('SELECT * FROM users WHERE id = ? AND deleted_at IS NULL', ctx.user.sub);
    if (!user) throw new ApiError(401, 'unauthenticated', 'کاربر یافت نشد');
    return { body: session(user) };
  });

  router.get('/v1/auth/me', async (ctx) => {
    requireUser(ctx);
    const user = db.get('SELECT id, role, phone, email, full_name, mfa_enabled FROM users WHERE id = ?', ctx.user.sub);
    return { body: { ...user, patient_id: ctx.user.pid ?? null, doctor_id: ctx.user.did ?? null } };
  });
}
