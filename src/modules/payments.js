// Payments: tariffs (admin settings), ZarinPal gateway (v4 REST), entitlements.
// Amounts are stored in Rial (ZarinPal's default unit) and shown to users in Toman.
//   • visit: booking creates a *pending* appointment that holds the slot for 15 minutes;
//     a verified payment confirms it, otherwise it is released automatically.
//   • triage: a paid, unused triage payment is required before an (non-emergency) assessment.
//     Emergency detection is never behind the paywall.
// Without ZARINPAL_MERCHANT_ID in development a mock gateway page is used.
import { ApiError, badRequest, notFound, conflict, requireUuid } from '../lib/http.js';
import { uuid, nowIso, parseJson } from '../lib/db.js';
import { requireUser } from './auth.js';
import { getVisitSettings, setVisitSettings } from '../lib/visit-settings.js';

export const TARIFF_KEYS = ['triage', 'visit_chat', 'visit_audio', 'visit_video'];
export const TARIFF_LABELS = { triage: 'ارزیابی علائم (تریاژ)', visit_chat: 'ویزیت متنی', visit_audio: 'ویزیت صوتی', visit_video: 'ویزیت تصویری' };
const HOLD_MIN = 15;
const toman = (rial) => Math.round(rial / 10).toLocaleString('fa-IR');

