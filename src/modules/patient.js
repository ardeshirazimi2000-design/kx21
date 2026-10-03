// Patient service. In the MVP the Doctor service lives here as a module (design doc §1):
// patient profile with encrypted national_id, versioned consents, GDPR-style export/erasure,
// doctor profiles and calendar publishing, and ABAC (doctor ↔ patient relationship).
import { ApiError, badRequest, forbidden, notFound, conflict, requireFields, requireUuid } from '../lib/http.js';
import { seal, unseal, lookupHash, newSigningKeyPair } from '../lib/crypto.js';
import { uuid, nowIso, parseJson, isUniqueViolation } from '../lib/db.js';
import { normalizePhone, isValidNationalId, normalizeFa } from '../lib/fa.js';
import { requireUser } from './auth.js';

export const SPECIALTIES = {
  general: 'پزشک عمومی',
  internal: 'داخلی',
  cardiology: 'قلب و عروق',
  dermatology: 'پوست و مو',
  pediatrics: 'کودکان',
  neurology: 'مغز و اعصاب',
  ent: 'گوش، حلق و بینی',
  psychiatry: 'روان‌پزشکی',
  gynecology: 'زنان و زایمان',
  orthopedics: 'ارتوپدی',
  gastroenterology: 'گوارش',
};

export const CONSENT_TYPES = ['telehealth', 'recording', 'ai_history_access', 'ai_training'];
export const CONSENT_VERSION = '2026-10-v1';

const strList = (v, name) => {
  if (v == null) return [];
  if (!Array.isArray(v) || v.some((x) => typeof x !== 'string' || x.length > 100) || v.length > 50) {
    throw badRequest(`${name} باید آرایه‌ای از متن باشد`);
  }
  return v.map((x) => x.trim()).filter(Boolean);
};

export function createPatientDomain({ db, keys }) {
  const patientByUser = (userId) =>
    db.get('SELECT * FROM patients WHERE user_id = ? AND deleted_at IS NULL', userId);

  const activeConsent = (patientId, type) =>
    db.get(
      `SELECT * FROM consents WHERE patient_id = ? AND type = ? AND revoked_at IS NULL
       ORDER BY accepted_at DESC LIMIT 1`,
      patientId, type,
    );

  // ABAC: a doctor may read a patient only with an active or past appointment between them.
  const doctorHasRelation = (doctorId, patientId) =>
    !!db.get(
      `SELECT 1 FROM appointments WHERE doctor_id = ? AND patient_id = ?
       AND status IN ('pending','confirmed','completed') LIMIT 1`,
      doctorId, patientId,
    );

  const patientView = (p, { reveal = false } = {}) => {
    const user = db.get('SELECT full_name, phone, email FROM users WHERE id = ?', p.user_id);
    const nid = unseal(keys, p.national_id_enc);
    return {
      id: p.id,
      user_id: p.user_id,
      full_name: user?.full_name ?? null,
      phone: user?.phone ?? null,
      email: user?.email ?? null,
      national_id: reveal ? nid : `******${nid.slice(-4)}`,
      dob: p.dob,
      gender: p.gender,
      allergies: parseJson(p.allergies, []),
      chronic_conditions: parseJson(p.chronic_conditions, []),
      created_at: p.created_at,
    };
  };

  const doctorView = (d) => {
    const u = db.get('SELECT full_name FROM users WHERE id = ?', d.user_id);
    return {
      id: d.id,
      full_name: u?.full_name ?? null,
      specialty: d.specialty,
      specialty_label: SPECIALTIES[d.specialty] ?? d.specialty,
      license_no: d.license_no,
      bio: d.bio,
      languages: parseJson(d.languages, ['fa']),
    };
  };

  function createDoctor(tenantId, { phone, full_name, email, specialty, license_no, bio }) {
    const p = normalizePhone(phone);
    if (!p) throw badRequest('شماره موبایل معتبر نیست', 'invalid_phone');
    if (!SPECIALTIES[specialty]) throw badRequest('تخصص نامعتبر است', 'invalid_specialty');
    if (!full_name || !license_no) throw badRequest('نام و شماره نظام پزشکی الزامی است');
    const kp = newSigningKeyPair(keys);
    return db.tx(() => {
      const userId = uuid();
      const doctorId = uuid();
      try {
        db.run(
          'INSERT INTO users (id, tenant_id, role, phone, email, full_name, created_at) VALUES (?,?,?,?,?,?,?)',
          userId, tenantId, 'doctor', p, email ?? null, full_name, nowIso(),
        );
        db.run(
          `INSERT INTO doctors (id, tenant_id, user_id, specialty, license_no, bio, sign_public_pem, sign_private_sealed)
           VALUES (?,?,?,?,?,?,?,?)`,
          doctorId, tenantId, userId, specialty, String(license_no), bio ?? null, kp.publicPem, kp.privateSealed,
        );
      } catch (e) {
        if (isUniqueViolation(e)) throw conflict('کاربری با این شماره یا شماره نظام پزشکی وجود دارد', 'duplicate');
        throw e;
      }
      return { user_id: userId, doctor_id: doctorId };
    });
  }

  return { patientByUser, activeConsent, doctorHasRelation, patientView, doctorView, createDoctor };
}

