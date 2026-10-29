// Cooperation agreement: once the credentials are approved the doctor completes the agreement
// (professional address), reads it and signs it in the app — then the doctor can publish times and
// be booked. The platform's representative countersigns from the doctor's review page.
import { badRequest, conflict, notFound, requireUuid } from '../lib/http.js';
import { uuid, nowIso, parseJson } from '../lib/db.js';
import { unseal } from '../lib/crypto.js';
import { requireUser } from './auth.js';
import { SPECIALTIES } from './patient.js';
import { buildContract, CONTRACT_TERM, CONTRACT_NOTICE_DAYS } from '../lib/contract-text.js';
import { getVisitSettings } from '../lib/visit-settings.js';

const jalali = (iso) => new Intl.DateTimeFormat('fa-IR-u-ca-persian', { timeZone: 'Asia/Tehran', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(iso));
// A drawn signature: a PNG data URL of reasonable size.
function signatureOf(v) {
  const s = String(v ?? '');
  if (!/^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(s) || s.length < 400 || s.length > 300_000) throw badRequest('امضا را در کادر رسم کنید', 'signature_required');
  return s;
}

export function register(router, { db, keys, platform, domain }) {
  const latest = (doctorId) => db.get('SELECT * FROM doctor_contracts WHERE doctor_id = ? ORDER BY created_at DESC LIMIT 1', doctorId);

  // The agreement filled in with the doctor's details and today's financial terms.
  function draftFor(d, { address = null, at = nowIso() } = {}) {
    const u = db.get('SELECT full_name, national_id_enc FROM users WHERE id = ?', d.user_id);
    let nid = null;
    try { nid = u?.national_id_enc ? unseal(keys, u.national_id_enc) : null; } catch { nid = null; }
    const v = getVisitSettings(db, d.tenant_id);
    return buildContract(
      {
        date: jalali(at), start_date: jalali(at), term: CONTRACT_TERM, notice_days: CONTRACT_NOTICE_DAYS,
        doctor: { full_name: u?.full_name, license_no: String(d.license_no).startsWith('pending-') ? null : d.license_no, national_id: nid, specialty: SPECIALTIES[d.specialty] ?? d.specialty, address },
      },
      { commission_percent: domain.payments.getCommission(d.tenant_id), tariffs: domain.payments.getTariffs(d.tenant_id), refund_hours: v.cancel_refund_hours },
    );
  }

  const view = (d, c, { forAdmin = false } = {}) => {
    const required = !!d.contract_required;
    const status = c ? c.status : d.status === 'approved' ? (required ? 'awaiting_doctor' : 'optional') : 'not_available';
    return {
      status, required, version: c?.version ?? null,
      contract: c ? parseJson(c.content, null) : d.status === 'approved' ? draftFor(d) : null,
      doctor_signature: c?.doctor_signature ?? null, doctor_signed_at: c?.doctor_signed_at ?? null,
      platform_signature: c?.platform_signature ?? null, platform_signed_at: c?.platform_signed_at ?? null,
      platform_signer: c?.platform_signer_id ? db.get('SELECT full_name FROM users WHERE id = ?', c.platform_signer_id)?.full_name ?? null : null,
      ...(forAdmin && c ? { doctor_sign_ip: c.doctor_sign_ip } : {}),
    };
  };

  const myDoctor = (ctx) => {
    requireUser(ctx, 'doctor');
    const d = db.get('SELECT * FROM doctors WHERE user_id = ? AND deleted_at IS NULL', ctx.user.sub);
    if (!d) throw notFound('پروفایل پزشک');
    return d;
  };

  router.get('/v1/doctors/me/contract', async (ctx) => {
    const d = myDoctor(ctx);
    return { body: view(d, latest(d.id)) };
  });

  // { address, accept: true, signature: 'data:image/png;base64,…' }
  router.post('/v1/doctors/me/contract/sign', async (ctx) => {
    const d = myDoctor(ctx);
    if (d.status !== 'approved') throw conflict('قرارداد پس از تأیید مدارک توسط مدیر قابل امضا است', 'doctor_not_approved');
    if (latest(d.id)) throw conflict('قرارداد قبلاً امضا شده است', 'already_signed');
    const address = String(ctx.body.address ?? '').trim();
    if (address.length < 10 || address.length > 300) throw badRequest('نشانی حرفه‌ای (محل مطب یا مرکز درمانی) را کامل بنویسید', 'address_required');
    if (ctx.body.accept !== true) throw badRequest('برای امضا، پذیرش متن قرارداد لازم است', 'accept_required');
    const signature = signatureOf(ctx.body.signature);
    const ts = nowIso();
    const content = draftFor(d, { address, at: ts });
    const id = uuid();
    db.tx(() => {
      db.run(
        `INSERT INTO doctor_contracts (id, tenant_id, doctor_id, version, status, content, doctor_signature, doctor_signed_at, doctor_sign_ip, created_at)
         VALUES (?,?,?,?,'pending_platform',?,?,?,?,?)`,
        id, d.tenant_id, d.id, content.version, JSON.stringify(content), signature, ts, ctx.ip ?? null, ts,
      );
      db.run('UPDATE doctors SET contract_signed_at = ? WHERE id = ?', ts, d.id);
    });
    platform.audit(ctx, 'contract.doctor_sign', `doctor:${d.id}`, { contract_id: id, version: content.version });
    const name = db.get('SELECT full_name FROM users WHERE id = ?', d.user_id)?.full_name ?? 'پزشک';
    for (const a of db.all(`SELECT id, phone FROM users WHERE tenant_id = ? AND role = 'admin' AND deleted_at IS NULL AND disabled_at IS NULL`, d.tenant_id)
      .filter((u) => domain.access.permissionsOf(u.id).perms.includes('doctors.review'))) {
      platform.notify(ctx, { userId: a.id, channel: 'push', target: a.phone, body: `قرارداد همکاری ${name} امضا شد و منتظر امضای پلتفرم است.` });
    }
    return { status: 201, body: view(db.get('SELECT * FROM doctors WHERE id = ?', d.id), latest(d.id)) };
  });

  // ---- platform side (credential reviewers)
  const loadDoctor = (ctx) => {
    domain.access.require(ctx, 'doctors.review');
    const d = db.get('SELECT * FROM doctors WHERE id = ? AND tenant_id = ?', requireUuid(ctx.params.id, 'id'), ctx.tenantId);
    if (!d) throw notFound('پزشک');
    return d;
  };

  router.get('/v1/admin/doctors/:id/contract', async (ctx) => {
    const d = loadDoctor(ctx);
    return { body: view(d, latest(d.id), { forAdmin: true }) };
  });

  router.post('/v1/admin/doctors/:id/contract/countersign', async (ctx) => {
    const d = loadDoctor(ctx);
    const c = latest(d.id);
    if (!c) throw conflict('پزشک هنوز قرارداد را امضا نکرده است', 'not_signed');
    if (c.status !== 'pending_platform') throw conflict('این قرارداد قبلاً امضا شده است', 'already_signed');
    const signature = signatureOf(ctx.body.signature);
    db.run(`UPDATE doctor_contracts SET status = 'active', platform_signature = ?, platform_signed_at = ?, platform_signer_id = ? WHERE id = ?`,
      signature, nowIso(), ctx.user.sub, c.id);
    platform.audit(ctx, 'contract.platform_sign', `doctor:${d.id}`, { contract_id: c.id });
    const u = db.get('SELECT id, phone FROM users WHERE id = ?', d.user_id);
    platform.notify(ctx, { userId: u.id, channel: 'push', target: u.phone, body: 'قرارداد همکاری شما با درمان پلاس به امضای پلتفرم رسید. نسخه امضاشده در بخش «قرارداد همکاری» در دسترس است.' });
    return { body: view(d, latest(d.id), { forAdmin: true }) };
  });
}