export function createPaymentsDomain({ db, platform, config, fetchImpl = globalThis.fetch }) {
  const zp = {
    base: config.zarinpalSandbox ? 'https://sandbox.zarinpal.com' : 'https://payment.zarinpal.com',
    merchant: config.zarinpalMerchantId,
  };
  const gateway = zp.merchant ? 'zarinpal' : config.devMode ? 'mock' : null;

  function getTariffs(tenantId) {
    const row = db.get(`SELECT value FROM settings WHERE tenant_id = ? AND key = 'tariffs'`, tenantId);
    const v = parseJson(row?.value, {});
    return Object.fromEntries(TARIFF_KEYS.map((k) => [k, Number.isInteger(v[k]) && v[k] >= 0 ? v[k] : 0]));
  }

  function setTariffs(ctx, input) {
    const cur = getTariffs(ctx.tenantId);
    for (const k of TARIFF_KEYS) {
      if (input[k] === undefined) continue;
      const n = Number(input[k]);
      if (!Number.isInteger(n) || n < 0 || n > 1e10) throw badRequest(`مبلغ «${TARIFF_LABELS[k]}» نامعتبر است`);
      if (n > 0 && n < 10000) throw badRequest(`حداقل مبلغ قابل پرداخت در درگاه ۱٬۰۰۰ تومان است (${TARIFF_LABELS[k]})`);
      cur[k] = n;
    }
    db.run(
      `INSERT INTO settings (tenant_id, key, value, updated_at, updated_by) VALUES (?, 'tariffs', ?, ?, ?)
       ON CONFLICT (tenant_id, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
      ctx.tenantId, JSON.stringify(cur), nowIso(), ctx.user.sub,
    );
    platform.audit(ctx, 'settings.tariffs', `tenant:${ctx.tenantId}`, cur);
    return cur;
  }

  // Admin switch (e.g. for testing): when off, patients are never charged — visits confirm
  // immediately and triage is free. Stored tariffs are kept for when it is turned back on.
  function paymentsEnabled(tenantId) {
    const row = db.get(`SELECT value FROM settings WHERE tenant_id = ? AND key = 'payments'`, tenantId);
    return parseJson(row?.value, {}).enabled !== false;
  }
  function setPaymentsEnabled(ctx, enabled) {
    if (typeof enabled !== 'boolean') throw badRequest('payments_enabled باید true یا false باشد');
    db.run(
      `INSERT INTO settings (tenant_id, key, value, updated_at, updated_by) VALUES (?, 'payments', ?, ?, ?)
       ON CONFLICT (tenant_id, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
      ctx.tenantId, JSON.stringify({ enabled }), nowIso(), ctx.user.sub,
    );
    platform.audit(ctx, 'settings.payments', `tenant:${ctx.tenantId}`, { enabled });
    return enabled;
  }
  // What patients are actually charged right now.
  const effectiveTariffs = (tenantId) => (paymentsEnabled(tenantId)
    ? getTariffs(tenantId) : Object.fromEntries(TARIFF_KEYS.map((k) => [k, 0])));

  // Platform commission (percent of each visit fee); triage fees belong to the platform entirely.
  function getCommission(tenantId) {
    const row = db.get(`SELECT value FROM settings WHERE tenant_id = ? AND key = 'commission'`, tenantId);
    const v = Number(parseJson(row?.value, {}).percent);
    return Number.isFinite(v) && v >= 0 && v <= 100 ? v : 0;
  }
  function setCommission(ctx, percent) {
    const n = Number(percent);
    if (!Number.isFinite(n) || n < 0 || n > 100 || Math.round(n * 100) !== n * 100) throw badRequest('درصد سهم پلتفرم باید عددی بین ۰ تا ۱۰۰ باشد (حداکثر دو رقم اعشار)');
    db.run(
      `INSERT INTO settings (tenant_id, key, value, updated_at, updated_by) VALUES (?, 'commission', ?, ?, ?)
       ON CONFLICT (tenant_id, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
      ctx.tenantId, JSON.stringify({ percent: n }), nowIso(), ctx.user.sub,
    );
    platform.audit(ctx, 'settings.commission', `tenant:${ctx.tenantId}`, { percent: n });
    return n;
  }
  const split = (amount, percent) => {
    const platformAmount = Math.round((amount * percent) / 100);
    return { platform_amount: platformAmount, doctor_amount: amount - platformAmount };
  };

  function create(ctx, { userId, purpose, refId = null, amount, description, doctorId = null }) {
    const id = uuid();
    const percent = purpose === 'appointment' ? getCommission(ctx.tenantId) : 100;
    const sp = purpose === 'appointment' ? split(amount, percent) : { platform_amount: amount, doctor_amount: 0 };
    db.run(
      `INSERT INTO payments (id, tenant_id, user_id, purpose, ref_id, amount, status, gateway, description, created_at,
         doctor_id, commission_percent, platform_amount, doctor_amount)
       VALUES (?,?,?,?,?,?,'pending',?,?,?,?,?,?,?)`,
      id, ctx.tenantId, userId, purpose, refId, amount, gateway ?? 'none', description, nowIso(),
      doctorId, percent, sp.platform_amount, sp.doctor_amount,
    );
    return db.get('SELECT * FROM payments WHERE id = ?', id);
  }

  const view = (p) => p && ({
    id: p.id, purpose: p.purpose, ref_id: p.ref_id, amount: p.amount, amount_toman: Math.round(p.amount / 10),
    status: p.status, gateway: p.gateway, ref_number: p.ref_number, card_pan: p.card_pan,
    description: p.description, created_at: p.created_at, paid_at: p.paid_at,
    commission_percent: p.commission_percent, platform_amount: p.platform_amount, doctor_amount: p.doctor_amount,
  });

  // Ask the gateway for an authority and return the URL the payer must open.
  async function start(ctx, p, baseUrl) {
    if (p.status !== 'pending') throw conflict('این پرداخت قابل انجام نیست', 'payment_not_pending');
    if (!gateway) throw new ApiError(503, 'gateway_unavailable', 'درگاه پرداخت پیکربندی نشده است');
    const callback = `${baseUrl}/v1/payments/callback`;
    let authority;
    if (gateway === 'mock') {
      authority = `MOCK${uuid().replace(/-/g, '').slice(0, 28)}`;
    } else {
      const user = db.get('SELECT phone FROM users WHERE id = ?', p.user_id);
      let body;
      try {
        const res = await fetchImpl(`${zp.base}/pg/v4/payment/request.json`, {
          method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
          body: JSON.stringify({ merchant_id: zp.merchant, amount: p.amount, callback_url: callback, description: p.description, metadata: { mobile: user?.phone } }),
          signal: AbortSignal.timeout(15000),
        });
        body = await res.json();
      } catch (e) {
        console.error('[zarinpal] request failed', e.message);
        throw new ApiError(503, 'gateway_unavailable', 'اتصال به درگاه پرداخت برقرار نشد؛ دوباره تلاش کنید');
      }
      if (body?.data?.code !== 100 || !body.data.authority) {
        console.error('[zarinpal] request rejected', JSON.stringify(body?.errors ?? body)?.slice(0, 300));
        throw new ApiError(502, 'gateway_error', 'درگاه پرداخت درخواست را نپذیرفت');
      }
      authority = body.data.authority;
    }
    db.run('UPDATE payments SET authority = ? WHERE id = ?', authority, p.id);
    platform.audit(ctx, 'payment.start', `payment:${p.id}`, { gateway, amount: p.amount });
    const url = gateway === 'mock' ? `${baseUrl}/v1/payments/mock/${authority}` : `${zp.base}/pg/StartPay/${authority}`;
    return { pay_url: url, authority };
  }

  // Gateway callback: verify with the gateway (never trust the redirect alone).
  async function verify(ctx, authority, status) {
    const p = db.get('SELECT * FROM payments WHERE authority = ?', String(authority ?? ''));
    if (!p) throw notFound('پرداخت');
    if (p.status === 'paid') return p;
    if (p.status !== 'pending' && p.status !== 'expired') return p;
    if (status !== 'OK') {
      db.run(`UPDATE payments SET status = 'failed' WHERE id = ? AND status IN ('pending','expired')`, p.id);
      platform.audit({ ...ctx, tenantId: p.tenant_id }, 'payment.failed', `payment:${p.id}`);
      return db.get('SELECT * FROM payments WHERE id = ?', p.id);
    }
    let refNumber = null;
    let cardPan = null;
    if (p.gateway === 'zarinpal') {
      let body;
      try {
        const res = await fetchImpl(`${zp.base}/pg/v4/payment/verify.json`, {
          method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
          body: JSON.stringify({ merchant_id: zp.merchant, amount: p.amount, authority: p.authority }),
          signal: AbortSignal.timeout(15000),
        });
        body = await res.json();
      } catch (e) {
        console.error('[zarinpal] verify failed', e.message);
        throw new ApiError(503, 'gateway_unavailable', 'تأیید پرداخت با درگاه ممکن نشد؛ اگر مبلغ کسر شده، ظرف ۷۲ ساعت برگشت داده می‌شود');
      }
      const code = body?.data?.code;
      if (code !== 100 && code !== 101) {
        db.run(`UPDATE payments SET status = 'failed' WHERE id = ?`, p.id);
        platform.audit({ ...ctx, tenantId: p.tenant_id }, 'payment.verify_failed', `payment:${p.id}`, { code: code ?? body?.errors?.code });
        return db.get('SELECT * FROM payments WHERE id = ?', p.id);
      }
      refNumber = String(body.data.ref_id ?? '');
      cardPan = body.data.card_pan ?? null;
    } else {
      refNumber = `MOCK-${Date.now()}`;
    }
    db.run(`UPDATE payments SET status = 'paid', ref_number = ?, card_pan = ?, paid_at = ? WHERE id = ?`, refNumber, cardPan, nowIso(), p.id);
    const paid = db.get('SELECT * FROM payments WHERE id = ?', p.id);
    platform.audit({ ...ctx, tenantId: p.tenant_id, user: { sub: p.user_id } }, 'payment.paid', `payment:${p.id}`, { amount: p.amount, ref: refNumber });
    onPaid({ ...ctx, tenantId: p.tenant_id, user: { sub: p.user_id } }, paid);
    return db.get('SELECT * FROM payments WHERE id = ?', p.id);
  }

  // Effects of a successful payment.
  function onPaid(ctx, p) {
    if (p.purpose !== 'appointment') return;
    const a = db.get('SELECT * FROM appointments WHERE id = ?', p.ref_id);
    if (!a) return;
    const slot = db.get('SELECT starts_at FROM slots WHERE id = ?', a.slot_id);
    let ok = a.status === 'pending';
    if (a.status === 'cancelled') {
      // Paid after the hold expired: re-confirm only if nobody else took the slot meanwhile.
      const taken = db.get(`SELECT 1 FROM appointments WHERE slot_id = ? AND status IN ('pending','confirmed') AND id != ?`, a.slot_id, a.id);
      ok = !taken && slot && slot.starts_at > nowIso();
    }
    if (ok) {
      db.run(`UPDATE appointments SET status = 'confirmed', payment_due_at = NULL, updated_at = ? WHERE id = ?`, nowIso(), a.id);
      platform.publish(ctx, 'appointment.booked', {
        appointment_id: a.id, patient_id: a.patient_id, doctor_id: a.doctor_id, slot_id: a.slot_id, starts_at: slot?.starts_at, booked_via: a.booked_via,
      });
    } else if (a.status !== 'confirmed') {
      db.run(`UPDATE payments SET status = 'refund_required' WHERE id = ?`, p.id);
      for (const ad of db.all(`SELECT id, phone FROM users WHERE tenant_id = ? AND role = 'admin'`, p.tenant_id)) {
        platform.notify(ctx, { userId: ad.id, channel: 'push', target: ad.phone, body: `پرداخت ${p.ref_number} برای نوبتی که از دست رفته انجام شد؛ بازگشت وجه لازم است.` });
      }
    }
  }

  // Appointment booking hook: returns { status, payment } for the new appointment.
  function forAppointment(ctx, { appointmentId, patientUserId, channel, doctorName }) {
    const fee = effectiveTariffs(ctx.tenantId)[`visit_${channel}`];
    if (!fee) return { status: 'confirmed', payment: null };
    const doctorId = db.get('SELECT doctor_id FROM appointments WHERE id = ?', appointmentId)?.doctor_id ?? null;
    const payment = create(ctx, {
      userId: patientUserId, purpose: 'appointment', refId: appointmentId, amount: fee, doctorId,
      description: `هزینه ${TARIFF_LABELS[`visit_${channel}`]} با ${doctorName ?? 'پزشک'}`,
    });
    return { status: 'pending', payment, due_at: new Date(Date.now() + HOLD_MIN * 60000).toISOString() };
  }

  // Triage entitlement.
  const triageFee = (tenantId) => effectiveTariffs(tenantId).triage;
  const availableTriage = (userId) => db.get(
    `SELECT * FROM payments WHERE user_id = ? AND purpose = 'triage' AND status = 'paid' AND consumed_at IS NULL ORDER BY paid_at LIMIT 1`, userId,
  );
  function triageAllowed(ctx) {
    return !triageFee(ctx.tenantId) || !!availableTriage(ctx.user.sub);
  }
  function consumeTriage(ctx) {
    if (!triageFee(ctx.tenantId)) return;
    const p = availableTriage(ctx.user.sub);
    if (p) db.run('UPDATE payments SET consumed_at = ? WHERE id = ?', nowIso(), p.id);
  }
  function triagePayment(ctx) {
    const pending = db.get(`SELECT * FROM payments WHERE user_id = ? AND purpose = 'triage' AND status = 'pending' AND created_at > ? ORDER BY created_at DESC LIMIT 1`,
      ctx.user.sub, new Date(Date.now() - 3600e3).toISOString());
    return pending ?? create(ctx, { userId: ctx.user.sub, purpose: 'triage', amount: triageFee(ctx.tenantId), description: 'هزینه ارزیابی علائم (تریاژ)' });
  }

  // Release unpaid holds.
  function sweep() {
    const now = nowIso();
    const due = db.all(`SELECT id, tenant_id FROM appointments WHERE status = 'pending' AND payment_due_at IS NOT NULL AND payment_due_at < ?`, now);
    for (const a of due) {
      db.run(`UPDATE appointments SET status = 'cancelled', updated_at = ? WHERE id = ? AND status = 'pending'`, now, a.id);
      db.run(`UPDATE payments SET status = 'expired' WHERE purpose = 'appointment' AND ref_id = ? AND status = 'pending'`, a.id);
      platform.audit({ tenantId: a.tenant_id }, 'appointment.hold_expired', `appointment:${a.id}`);
    }
    return due.length;
  }
  if (!config.disableSweeper) setInterval(sweep, 60_000).unref();

  return { getTariffs, setTariffs, getCommission, setCommission, split, paymentsEnabled, setPaymentsEnabled, effectiveTariffs, create, start, verify, view, forAppointment, triageAllowed, consumeTriage, triagePayment, triageFee, sweep, gateway, toman, HOLD_MIN };
}

const RESULT_PAGE = (ok, title, detail) => `<!doctype html><html lang="fa" dir="rtl"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><title>${title}</title>
<style>body{font-family:Vazirmatn,Tahoma,sans-serif;background:#f5f7f8;color:#17212b;display:flex;min-height:100vh;align-items:center;justify-content:center;margin:0;padding:16px}
.c{background:#fff;border-radius:16px;padding:28px;max-width:420px;text-align:center;box-shadow:0 2px 8px rgb(0 0 0/8%)}
.i{font-size:56px}.b{display:inline-block;margin-top:16px;padding:10px 18px;border-radius:10px;background:#1976D2;color:#fff;text-decoration:none}
button.b{border:0;font:inherit;cursor:pointer}.n{background:#b42318}</style></head><body><div class="c">
<div class="i">${ok ? '✅' : '❌'}</div><h2>${title}</h2><p>${detail}</p>
<p style="color:#5d6b78;font-size:14px">اگر از اپ وارد شده‌اید، به اپ «درمان پلاس» برگردید؛ وضعیت خودکار به‌روز می‌شود.</p>
<a class="b" href="/#appointments">بازگشت به کلینیک</a></div></body></html>`;
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export function register(router, { db, platform, config, domain }) {
  const pay = domain.payments;
  const baseUrl = (ctx) => config.publicBaseUrl
    || `${ctx.req.headers['x-forwarded-proto'] === 'https' ? 'https' : 'http'}://${ctx.req.headers['x-forwarded-host'] ?? ctx.req.headers.host}`;

  const mine = (ctx, id) => {
    const p = db.get('SELECT * FROM payments WHERE id = ? AND tenant_id = ?', requireUuid(id, 'id'), ctx.tenantId);
    if (!p || (p.user_id !== ctx.user.sub && ctx.user.role !== 'admin')) throw notFound('پرداخت');
    return p;
  };

  router.get('/v1/tariffs', async (ctx) => {
    const t = pay.effectiveTariffs(ctx.tenantId);
    return { body: { items: Object.entries(t).map(([k, rial]) => ({ key: k, label: TARIFF_LABELS[k], amount: rial, amount_toman: Math.round(rial / 10) })), gateway: pay.gateway, payments_enabled: pay.paymentsEnabled(ctx.tenantId) } };
  });

  router.get('/v1/admin/settings', async (ctx) => {
    domain.access.require(ctx, 'tariffs.manage');
    return { body: { tariffs: pay.getTariffs(ctx.tenantId), payments_enabled: pay.paymentsEnabled(ctx.tenantId), commission_percent: pay.getCommission(ctx.tenantId), visit: getVisitSettings(db, ctx.tenantId), labels: TARIFF_LABELS, gateway: pay.gateway, sandbox: !!config.zarinpalSandbox } };
  });

  router.put('/v1/admin/settings', async (ctx) => {
    domain.access.require(ctx, 'tariffs.manage');
    if (ctx.body.payments_enabled !== undefined) pay.setPaymentsEnabled(ctx, ctx.body.payments_enabled);
    if (ctx.body.commission_percent !== undefined) pay.setCommission(ctx, ctx.body.commission_percent);
    if (ctx.body.visit !== undefined) {
      const v = setVisitSettings(db, ctx, ctx.body.visit ?? {});
      platform.audit(ctx, 'settings.visit', `tenant:${ctx.tenantId}`, v);
    }
    const tariffs = ctx.body.tariffs ? pay.setTariffs(ctx, ctx.body.tariffs) : pay.getTariffs(ctx.tenantId);
    return { body: { tariffs, payments_enabled: pay.paymentsEnabled(ctx.tenantId), commission_percent: pay.getCommission(ctx.tenantId), visit: getVisitSettings(db, ctx.tenantId) } };
  });

  router.get('/v1/payments', async (ctx) => {
    requireUser(ctx);
    const rows = ctx.query.all && domain.access.can(ctx, 'payments.view')
      ? db.all('SELECT * FROM payments WHERE tenant_id = ? ORDER BY created_at DESC LIMIT 200', ctx.tenantId)
      : db.all('SELECT * FROM payments WHERE user_id = ? ORDER BY created_at DESC LIMIT 50', ctx.user.sub);
    return { body: { items: rows.map(pay.view) } };
  });

  router.get('/v1/payments/entitlements', async (ctx) => {
    requireUser(ctx, 'patient');
    const fee = pay.triageFee(ctx.tenantId);
    return { body: { triage: { fee, fee_toman: Math.round(fee / 10), available: pay.triageAllowed(ctx) } } };
  });

  // Patient buys a triage assessment.
  router.post('/v1/payments/triage', async (ctx) => {
    requireUser(ctx, 'patient');
    if (pay.triageAllowed(ctx)) return { body: { already_available: true } };
    const p = pay.triagePayment(ctx);
    const s = await pay.start(ctx, p, baseUrl(ctx));
    return { status: 201, body: { ...pay.view(db.get('SELECT * FROM payments WHERE id = ?', p.id)), ...s } };
  });

  router.get('/v1/payments/:id', async (ctx) => {
    requireUser(ctx);
    return { body: pay.view(mine(ctx, ctx.params.id)) };
  });

  // (Re)start a pending payment — e.g. the patient closed the gateway page.
  router.post('/v1/payments/:id/start', async (ctx) => {
    requireUser(ctx);
    const p = mine(ctx, ctx.params.id);
    if (p.purpose === 'appointment') {
      const a = db.get('SELECT status FROM appointments WHERE id = ?', p.ref_id);
      if (a?.status !== 'pending') throw conflict('مهلت پرداخت این نوبت تمام شده است؛ دوباره نوبت بگیرید', 'hold_expired');
    }
    const s = await pay.start(ctx, p, baseUrl(ctx));
    return { body: { ...pay.view(db.get('SELECT * FROM payments WHERE id = ?', p.id)), ...s } };
  });

  // Gateway redirect target (ZarinPal sends ?Authority=…&Status=OK|NOK).
  router.get('/v1/payments/callback', async (ctx) => {
    let p;
    try {
      p = await pay.verify(ctx, ctx.query.Authority, ctx.query.Status);
    } catch (e) {
      ctx.res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      ctx.res.end(RESULT_PAGE(false, 'تأیید پرداخت ناموفق بود', esc(e.message)));
      return null;
    }
    const ok = p.status === 'paid';
    ctx.res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    ctx.res.end(ok
      ? RESULT_PAGE(true, 'پرداخت موفق', `مبلغ ${pay.toman(p.amount)} تومان پرداخت شد. کد پیگیری: <b dir="ltr">${esc(p.ref_number)}</b>`)
      : p.status === 'refund_required'
        ? RESULT_PAGE(false, 'نوبت از دست رفت', 'مهلت رزرو تمام شده و زمان به بیمار دیگری رسیده است. مبلغ پرداختی بازگردانده می‌شود.')
        : RESULT_PAGE(false, 'پرداخت انجام نشد', 'پرداخت لغو شد یا ناموفق بود. می‌توانید دوباره تلاش کنید.'));
    return null;
  });

  // Development-only stand-in for the ZarinPal payment page.
  router.get('/v1/payments/mock/:authority', async (ctx) => {
    if (pay.gateway !== 'mock') throw notFound('صفحه');
    const p = db.get('SELECT * FROM payments WHERE authority = ?', ctx.params.authority);
    if (!p) throw notFound('پرداخت');
    const a = encodeURIComponent(ctx.params.authority);
    ctx.res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    ctx.res.end(RESULT_PAGE(true, 'درگاه آزمایشی', `${esc(p.description)}<br>مبلغ: <b>${pay.toman(p.amount)} تومان</b></p>
      <p><a class="b" href="/v1/payments/callback?Authority=${a}&Status=OK">پرداخت موفق</a>
      <a class="b n" href="/v1/payments/callback?Authority=${a}&Status=NOK">انصراف</a>`).replace('✅', '🧪'));
    return null;
  });
}
