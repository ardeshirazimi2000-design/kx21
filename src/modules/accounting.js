// Accounting: each visit payment is split at creation into platform commission and doctor share
// (payments.commission_percent / platform_amount / doctor_amount). A doctor's share is "earned"
// once the visit has taken place (appointment completed or no-show), "pending" while the visit
// is still ahead, and excluded when the visit was cancelled after payment (refund due).
// Payouts to doctors are recorded by staff with the accounting.payout permission.
import { badRequest, conflict, notFound, requireUuid } from '../lib/http.js';
import { uuid, nowIso } from '../lib/db.js';
import { requireUser } from './auth.js';
import { toJalali } from '../../public/jalali.js';

const EARNED = ['completed', 'no_show'];
const PENDING = ['pending', 'confirmed'];

/** Iranian IBAN (شبا): IR + 24 digits, ISO 13616 mod-97 check. */
export function normalizeSheba(v) {
  const s = String(v ?? '').replace(/[\s-]/g, '').toUpperCase().replace(/[۰-۹]/g, (d) => '۰۱۲۳۴۵۶۷۸۹'.indexOf(d));
  const full = /^\d{24}$/.test(s) ? `IR${s}` : s;
  if (!/^IR\d{24}$/.test(full)) return null;
  const rearranged = full.slice(4) + '1827' + full.slice(2, 4); // I=18, R=27
  return BigInt(rearranged) % 97n === 1n ? full : null;
}
const maskSheba = (s) => (s ? `${s.slice(0, 4)}…${s.slice(-4)}` : null);

const jMonth = (iso) => { const d = new Date(iso); const j = toJalali(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate()); return `${j.jy}/${String(j.jm).padStart(2, '0')}`; };
const range = (q) => {
  const ok = (x) => /^\d{4}-\d{2}-\d{2}$/.test(String(x ?? '')) && !isNaN(Date.parse(x));
  return { from: ok(q.from) ? `${q.from}T00:00:00.000Z` : '0000', to: ok(q.to) ? `${q.to}T23:59:59.999Z` : '9999' };
};

