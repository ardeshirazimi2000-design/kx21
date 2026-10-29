// Auth service (Keycloak in production): phone OTP, JWT issuance, RBAC and mandatory MFA
// for doctor/admin/operator accounts.
import { ApiError, badRequest, forbidden, notFound, requireFields } from '../lib/http.js';
import { signJwt, verifyJwt, sha256, randomDigits, safeEqualHex, seal, unseal, lookupHash } from '../lib/crypto.js';
import { uuid, nowIso } from '../lib/db.js';
import { normalizePhone, normalizeFa, isValidNationalId } from '../lib/fa.js';
import { TERMS } from '../lib/terms.js';
import { legalDoc, legalIndex, LEGAL_UPDATED, COMPANY } from '../lib/legal.js';
import { getVisitSettings } from '../lib/visit-settings.js';

const OTP_TTL_MS = 2 * 60 * 1000;
const OTP_MAX_ATTEMPTS = 5;
// A new code replaces the previous one; within this window a repeated request (double tap, slow
// SMS gateway) keeps the code already sent instead of texting another one.
const OTP_RESEND_S = 60;
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

export function register(router, { db, keys, platform, config, limiter, domain }) {
  const otpInFlight = new Set();
  const issueOtp = (ctx, target, purpose, payload = null) => {
    const code = randomDigits(6);
    db.run(
      `UPDATE otp_codes SET used_at = ? WHERE tenant_id = ? AND target = ? AND purpose = ? AND used_at IS NULL`,
      nowIso(), ctx.tenantId, target, purpose,
    );
    db.run(
      'INSERT INTO otp_codes (id, tenant_id, target, purpose, code_hash, expires_at, created_at, payload) VALUES (?,?,?,?,?,?,?,?)',
      uuid(), ctx.tenantId, target, purpose, sha256(`${target}:${code}`),
      new Date(Date.now() + OTP_TTL_MS).toISOString(), nowIso(), payload ? JSON.stringify(payload) : null,
    );
    return code;
  };

  // Login history: every attempt with its outcome, address and device.
  function logLogin(ctx, { userId = null, phone = null, success, method, reason = null }) {
    db.run(
      'INSERT INTO login_events (id, tenant_id, user_id, phone, success, method, reason, ip, user_agent, at) VALUES (?,?,?,?,?,?,?,?,?,?)',
      uuid(), ctx.tenantId, userId, phone, success ? 1 : 0, method, reason, ctx.ip ?? null,
      String(ctx.req?.headers?.['user-agent'] ?? '').slice(0, 300) || null, nowIso(),
    );
  }

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
      const uid = target.startsWith('mfa:') ? target.slice(4) : db.get('SELECT id FROM users WHERE tenant_id = ? AND phone = ?', ctx.tenantId, target)?.id;
      logLogin(ctx, { userId: uid ?? null, phone: target.startsWith('mfa:') ? null : target, success: false, method: purpose === 'mfa' ? 'mfa' : 'otp', reason: 'wrong_code' });
      throw invalid;
    }
    db.run('UPDATE otp_codes SET used_at = ? WHERE id = ?', nowIso(), row.id);
    return row.payload ? JSON.parse(row.payload) : null;
  };

  // Codes go out through the SMS provider's approved template. In production without SMS the
  // login is refused (codes are never shown on screen outside development).
  async function deliverCode(ctx, phone, code, purpose) {
    if (domain.sms?.enabled) {
      try {
        await domain.sms.sendOtp(phone, code, purpose);
      } catch (e) {
        console.error('[sms] otp failed:', e.message);
        platform.audit(ctx, 'auth.sms_failed', `phone:${phone}`, { purpose });
        throw new ApiError(503, 'sms_failed', 'ارسال پیامک ناموفق بود؛ چند لحظه بعد دوباره تلاش کنید');
      }
      db.run(`INSERT INTO notifications (id, tenant_id, user_id, channel, target, body, status, created_at) VALUES (?,?,?,?,?,?,?,?)`,
        uuid(), ctx.tenantId, null, 'sms', phone, purpose === 'mfa' ? 'کد تأیید دومرحله‌ای (الگو)' : 'کد ورود (الگو)', 'sent', nowIso());
      return;
    }
    if (!config.devMode) throw new ApiError(503, 'sms_unavailable', 'سرویس پیامک پیکربندی نشده است؛ ورود موقتاً ممکن نیست');
    platform.notify(ctx, { channel: 'sms', target: phone, body: `${purpose === 'mfa' ? 'کد تأیید دومرحله‌ای' : 'کد ورود شما'}: ${code}` });
  }

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
    // role = which entry the user chose on the start screen: 'patient' or 'doctor' (doctors and staff).
    const intent = ctx.body.role === 'doctor' ? 'doctor' : ctx.body.role === 'patient' ? 'patient' : null;
    const existing = db.get('SELECT id, role, deleted_at, disabled_at FROM users WHERE tenant_id = ? AND phone = ?', ctx.tenantId, phone);
    if (existing?.deleted_at || existing?.disabled_at) {
      logLogin(ctx, { userId: existing.id, phone, success: false, method: 'otp', reason: 'account_disabled' });
      throw forbidden('این حساب غیرفعال شده است', 'account_disabled');
    }
    if (existing && intent) {
      const staff = existing.role !== 'patient';
      if (intent === 'patient' && staff) throw new ApiError(409, 'role_mismatch', 'این شماره به‌عنوان پزشک/کادر ثبت شده است؛ از گزینه «ورود پزشکان» استفاده کنید');
      if (intent === 'doctor' && !staff) throw new ApiError(409, 'role_mismatch', 'این شماره به‌عنوان بیمار ثبت شده است؛ از گزینه «ورود بیماران» استفاده کنید');
    }

    if (!existing && !ctx.body.national_id) return { body: { registration_required: true } };
    // One request per number at a time (a second tap while Shahkar/SMS is still answering).
    const flightKey = `${ctx.tenantId}:${phone}`;
    if (otpInFlight.has(flightKey)) throw new ApiError(409, 'otp_in_progress', 'کد در حال ارسال است؛ چند لحظه صبر کنید');
    otpInFlight.add(flightKey);
    try {
      if (domain.sms?.enabled) {
        const last = db.get(
          `SELECT created_at FROM otp_codes WHERE tenant_id = ? AND target = ? AND purpose = 'login' AND used_at IS NULL AND expires_at > ?
           ORDER BY created_at DESC LIMIT 1`, ctx.tenantId, phone, nowIso());
        const wait = last ? OTP_RESEND_S - Math.floor((Date.now() - Date.parse(last.created_at)) / 1000) : 0;
        if (wait > 0) {
          return { status: 202, body: { sent: true, already_sent: true, resend_in: wait, delivery: domain.sms.delivery, registration: !existing, identity_verified: !existing, expires_in: OTP_TTL_MS / 1000 } };
        }
      }
      let payload = null;
      if (!existing) {
        // Registration: national code + mobile must match in Shahkar before any account is created.
        const nid = ctx.body.national_id ? normalizeFa(ctx.body.national_id) : null;
        if (!nid) return { body: { registration_required: true } };
        if (!isValidNationalId(nid)) throw badRequest('کد ملی معتبر نیست', 'invalid_national_id');
        const role = intent ?? 'patient';
        const terms = TERMS[role === 'doctor' ? 'doctor' : 'patient'];
        if (ctx.body.terms_version !== terms.version) throw badRequest('برای ثبت‌نام، پذیرش همه موارد صفحه شرایط لازم است', 'terms_required');
        limiter.hitShared(`shahkar:${ctx.tenantId}:${phone}`, 5, 60 * 60 * 1000);
        const nidHash = lookupHash(keys, `${ctx.tenantId}:${nid}`);
        const taken = db.get('SELECT 1 FROM users WHERE tenant_id = ? AND national_id_hash = ? AND role = ? AND deleted_at IS NULL', ctx.tenantId, nidHash, role);
        if (taken) throw new ApiError(409, 'national_id_taken', 'برای این کد ملی قبلاً حساب ایجاد شده است؛ با شماره ثبت‌شده وارد شوید');
        const v = await domain.identity.verifyMobileOwnership({ nationalId: nid, mobile: phone });
        platform.audit(ctx, 'identity.shahkar', `phone:${phone}`, { matched: v.matched, source: v.source });
        if (!v.matched) {
          throw badRequest('این شماره موبایل به نام صاحب کد ملی واردشده ثبت نشده است (استعلام شاهکار). لطفاً شماره‌ای که به نام خودتان است وارد کنید.', 'shahkar_mismatch');
        }
        payload = { role, nid, source: v.source, terms: terms.version };
      }
      limiter.hitShared(`otp:${ctx.tenantId}:${phone}`, 3, 10 * 60 * 1000);
      const code = issueOtp(ctx, phone, 'login', payload && { ...payload, nid: seal(keys, payload.nid).toString('base64') });
      try {
        await deliverCode(ctx, phone, code, 'login');
      } catch (e) {
        // Nothing reached the phone: drop the code so the user can ask again right away.
        db.run(`UPDATE otp_codes SET used_at = ? WHERE tenant_id = ? AND target = ? AND purpose = 'login' AND used_at IS NULL`, nowIso(), ctx.tenantId, phone);
        throw e;
      }
      platform.audit(ctx, 'auth.otp_requested', `phone:${phone}`, { registration: !!payload });
      return {
        status: 202,
        body: { sent: true, delivery: domain.sms?.enabled ? domain.sms.delivery : 'sms', registration: !!payload, identity_verified: !!payload, expires_in: OTP_TTL_MS / 1000, resend_in: OTP_RESEND_S, ...(config.devMode ? { dev_code: code } : {}) },
      };
    } finally {
      otpInFlight.delete(flightKey);
    }
  });

  router.post('/v1/auth/otp/verify', async (ctx) => {
    requireFields(ctx.body, ['phone', 'code']);
    const phone = normalizePhone(ctx.body.phone);
    if (!phone) throw badRequest('شماره موبایل معتبر نیست', 'invalid_phone');
    const reg = consumeOtp(ctx, phone, 'login', ctx.body.code);

    let user = db.get('SELECT * FROM users WHERE tenant_id = ? AND phone = ?', ctx.tenantId, phone);
    if (user?.deleted_at || user?.disabled_at) throw forbidden('این حساب غیرفعال شده است', 'account_disabled');
    let justRegistered = false;
    if (!user) {
      if (!reg) throw new ApiError(409, 'registration_required', 'ابتدا کد ملی را برای ثبت‌نام وارد کنید');
      const nidSealed = Buffer.from(reg.nid, 'base64');
      const nid = unseal(keys, nidSealed);
      user = {
        id: uuid(), tenant_id: ctx.tenantId, role: reg.role, phone, email: null,
        full_name: null, mfa_enabled: 0, created_at: nowIso(),
      };
      db.tx(() => {
        db.run(
          `INSERT INTO users (id, tenant_id, role, phone, full_name, created_at, national_id_enc, national_id_hash, identity_verified_at, identity_source, terms_version, terms_accepted_at, terms_accepted_ip)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
          user.id, user.tenant_id, user.role, user.phone, null, user.created_at,
          seal(keys, nid), lookupHash(keys, `${ctx.tenantId}:${nid}`), nowIso(), reg.source,
          reg.terms ?? null, reg.terms ? user.created_at : null, reg.terms ? ctx.ip ?? null : null,
        );
        if (reg.role === 'doctor') domain.patient.createDoctorDraft(ctx.tenantId, user.id);
      });
      user = db.get('SELECT * FROM users WHERE id = ?', user.id);
      platform.publish(ctx, 'user.registered', { user_id: user.id, role: user.role });
      justRegistered = true;
    }
    ctx.user = { sub: user.id };

    // A doctor who has just proved Shahkar + OTP gets in to complete the profile; every later login is 2-step.
    if (MFA_ROLES.has(user.role) && !justRegistered) {
      // Second step: a separate, short-lived code (SMS template SMS_MFA_TEMPLATE when set).
      const code = issueOtp(ctx, `mfa:${user.id}`, 'mfa');
      await deliverCode(ctx, user.phone, code, 'mfa');
      platform.audit(ctx, 'auth.mfa_challenge', `user:${user.id}`);
      return {
        body: {
          mfa_required: true, delivery: domain.sms?.enabled ? domain.sms.delivery : 'sms',
          mfa_token: signJwt(keys, { typ: 'mfa', sub: user.id, tid: user.tenant_id }, MFA_TTL_S),
          ...(config.devMode ? { dev_code: code } : {}),
        },
      };
    }
    platform.audit(ctx, 'auth.login', `user:${user.id}`);
    logLogin(ctx, { userId: user.id, phone: user.phone, success: true, method: 'otp' });
    return { body: session(user) };
  });

  router.post('/v1/auth/mfa/verify', async (ctx) => {
    requireFields(ctx.body, ['mfa_token', 'code']);
    const claims = verifyJwt(keys, ctx.body.mfa_token);
    if (!claims || claims.typ !== 'mfa') throw new ApiError(401, 'invalid_mfa_token', 'نشست تأیید دومرحله‌ای منقضی شده است');
    ctx.tenantId = claims.tid;
    limiter.hitShared(`mfa:${claims.sub}`, 10, 5 * 60 * 1000);
    consumeOtp(ctx, `mfa:${claims.sub}`, 'mfa', ctx.body.code);
    const user = db.get('SELECT * FROM users WHERE id = ? AND deleted_at IS NULL', claims.sub);
    if (!user) throw new ApiError(401, 'unauthenticated', 'کاربر یافت نشد');
    if (!user.mfa_enabled) db.run('UPDATE users SET mfa_enabled = 1 WHERE id = ?', user.id);
    ctx.user = { sub: user.id };
    platform.audit(ctx, 'auth.login', `user:${user.id}`, { mfa: true });
    logLogin(ctx, { userId: user.id, phone: user.phone, success: true, method: 'mfa' });
    return { body: session(user) };
  });

  // Re-issue a token (e.g. after the patient profile is created so the token carries `pid`).
  router.post('/v1/auth/refresh', async (ctx) => {
    requireUser(ctx);
    const user = db.get('SELECT * FROM users WHERE id = ? AND deleted_at IS NULL', ctx.user.sub);
    if (!user) throw new ApiError(401, 'unauthenticated', 'کاربر یافت نشد');
    return { body: session(user) };
  });

  // Legal documents (public: linked from the agreement page and the site footer).
  const legalSettings = (tenantId) => ({ refundHours: getVisitSettings(db, tenantId).cancel_refund_hours, holdMin: domain.payments?.HOLD_MIN ?? 15 });
  router.get('/v1/legal', async (ctx) => ({ body: { updated: LEGAL_UPDATED, company: COMPANY, items: legalIndex(legalSettings(ctx.tenantId)) } }));
  router.get('/v1/legal/:id', async (ctx) => {
    const d = legalDoc(ctx.params.id, legalSettings(ctx.tenantId));
    if (!d) throw notFound('سند');
    return { body: d };
  });

  // The agreement shown before registration (public: the user has no account yet).
  router.get('/v1/auth/terms/:role', async (ctx) => {
    const t = Object.hasOwn(TERMS, ctx.params.role) ? TERMS[ctx.params.role] : null;
    if (!t) throw badRequest('نقش نامعتبر است');
    return { body: t };
  });

  router.get('/v1/auth/me', async (ctx) => {
    requireUser(ctx);
    const user = db.get('SELECT id, role, phone, email, full_name, mfa_enabled, identity_verified_at, identity_source, registry_verified_at, birth_date, terms_version, terms_accepted_at FROM users WHERE id = ?', ctx.user.sub);
    const doc = db.get('SELECT id, status, review_reason, contract_required, contract_signed_at FROM doctors WHERE user_id = ?', ctx.user.sub);
    return {
      body: {
        ...user, person_info_enabled: domain.identity.personInfoEnabled,
        permissions: domain.access.permissionsOf(user.id).perms, super_admin: domain.access.permissionsOf(user.id).superAdmin,
        staff_role: domain.access.permissionsOf(user.id).staffRole, patient_id: ctx.user.pid ?? null, doctor_id: doc?.id ?? ctx.user.did ?? null,
        doctor_status: doc?.status ?? null, doctor_review_reason: doc?.review_reason ?? null,
        // The cooperation agreement still has to be signed before the doctor can take bookings.
        doctor_contract_pending: !!doc && doc.status === 'approved' && !!doc.contract_required && !doc.contract_signed_at,
      },
    };
  });

  // Civil-registry check (ثبت احوال): verified national id + birth date → official name, which then
  // replaces whatever the user typed and can no longer be edited by them.
  router.post('/v1/auth/identity/person', async (ctx) => {
    requireUser(ctx);
    return { body: await verifyPerson(ctx, ctx.body.birth_date) };
  });

  async function verifyPerson(ctx, dobIso) {
    const u = db.get('SELECT national_id_enc, full_name, registry_verified_at, birth_date FROM users WHERE id = ?', ctx.user.sub);
    if (u.registry_verified_at) {
      if (dobIso && dobIso !== u.birth_date) throw badRequest('تاریخ تولد با اطلاعات ثبت احوال یکسان نیست', 'identity_mismatch');
      return { verified: true, full_name: u.full_name, birth_date: u.birth_date };
    }
    if (!domain.identity.personInfoEnabled) return { verified: false, skipped: true };
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(dobIso ?? '')) || isNaN(Date.parse(dobIso)) || dobIso > nowIso()) {
      throw badRequest('تاریخ تولد معتبر نیست');
    }
    if (!u.national_id_enc) throw badRequest('کد ملی تأییدشده‌ای برای این حساب ثبت نشده است');
    limiter.hitShared(`person:${ctx.user.sub}`, 5, 24 * 3600 * 1000);
    const nid = unseal(keys, u.national_id_enc);
    const p = await domain.identity.inquirePerson({ nationalId: nid, dobIso });
    if (!p.found) {
      platform.audit(ctx, 'identity.person_mismatch', `user:${ctx.user.sub}`);
      throw new ApiError(422, 'identity_mismatch',
        `تاریخ تولد با اطلاعات ثبت احوال برای این کد ملی مطابقت ندارد${p.message ? ` (${p.message})` : ''}`);
    }
    if (p.deceased) throw new ApiError(422, 'identity_deceased', 'این کد ملی در ثبت احوال به‌عنوان فوت‌شده ثبت شده است');
    db.run('UPDATE users SET full_name = ?, birth_date = ?, registry_verified_at = ? WHERE id = ?', p.full_name, dobIso, nowIso(), ctx.user.sub);
    platform.audit(ctx, 'identity.person_verified', `user:${ctx.user.sub}`);
    return { verified: true, full_name: p.full_name, birth_date: dobIso };
  }
  domain.identity.verifyPerson = verifyPerson;
}