export function register(router, { db, keys, platform, domain }) {
  const { patientByUser, activeConsent, doctorHasRelation, patientView, doctorView } = domain.patient;

  const requirePatient = (ctx) => {
    requireUser(ctx, 'patient');
    const p = patientByUser(ctx.user.sub);
    if (!p) throw new ApiError(404, 'profile_incomplete', 'ابتدا پروفایل خود را تکمیل کنید');
    return p;
  };

  router.get('/v1/patients/me', async (ctx) => {
    const p = requirePatient(ctx);
    platform.audit(ctx, 'patient.read', `patient:${p.id}`, { self: true });
    const consents = db.all(
      'SELECT type, version, accepted_at FROM consents WHERE patient_id = ? AND revoked_at IS NULL', p.id,
    );
    return { body: { ...patientView(p), consents } };
  });

  router.put('/v1/patients/me', async (ctx) => {
    requireUser(ctx, 'patient');
    const b = ctx.body;
    const existing = patientByUser(ctx.user.sub);
    if (b.full_name !== undefined) {
      if (typeof b.full_name !== 'string' || b.full_name.trim().length < 2 || b.full_name.length > 100) {
        throw badRequest('نام و نام خانوادگی معتبر نیست');
      }
      db.run('UPDATE users SET full_name = ? WHERE id = ?', b.full_name.trim(), ctx.user.sub);
    }
    if (b.email !== undefined && b.email !== null && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(b.email)) {
      throw badRequest('ایمیل معتبر نیست');
    }
    if (b.email !== undefined) db.run('UPDATE users SET email = ? WHERE id = ?', b.email || null, ctx.user.sub);
    if (b.dob !== undefined && (!/^\d{4}-\d{2}-\d{2}$/.test(b.dob) || isNaN(Date.parse(b.dob)) || b.dob > nowIso())) {
      throw badRequest('تاریخ تولد باید به شکل YYYY-MM-DD و در گذشته باشد');
    }
    if (b.gender !== undefined && b.gender !== null && !['female', 'male', 'other'].includes(b.gender)) {
      throw badRequest('جنسیت نامعتبر است');
    }
    const allergies = b.allergies !== undefined ? strList(b.allergies, 'allergies') : null;
    const chronic = b.chronic_conditions !== undefined ? strList(b.chronic_conditions, 'chronic_conditions') : null;

    let patient;
    try {
      if (!existing) {
        requireFields(b, ['full_name', 'national_id', 'dob']);
        const nid = normalizeFa(b.national_id);
        if (!isValidNationalId(nid)) throw badRequest('کد ملی معتبر نیست', 'invalid_national_id');
        const id = uuid();
        db.run(
          `INSERT INTO patients (id, tenant_id, user_id, national_id_enc, national_id_hash, dob, gender, allergies, chronic_conditions, created_at)
           VALUES (?,?,?,?,?,?,?,?,?,?)`,
          id, ctx.tenantId, ctx.user.sub, seal(keys, nid), lookupHash(keys, `${ctx.tenantId}:${nid}`),
          b.dob, b.gender ?? null, JSON.stringify(allergies ?? []), JSON.stringify(chronic ?? []), nowIso(),
        );
        platform.audit(ctx, 'patient.create', `patient:${id}`);
      } else {
        if (b.national_id !== undefined) throw badRequest('کد ملی پس از ثبت قابل تغییر نیست؛ با پشتیبانی تماس بگیرید');
        db.run(
          `UPDATE patients SET dob = COALESCE(?, dob), gender = COALESCE(?, gender),
             allergies = COALESCE(?, allergies), chronic_conditions = COALESCE(?, chronic_conditions) WHERE id = ?`,
          b.dob ?? null, b.gender ?? null, allergies && JSON.stringify(allergies), chronic && JSON.stringify(chronic),
          existing.id,
        );
        platform.audit(ctx, 'patient.update', `patient:${existing.id}`, { fields: Object.keys(b) });
      }
    } catch (e) {
      if (isUniqueViolation(e)) throw conflict('این کد ملی قبلاً ثبت شده است', 'duplicate_national_id');
      throw e;
    }
    patient = patientByUser(ctx.user.sub);
    return { status: existing ? 200 : 201, body: patientView(patient) };
  });

  // GDPR-style rights: access (export) and erasure (soft delete + crypto-shred national id).
  router.get('/v1/patients/me/export', async (ctx) => {
    const p = requirePatient(ctx);
    platform.audit(ctx, 'patient.export', `patient:${p.id}`);
    return {
      body: {
        profile: patientView(p, { reveal: true }),
        consents: db.all('SELECT type, version, accepted_at, revoked_at FROM consents WHERE patient_id = ?', p.id),
        appointments: db.all('SELECT id, doctor_id, status, channel, created_at FROM appointments WHERE patient_id = ?', p.id),
        triage_results: db.all(
          'SELECT id, symptoms, urgency_level, recommended_specialty, created_at FROM triage_results WHERE user_id = ?',
          ctx.user.sub,
        ).map((t) => ({ ...t, symptoms: parseJson(t.symptoms, []) })),
        prescriptions: db.all(
          'SELECT id, drugs, issued_at FROM prescriptions WHERE patient_id = ? AND issued_at IS NOT NULL', p.id,
        ).map((r) => ({ ...r, drugs: parseJson(r.drugs, []) })),
      },
    };
  });

  router.delete('/v1/patients/me', async (ctx) => {
    const p = requirePatient(ctx);
    const active = db.get(
      `SELECT 1 FROM appointments WHERE patient_id = ? AND status IN ('pending','confirmed')`, p.id,
    );
    if (active) throw conflict('ابتدا نوبت‌های فعال خود را لغو کنید', 'active_appointments');
    const ts = nowIso();
    db.tx(() => {
      db.run(
        `UPDATE patients SET deleted_at = ?, national_id_enc = ?, national_id_hash = ? WHERE id = ?`,
        ts, seal(keys, '0000000000'), lookupHash(keys, `erased:${p.id}`), p.id,
      );
      db.run('UPDATE consents SET revoked_at = ? WHERE patient_id = ? AND revoked_at IS NULL', ts, p.id);
      db.run(`UPDATE users SET deleted_at = ?, full_name = NULL, email = NULL, phone = ? WHERE id = ?`,
        ts, `erased:${ctx.user.sub}`, ctx.user.sub);
    });
    platform.audit(ctx, 'patient.erase', `patient:${p.id}`);
    return { status: 204 };
  });

  // ---- consents (versioned) ----
  router.get('/v1/patients/me/consents', async (ctx) => {
    const p = requirePatient(ctx);
    return {
      body: {
        current_version: CONSENT_VERSION,
        items: CONSENT_TYPES.map((type) => {
          const c = activeConsent(p.id, type);
          return { type, accepted: !!c, version: c?.version ?? null, accepted_at: c?.accepted_at ?? null };
        }),
      },
    };
  });

  router.post('/v1/patients/me/consents', async (ctx) => {
    const p = requirePatient(ctx);
    const { type, version = CONSENT_VERSION } = ctx.body;
    if (!CONSENT_TYPES.includes(type)) throw badRequest('نوع رضایت‌نامه نامعتبر است', 'invalid_consent_type');
    if (version !== CONSENT_VERSION) throw badRequest('نسخه رضایت‌نامه منسوخ است', 'stale_consent_version');
    const existing = activeConsent(p.id, type);
    if (existing?.version === version) return { body: { type, version, accepted_at: existing.accepted_at } };
    const ts = nowIso();
    db.tx(() => {
      db.run('UPDATE consents SET revoked_at = ? WHERE patient_id = ? AND type = ? AND revoked_at IS NULL', ts, p.id, type);
      db.run(
        'INSERT INTO consents (id, tenant_id, patient_id, type, version, accepted_at) VALUES (?,?,?,?,?,?)',
        uuid(), ctx.tenantId, p.id, type, version, ts,
      );
    });
    platform.audit(ctx, 'consent.accept', `patient:${p.id}`, { type, version });
    platform.publish(ctx, 'consent.accepted', { patient_id: p.id, type, version });
    return { status: 201, body: { type, version, accepted_at: ts } };
  });

  router.delete('/v1/patients/me/consents/:type', async (ctx) => {
    const p = requirePatient(ctx);
    const { type } = ctx.params;
    if (!CONSENT_TYPES.includes(type)) throw badRequest('نوع رضایت‌نامه نامعتبر است', 'invalid_consent_type');
    db.run('UPDATE consents SET revoked_at = ? WHERE patient_id = ? AND type = ? AND revoked_at IS NULL', nowIso(), p.id, type);
    platform.audit(ctx, 'consent.revoke', `patient:${p.id}`, { type });
    return { status: 204 };
  });

  // ---- doctor-side read of a patient record (ABAC + audit) ----
  router.get('/v1/patients/:id', async (ctx) => {
    requireUser(ctx, 'doctor', 'admin');
    const id = requireUuid(ctx.params.id, 'id');
    const p = db.get('SELECT * FROM patients WHERE id = ? AND tenant_id = ? AND deleted_at IS NULL', id, ctx.tenantId);
    if (!p) throw notFound('بیمار');
    if (ctx.user.role === 'doctor' && !doctorHasRelation(ctx.user.did, p.id)) {
      platform.audit(ctx, 'patient.read_denied', `patient:${p.id}`);
      throw forbidden('دسترسی به پرونده فقط با رابطه فعال پزشک-بیمار ممکن است', 'no_care_relationship');
    }
    platform.audit(ctx, 'patient.read', `patient:${p.id}`);
    const triage = db.all(
      `SELECT id, symptoms, urgency_level, recommended_specialty, red_flags, rule_version, reviewed_by, created_at
       FROM triage_results WHERE patient_id = ? ORDER BY created_at DESC LIMIT 10`, p.id,
    ).map((t) => ({ ...t, symptoms: parseJson(t.symptoms, []), red_flags: parseJson(t.red_flags, []) }));
    return { body: { ...patientView(p), triage_results: triage } };
  });

  // ---- doctors ----
  router.get('/v1/specialties', async () => ({
    body: { items: Object.entries(SPECIALTIES).map(([code, label]) => ({ code, label })) },
  }));

  router.get('/v1/doctors', async (ctx) => {
    requireUser(ctx);
    const { specialty } = ctx.query;
    const rows = specialty
      ? db.all('SELECT * FROM doctors WHERE tenant_id = ? AND specialty = ? AND deleted_at IS NULL', ctx.tenantId, specialty)
      : db.all('SELECT * FROM doctors WHERE tenant_id = ? AND deleted_at IS NULL', ctx.tenantId);
    return { body: { items: rows.map(doctorView) } };
  });

  router.get('/v1/doctors/:id', async (ctx) => {
    requireUser(ctx);
    const d = db.get('SELECT * FROM doctors WHERE id = ? AND tenant_id = ? AND deleted_at IS NULL',
      requireUuid(ctx.params.id, 'id'), ctx.tenantId);
    if (!d) throw notFound('پزشک');
    return { body: doctorView(d) };
  });

  router.post('/v1/admin/doctors', async (ctx) => {
    requireUser(ctx, 'admin');
    const r = domain.patient.createDoctor(ctx.tenantId, ctx.body);
    platform.audit(ctx, 'doctor.create', `doctor:${r.doctor_id}`);
    return { status: 201, body: r };
  });

  router.post('/v1/admin/staff', async (ctx) => {
    requireUser(ctx, 'admin');
    const phone = normalizePhone(ctx.body.phone);
    if (!phone) throw badRequest('شماره موبایل معتبر نیست', 'invalid_phone');
    if (!['operator', 'admin'].includes(ctx.body.role)) throw badRequest('نقش باید operator یا admin باشد');
    const id = uuid();
    try {
      db.run('INSERT INTO users (id, tenant_id, role, phone, email, full_name, created_at) VALUES (?,?,?,?,?,?,?)',
        id, ctx.tenantId, ctx.body.role, phone, ctx.body.email ?? null, ctx.body.full_name ?? null, nowIso());
    } catch (e) {
      if (isUniqueViolation(e)) throw conflict('کاربری با این شماره وجود دارد', 'duplicate');
      throw e;
    }
    platform.audit(ctx, 'staff.create', `user:${id}`, { role: ctx.body.role });
    return { status: 201, body: { id } };
  });
}