export function register(router, { db, platform, domain }) {
  // Visit payments with their split (older payments without a split count fully for the doctor).
  const visitRows = (tenantId, { doctorId = null, from = '0000', to = '9999' } = {}) => db.all(
    `SELECT p.id, p.amount, p.status AS pay_status, p.paid_at, p.ref_number,
            COALESCE(p.doctor_id, a.doctor_id) AS doctor_id, COALESCE(p.commission_percent, 0) AS commission_percent,
            COALESCE(p.platform_amount, 0) AS platform_amount, COALESCE(p.doctor_amount, p.amount) AS doctor_amount,
            a.id AS appointment_id, a.status AS appt_status, a.refund_policy, a.channel, s.starts_at, u.full_name AS patient_name
     FROM payments p JOIN appointments a ON a.id = p.ref_id JOIN slots s ON s.id = a.slot_id
     JOIN patients pt ON pt.id = a.patient_id JOIN users u ON u.id = pt.user_id
     WHERE p.tenant_id = ? AND p.purpose = 'appointment' AND p.status IN ('paid','refund_required','refunded')
       AND p.paid_at >= ? AND p.paid_at <= ? ${doctorId ? 'AND COALESCE(p.doctor_id, a.doctor_id) = ?' : ''}
     ORDER BY p.paid_at DESC`,
    tenantId, from, to, ...(doctorId ? [doctorId] : []),
  );
  // A visit the patient cancelled too late keeps its fee (cancellation rules): earned like a visit.
  const state = (r) => (r.pay_status !== 'paid' ? 'refund'
    : EARNED.includes(r.appt_status) || r.refund_policy === 'forfeit' ? 'earned' : PENDING.includes(r.appt_status) ? 'pending' : 'refund');
  const sum = (rows, k) => rows.reduce((a, r) => a + (r[k] ?? 0), 0);
  const payoutsOf = (doctorId, from = '0000', to = '9999') => db.all(
    'SELECT * FROM doctor_payouts WHERE doctor_id = ? AND paid_at >= ? AND paid_at <= ? ORDER BY paid_at DESC', doctorId, from, to,
  );
  function balanceOf(tenantId, doctorId) {
    const rows = visitRows(tenantId, { doctorId });
    const earned = sum(rows.filter((r) => state(r) === 'earned'), 'doctor_amount');
    const pending = sum(rows.filter((r) => state(r) === 'pending'), 'doctor_amount');
    const paidOut = db.get('SELECT COALESCE(SUM(amount), 0) AS n FROM doctor_payouts WHERE doctor_id = ?', doctorId).n;
    return { earned, pending, paid_out: paidOut, balance: earned - paidOut };
  }
  const itemView = (r) => ({
    payment_id: r.id, appointment_id: r.appointment_id, visit_at: r.starts_at, paid_at: r.paid_at, channel: r.channel,
    patient_name: r.patient_name, amount: r.amount, commission_percent: r.commission_percent, platform_amount: r.platform_amount,
    doctor_amount: r.doctor_amount, state: state(r), ref_number: r.ref_number,
  });
  const payoutView = (p) => ({ id: p.id, amount: p.amount, paid_at: p.paid_at, reference: p.reference, sheba: maskSheba(p.sheba), note: p.note, created_at: p.created_at });

  // ---- doctor: own accounting + bank account
  router.get('/v1/doctors/me/accounting', async (ctx) => {
    requireUser(ctx, 'doctor');
    const d = db.get('SELECT id, sheba FROM doctors WHERE id = ?', ctx.user.did ?? '-');
    if (!d) throw notFound('پزشک');
    const { from, to } = range(ctx.query);
    const rows = visitRows(ctx.tenantId, { doctorId: d.id, from, to });
    const earned = rows.filter((r) => state(r) === 'earned');
    return {
      body: {
        sheba: d.sheba, range: { from: ctx.query.from ?? null, to: ctx.query.to ?? null },
        period: {
          visits: earned.length, gross: sum(earned, 'amount'), commission: sum(earned, 'platform_amount'), net: sum(earned, 'doctor_amount'),
          pending_visits: rows.filter((r) => state(r) === 'pending').length, pending_net: sum(rows.filter((r) => state(r) === 'pending'), 'doctor_amount'),
        },
        overall: balanceOf(ctx.tenantId, d.id),
        items: rows.slice(0, 300).map(itemView),
        payouts: payoutsOf(d.id).map(payoutView),
      },
    };
  });

  router.put('/v1/doctors/me/sheba', async (ctx) => {
    requireUser(ctx, 'doctor');
    const sheba = normalizeSheba(ctx.body.sheba);
    if (!sheba) throw badRequest('شماره شبا معتبر نیست (IR و ۲۴ رقم)', 'invalid_sheba');
    db.run('UPDATE doctors SET sheba = ? WHERE id = ?', sheba, ctx.user.did ?? '-');
    platform.audit(ctx, 'doctor.sheba', `doctor:${ctx.user.did}`, { sheba: maskSheba(sheba) });
    return { body: { sheba } };
  });

  // ---- clinic-wide accounting
  router.get('/v1/admin/accounting', async (ctx) => {
    domain.access.require(ctx, 'accounting.view');
    const { from, to } = range(ctx.query);
    const visits = visitRows(ctx.tenantId, { from, to });
    const earned = visits.filter((r) => state(r) === 'earned');
    const pending = visits.filter((r) => state(r) === 'pending');
    const refunds = visits.filter((r) => state(r) === 'refund');
    const triage = db.all(`SELECT amount, paid_at FROM payments WHERE tenant_id = ? AND purpose = 'triage' AND status = 'paid' AND paid_at >= ? AND paid_at <= ?`, ctx.tenantId, from, to);
    const payouts = db.all('SELECT * FROM doctor_payouts WHERE tenant_id = ? AND paid_at >= ? AND paid_at <= ?', ctx.tenantId, from, to);

    const months = new Map();
    const m = (iso) => { const k = jMonth(iso); if (!months.has(k)) months.set(k, { month: k, gross: 0, platform: 0, doctors: 0, triage: 0, payouts: 0 }); return months.get(k); };
    for (const r of visits.filter((x) => state(x) !== 'refund')) { const x = m(r.paid_at); x.gross += r.amount; x.platform += r.platform_amount; x.doctors += r.doctor_amount; }
    for (const t of triage) { const x = m(t.paid_at); x.gross += t.amount; x.triage += t.amount; }
    for (const p of payouts) m(p.paid_at).payouts += p.amount;

    const doctors = db.all(`SELECT d.id, d.sheba, d.specialty, u.full_name FROM doctors d JOIN users u ON u.id = d.user_id WHERE d.tenant_id = ? AND d.deleted_at IS NULL ORDER BY u.full_name`, ctx.tenantId)
      .map((d) => ({ doctor_id: d.id, full_name: d.full_name, sheba: maskSheba(d.sheba), has_sheba: !!d.sheba, visits_in_range: earned.filter((r) => r.doctor_id === d.id).length, ...balanceOf(ctx.tenantId, d.id) }))
      .filter((d) => d.earned || d.pending || d.paid_out);

    return {
      body: {
        range: { from: ctx.query.from ?? null, to: ctx.query.to ?? null },
        totals: {
          gross_received: sum(visits.filter((r) => state(r) !== 'refund'), 'amount') + sum(triage, 'amount'),
          visits_earned_gross: sum(earned, 'amount'), platform_commission: sum(earned, 'platform_amount'), triage_income: sum(triage, 'amount'),
          platform_income: sum(earned, 'platform_amount') + sum(triage, 'amount'),
          doctors_share_earned: sum(earned, 'doctor_amount'), doctors_share_pending: sum(pending, 'doctor_amount'),
          refunds_due: { count: refunds.filter((r) => r.pay_status !== 'refunded').length, amount: sum(refunds.filter((r) => r.pay_status !== 'refunded'), 'amount') },
          payouts: sum(payouts, 'amount'),
          doctors_balance_all_time: doctors.reduce((a, d) => a + d.balance, 0),
        },
        months: [...months.values()].sort((a, b) => b.month.localeCompare(a.month)),
        doctors,
      },
    };
  });

  router.get('/v1/admin/accounting/doctors/:id', async (ctx) => {
    domain.access.require(ctx, 'accounting.view');
    const d = db.get('SELECT d.id, d.sheba, u.full_name FROM doctors d JOIN users u ON u.id = d.user_id WHERE d.id = ? AND d.tenant_id = ?', requireUuid(ctx.params.id, 'id'), ctx.tenantId);
    if (!d) throw notFound('پزشک');
    const { from, to } = range(ctx.query);
    return {
      body: {
        doctor_id: d.id, full_name: d.full_name, sheba: d.sheba, ...balanceOf(ctx.tenantId, d.id),
        items: visitRows(ctx.tenantId, { doctorId: d.id, from, to }).slice(0, 500).map(itemView),
        payouts: payoutsOf(d.id).map((p) => ({ ...payoutView(p), sheba: p.sheba })),
      },
    };
  });

  // Record a settlement paid to a doctor (by bank transfer outside the system).
  router.post('/v1/admin/accounting/payouts', async (ctx) => {
    domain.access.require(ctx, 'accounting.payout');
    const b = ctx.body ?? {};
    const d = db.get('SELECT d.id, d.sheba, d.user_id FROM doctors d WHERE d.id = ? AND d.tenant_id = ?', requireUuid(b.doctor_id, 'doctor_id'), ctx.tenantId);
    if (!d) throw notFound('پزشک');
    const amount = Number(b.amount);
    if (!Number.isInteger(amount) || amount <= 0) throw badRequest('مبلغ تسویه نامعتبر است (ریال، عدد صحیح)');
    const bal = balanceOf(ctx.tenantId, d.id);
    if (amount > bal.balance) throw conflict(`مبلغ از مانده قابل تسویه پزشک (${Math.round(bal.balance / 10).toLocaleString('fa-IR')} تومان) بیشتر است`, 'exceeds_balance');
    const reference = String(b.reference ?? '').trim().slice(0, 80);
    if (reference.length < 3) throw badRequest('شماره پیگیری / مرجع واریز را وارد کنید');
    const paidAt = /^\d{4}-\d{2}-\d{2}/.test(String(b.paid_at ?? '')) && !isNaN(Date.parse(b.paid_at)) ? new Date(b.paid_at).toISOString() : nowIso();
    const id = uuid();
    db.run('INSERT INTO doctor_payouts (id, tenant_id, doctor_id, amount, paid_at, reference, sheba, note, created_by, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)',
      id, ctx.tenantId, d.id, amount, paidAt, reference, d.sheba, String(b.note ?? '').trim().slice(0, 300) || null, ctx.user.sub, nowIso());
    platform.audit(ctx, 'accounting.payout', `doctor:${d.id}`, { amount, reference });
    const u = db.get('SELECT phone FROM users WHERE id = ?', d.user_id);
    platform.notify(ctx, { userId: d.user_id, channel: 'sms', target: u?.phone, body: `تسویه ${Math.round(amount / 10).toLocaleString('fa-IR')} تومان برای شما ثبت شد (مرجع ${reference}).` });
    return { status: 201, body: { id, ...balanceOf(ctx.tenantId, d.id) } };
  });

  // CSV for the accountant (UTF-8 with BOM so Excel shows Persian correctly).
  router.get('/v1/admin/accounting/export', async (ctx) => {
    domain.access.require(ctx, 'accounting.view');
    const { from, to } = range(ctx.query);
    const names = new Map(db.all('SELECT d.id, u.full_name FROM doctors d JOIN users u ON u.id = d.user_id WHERE d.tenant_id = ?', ctx.tenantId).map((r) => [r.id, r.full_name]));
    const st = { earned: 'انجام‌شده', pending: 'در انتظار ویزیت', refund: 'بازگشت وجه' };
    const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const lines = [['تاریخ پرداخت', 'تاریخ ویزیت', 'پزشک', 'بیمار', 'نوع', 'مبلغ (ریال)', 'درصد پلتفرم', 'سهم پلتفرم', 'سهم پزشک', 'وضعیت', 'کد پیگیری'].map(esc).join(',')];
    for (const r of visitRows(ctx.tenantId, { from, to })) {
      lines.push([r.paid_at, r.starts_at, names.get(r.doctor_id), r.patient_name, r.channel, r.amount, r.commission_percent, r.platform_amount, r.doctor_amount, st[state(r)], r.ref_number].map(esc).join(','));
    }
    for (const t of db.all(`SELECT * FROM payments WHERE tenant_id = ? AND purpose = 'triage' AND status = 'paid' AND paid_at >= ? AND paid_at <= ?`, ctx.tenantId, from, to)) {
      lines.push([t.paid_at, '', '', '', 'triage', t.amount, 100, t.amount, 0, 'تریاژ', t.ref_number].map(esc).join(','));
    }
    platform.audit(ctx, 'accounting.export', `tenant:${ctx.tenantId}`, { from: ctx.query.from ?? null, to: ctx.query.to ?? null });
    ctx.res.writeHead(200, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="accounting.csv"' });
    ctx.res.end(`﻿${lines.join('\r\n')}\r\n`);
    return null;
  });
}
