// Doctor onboarding and credential review.
//   draft → (doctor submits profile + photo + medical-council card) → pending_review
//   pending_review → admin approves → approved (listed, can publish slots, can be booked)
//                  → admin rejects with a reason → rejected → doctor edits and resubmits
import { ApiError, badRequest, notFound, conflict, requireUuid } from '../lib/http.js';
import { nowIso, isUniqueViolation } from '../lib/db.js';
import { requireUser } from './auth.js';
import { SPECIALTIES } from './patient.js';

const EDITABLE_WHEN_APPROVED = ['bio', 'education', 'experience_years', 'photo_file_id'];
const STATUS_FA = { draft: 'پیش‌نویس', pending_review: 'در انتظار بررسی', approved: 'تأییدشده', rejected: 'ردشده', suspended: 'تعلیق‌شده' };

export function register(router, { db, platform, domain }) {
  const files = domain.files;

  const myDoctor = (ctx) => {
    requireUser(ctx, 'doctor');
    const d = db.get('SELECT * FROM doctors WHERE user_id = ? AND deleted_at IS NULL', ctx.user.sub);
    if (!d) throw notFound('پروفایل پزشک');
    return d;
  };

  const fullView = (d) => {
    const u = db.get('SELECT full_name, phone, identity_verified_at, identity_source, registry_verified_at, birth_date FROM users WHERE id = ?', d.user_id);
    return {
      ...domain.patient.doctorView(d),
      phone: u?.phone,
      identity_verified: !!u?.identity_verified_at, identity_source: u?.identity_source ?? null,
      registry_verified: !!u?.registry_verified_at, birth_date: u?.birth_date ?? null, person_info_enabled: domain.identity.personInfoEnabled,
      license_no: String(d.license_no).startsWith('pending-') ? '' : d.license_no,
      license_card_url: d.license_card_file_id ? files.signedUrl(d.license_card_file_id) : null,
      photo_file_id: d.photo_file_id, license_card_file_id: d.license_card_file_id,
      status: d.status, status_label: STATUS_FA[d.status] ?? d.status,
      review_reason: d.review_reason, submitted_at: d.submitted_at, reviewed_at: d.reviewed_at,
      contract_required: !!d.contract_required, contract_signed_at: d.contract_signed_at ?? null,
    };
  };

  const ownFile = (ctx, fileId, purpose) => {
    if (fileId == null || fileId === '') return null;
    const f = files.meta(requireUuid(fileId, 'file_id'));
    if (!f || f.owner_user_id !== ctx.user.sub || f.purpose !== purpose) throw badRequest('فایل انتخاب‌شده نامعتبر است', 'invalid_file');
    return f.id;
  };

  router.get('/v1/doctors/me/profile', async (ctx) => ({ body: fullView(myDoctor(ctx)) }));

  router.put('/v1/doctors/me/profile', async (ctx) => {
    const d = myDoctor(ctx);
    const b = ctx.body;
    if (d.status === 'pending_review') throw conflict('پرونده شما در حال بررسی است و تا اعلام نتیجه قابل ویرایش نیست', 'under_review');
    if (d.status === 'approved') {
      const locked = Object.keys(b).filter((k) => !EDITABLE_WHEN_APPROVED.includes(k) && b[k] !== undefined);
      if (locked.length) throw conflict('پس از تأیید، نام، تخصص، شماره نظام پزشکی و کارت نظام پزشکی فقط با درخواست به مدیر قابل تغییر است', 'locked_fields');
    }
    const up = {};
    if (b.birth_date !== undefined) {
      const v = await domain.identity.verifyPerson(ctx, b.birth_date);
      if (v.verified) b.full_name = undefined;
    }
    const reg = db.get('SELECT registry_verified_at, full_name FROM users WHERE id = ?', d.user_id);
    if (reg?.registry_verified_at && b.full_name !== undefined && String(b.full_name).trim() !== reg.full_name) {
      throw badRequest('نام از ثبت احوال دریافت شده و قابل تغییر نیست', 'name_locked');
    }
    if (b.full_name !== undefined && !reg?.registry_verified_at) {
      const n = String(b.full_name).trim();
      if (n.length < 3 || n.length > 100) throw badRequest('نام و نام خانوادگی معتبر نیست');
      db.run('UPDATE users SET full_name = ? WHERE id = ?', n, d.user_id);
    }
    if (b.specialty !== undefined) {
      if (!SPECIALTIES[b.specialty]) throw badRequest('تخصص نامعتبر است', 'invalid_specialty');
      up.specialty = b.specialty;
    }
    if (b.license_no !== undefined) {
      const l = String(b.license_no).trim();
      if (!/^[A-Za-z0-9\-\/]{3,20}$/.test(l)) throw badRequest('شماره نظام پزشکی معتبر نیست', 'invalid_license_no');
      up.license_no = l;
    }
    if (b.education !== undefined) up.education = String(b.education ?? '').trim().slice(0, 1000) || null;
    if (b.bio !== undefined) up.bio = String(b.bio ?? '').trim().slice(0, 4000) || null;
    if (b.experience_years !== undefined) {
      const y = b.experience_years === null || b.experience_years === '' ? null : Number(b.experience_years);
      if (y !== null && (!Number.isInteger(y) || y < 0 || y > 70)) throw badRequest('سابقه کار معتبر نیست');
      up.experience_years = y;
    }
    if (b.photo_file_id !== undefined) up.photo_file_id = ownFile(ctx, b.photo_file_id, 'doctor_photo');
    if (b.license_card_file_id !== undefined) up.license_card_file_id = ownFile(ctx, b.license_card_file_id, 'license_card');
    const keys = Object.keys(up);
    if (keys.length) {
      try {
        db.run(`UPDATE doctors SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`, ...keys.map((k) => up[k]), d.id);
      } catch (e) {
        if (isUniqueViolation(e)) throw conflict('این شماره نظام پزشکی قبلاً ثبت شده است', 'duplicate_license');
        throw e;
      }
    }
    platform.audit(ctx, 'doctor.profile_update', `doctor:${d.id}`, { fields: [...keys, ...(b.full_name !== undefined ? ['full_name'] : [])] });
    return { body: fullView(db.get('SELECT * FROM doctors WHERE id = ?', d.id)) };
  });

  router.post('/v1/doctors/me/submit', async (ctx) => {
    const d = myDoctor(ctx);
    if (!['draft', 'rejected'].includes(d.status)) throw conflict('پرونده در وضعیت قابل ارسال نیست', 'invalid_status');
    const u = db.get('SELECT full_name, registry_verified_at FROM users WHERE id = ?', d.user_id);
    const missing = [];
    if (!u?.full_name) missing.push('نام و نام خانوادگی');
    if (domain.identity.personInfoEnabled && !u.registry_verified_at) missing.push('استعلام هویت از ثبت احوال (تاریخ تولد)');
    if (String(d.license_no).startsWith('pending-')) missing.push('شماره نظام پزشکی');
    if (!d.license_card_file_id) missing.push('تصویر کارت نظام پزشکی');
    if (!d.photo_file_id) missing.push('عکس پروفایل');
    if (!d.bio || d.bio.length < 30) missing.push('رزومه/معرفی (حداقل ۳۰ حرف)');
    if (missing.length) throw new ApiError(422, 'profile_incomplete', `موارد زیر را تکمیل کنید: ${missing.join('، ')}`);
    db.run(`UPDATE doctors SET status = 'pending_review', submitted_at = ?, review_reason = NULL WHERE id = ?`, nowIso(), d.id);
    platform.audit(ctx, 'doctor.submit', `doctor:${d.id}`);
    for (const a of db.all(`SELECT id, phone FROM users WHERE tenant_id = ? AND role = 'admin' AND deleted_at IS NULL`, ctx.tenantId)) {
      platform.notify(ctx, { userId: a.id, channel: 'push', target: a.phone, body: `درخواست جدید تأیید پزشک: ${u.full_name}` });
    }
    return { body: fullView(db.get('SELECT * FROM doctors WHERE id = ?', d.id)) };
  });

  // ---------------- admin review ----------------
  router.get('/v1/admin/doctor-applications', async (ctx) => {
    domain.access.require(ctx, 'doctors.review');
    const status = ['pending_review', 'rejected', 'approved', 'draft', 'suspended'].includes(ctx.query.status) ? ctx.query.status : 'pending_review';
    const rows = db.all(
      `SELECT * FROM doctors WHERE tenant_id = ? AND status = ? AND deleted_at IS NULL ORDER BY COALESCE(submitted_at, '') DESC`,
      ctx.tenantId, status,
    );
    return { body: { items: rows.map(fullView) } };
  });

  router.get('/v1/admin/doctors/:id', async (ctx) => {
    domain.access.require(ctx, 'doctors.review');
    const d = db.get('SELECT * FROM doctors WHERE id = ? AND tenant_id = ?', requireUuid(ctx.params.id, 'id'), ctx.tenantId);
    if (!d) throw notFound('پزشک');
    platform.audit(ctx, 'doctor.review_read', `doctor:${d.id}`);
    return { body: fullView(d) };
  });

  const decide = (approve) => async (ctx) => {
    domain.access.require(ctx, 'doctors.review');
    const d = db.get('SELECT * FROM doctors WHERE id = ? AND tenant_id = ?', requireUuid(ctx.params.id, 'id'), ctx.tenantId);
    if (!d) throw notFound('پزشک');
    const reason = String(ctx.body.reason ?? '').trim();
    if (approve && d.status !== 'pending_review') throw conflict('فقط پرونده‌های در انتظار بررسی قابل تأیید هستند', 'invalid_status');
    if (!approve && !['pending_review', 'approved'].includes(d.status)) throw conflict('این پرونده قابل رد نیست', 'invalid_status');
    if (!approve && reason.length < 5) throw badRequest('دلیل رد را بنویسید تا برای پزشک ارسال شود', 'reason_required');
    db.run('UPDATE doctors SET status = ?, review_reason = ?, reviewed_by = ?, reviewed_at = ? WHERE id = ?',
      approve ? 'approved' : 'rejected', approve ? null : reason.slice(0, 1000), ctx.user.sub, nowIso(), d.id);
    // From now on an approved doctor signs the cooperation agreement before taking bookings.
    if (approve && !d.contract_signed_at) db.run('UPDATE doctors SET contract_required = 1 WHERE id = ?', d.id);
    platform.audit(ctx, approve ? 'doctor.approve' : 'doctor.reject', `doctor:${d.id}`, approve ? null : { reason });
    const u = db.get('SELECT id, phone FROM users WHERE id = ?', d.user_id);
    platform.notify(ctx, {
      userId: u.id, channel: 'sms', target: u.phone,
      body: approve
        ? (d.contract_signed_at
          ? 'مدارک شما تأیید شد و پروفایل‌تان در فهرست پزشکان درمان پلاس قرار گرفت. اکنون می‌توانید تقویم خود را منتشر کنید.'
          : 'مدارک شما تأیید شد. برای فعال شدن نوبت‌دهی، قرارداد همکاری را از بخش «قرارداد همکاری» در درمان پلاس تکمیل و امضا کنید.')
        : `مدارک شما تأیید نشد. دلیل: ${reason}. لطفاً از بخش «پروفایل و مدارک» اصلاح و دوباره ارسال کنید.`,
    });
    return { body: fullView(db.get('SELECT * FROM doctors WHERE id = ?', d.id)) };
  };
  router.post('/v1/admin/doctors/:id/approve', decide(true));
  router.post('/v1/admin/doctors/:id/reject', decide(false));
}
