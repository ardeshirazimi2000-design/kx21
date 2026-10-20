// Real SMS delivery (Kavenegar / SMS.ir templates) and production mode (no codes on screen,
// real administrator, demo accounts disabled).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSms } from '../src/lib/sms.js';
import { startApp, randomNationalId } from './helpers.js';
import { DEMO_ACCOUNTS, bootstrapProduction } from '../src/seed.js';

test('Kavenegar verify/lookup and SMS.ir send/verify requests', async () => {
  const calls = [];
  const fake = (body) => async (url, init) => { calls.push({ url: String(url), init }); return { status: 200, json: async () => body }; };
  const kv = createSms({ smsProvider: 'kavenegar', smsApiKey: 'K3Y', smsOtpTemplate: 'clinic-otp' }, fake({ return: { status: 200 }, entries: [{ messageid: 77 }] }));
  assert.equal((await kv.sendOtp('09121234567', '123456')).id, '77');
  assert.equal(calls[0].url, 'https://api.kavenegar.com/v1/K3Y/verify/lookup.json?receptor=09121234567&token=123456&template=clinic-otp');
  const ir = createSms({ smsProvider: 'smsir', smsApiKey: 'K', smsOtpTemplate: '123456', smsMfaTemplate: '654321', smsTemplateParam: 'CODE' }, fake({ status: 1, data: { messageId: 9 } }));
  await ir.sendOtp('09121234567', '111222', 'mfa');
  assert.equal(calls[1].url, 'https://api.sms.ir/v1/send/verify');
  assert.equal(calls[1].init.headers['x-api-key'], 'K');
  assert.deepEqual(JSON.parse(calls[1].init.body), { mobile: '09121234567', templateId: 654321, parameters: [{ name: 'CODE', value: '111222' }] });
  const bad = createSms({ smsProvider: 'smsir', smsApiKey: 'K', smsOtpTemplate: '1' }, fake({ status: 0, message: 'اعتبار کافی نیست' }));
  await assert.rejects(bad.sendOtp('09121234567', '1'), /اعتبار/);
  assert.equal(ir.canSendText, false); // no sender line → notifications stay in-app

  // api.ir SmsOTP (default): the Shahkar token, template number 1.
  const sm = createSms({ smsProvider: 'apiir', sapiToken: 'TOK' }, fake({ data: true, success: true, code: 0, message: '' }));
  assert.equal(sm.delivery, 'sms');
  await sm.sendOtp('09120000000', '123456');
  assert.equal(calls.at(-1).url, 'https://s.api.ir/api/sw1/SmsOTP');
  // Exactly api.ir's curl sample: body {code, mobile, template}, curl-like headers.
  assert.deepEqual(JSON.parse(calls.at(-1).init.body), { code: '123456', mobile: '09120000000', template: 1 });
  assert.deepEqual(Object.keys(calls.at(-1).init.headers).sort(), ['Accept', 'Authorization', 'Content-Type', 'User-Agent']);
  // api.ir CallOTP: the code is read out in a phone call.
  const ap = createSms({ smsProvider: 'apiir', smsApiirService: 'CallOTP', sapiToken: ' "Bearer TOK" ', sapiBase: 'https://s.api.ir/api/sw1' }, fake({ data: true, success: true, code: 0, message: '' }));
  assert.equal(ap.enabled, true);
  assert.equal(ap.delivery, 'voice');
  await ap.sendOtp('09121112222', '12345');
  const last = calls.at(-1);
  assert.equal(last.url, 'https://s.api.ir/api/sw1/CallOTP');
  assert.equal(last.init.headers.Authorization, 'Bearer TOK');
  assert.deepEqual(JSON.parse(last.init.body), { code: '12345', number: '09121112222' });
  const apBad = createSms({ smsProvider: 'apiir', sapiToken: 'T' }, fake({ data: null, success: false, code: 402, message: 'اعتبار ناکافی' }));
  await assert.rejects(apBad.sendOtp('09121112222', '1'), /اعتبار ناکافی/);
});

test('production: codes only by SMS, real admin bootstrapped, demo accounts disabled', async () => {
  const t = await startApp({ devMode: false, seed: true, adminPhone: '09129990000', masterSecret: 'test-secret-production-mode-0123456789' });
  try {
    // Without an SMS provider nobody can receive a code → login refused, never shown on screen.
    t.app.domain.sms.enabled = false;
    const no = await t.call('POST', '/v1/auth/otp/request', { body: { phone: '09129990000', role: 'doctor' } });
    assert.equal(no.body.code, 'sms_unavailable');

    const sent = [];
    Object.assign(t.app.domain.sms, { enabled: true, sendOtp: async (mobile, code, purpose) => { sent.push({ mobile, code, purpose }); return { id: '1' }; } });
    const r = await t.call('POST', '/v1/auth/otp/request', { body: { phone: '09129990000', role: 'doctor' } });
    assert.equal(r.status, 202);
    assert.equal(r.body.dev_code, undefined);
    const v = await t.call('POST', '/v1/auth/otp/verify', { body: { phone: '09129990000', code: sent[0].code } });
    assert.equal(v.body.mfa_required, true);
    assert.equal(v.body.dev_code, undefined);
    assert.equal(sent[1].purpose, 'mfa');
    const m = await t.call('POST', '/v1/auth/mfa/verify', { body: { mfa_token: v.body.mfa_token, code: sent[1].code } });
    assert.equal(m.body.user.role, 'admin');

    // Demo accounts (fake numbers) are disabled: no login, not bookable.
    assert.equal((await t.call('POST', '/v1/auth/otp/request', { body: { phone: DEMO_ACCOUNTS.admin.phone, role: 'doctor' } })).body.code, 'account_disabled');
    const p = await t.call('POST', '/v1/auth/otp/request', { body: { phone: '09351112233', role: 'patient', national_id: randomNationalId() } });
    assert.equal(p.status, 503); // no Shahkar token in production → registration refused (fail closed)
    assert.equal(t.app.db.get('SELECT COUNT(*) AS n FROM doctors WHERE deleted_at IS NULL').n, 0);
  } finally {
    t.close();
  }
});

test('ADMIN_PHONE already used by a patient: converted only with ADMIN_TAKEOVER', async () => {
  const t = await startApp({ seed: false });
  try {
    const { db, config } = t.app;
    const tenant = config.defaultTenant;
    db.run('INSERT INTO users (id, tenant_id, role, phone, full_name, created_at) VALUES (?,?,?,?,?,?)', 'u-owner', tenant, 'patient', '09181110000', 'مالک', new Date().toISOString());
    bootstrapProduction({ db, config: { ...config, adminPhone: '09181110000' } });
    assert.equal(db.get('SELECT role FROM users WHERE id = ?', 'u-owner').role, 'patient');
    bootstrapProduction({ db, config: { ...config, adminPhone: '09181110000', adminTakeover: true } });
    assert.equal(db.get('SELECT role FROM users WHERE id = ?', 'u-owner').role, 'admin');
    assert.equal(db.get('SELECT COUNT(*) AS n FROM users WHERE phone = ?', '09181110000').n, 1);
  } finally {
    t.close();
  }
});

test('repeated code requests: one SMS per minute, concurrent taps rejected, failed delivery frees the slot', async () => {
  const t = await startApp({ devMode: false, seed: true, adminPhone: '09129990001', masterSecret: 'test-secret-production-mode-0123456789' });
  try {
    const sent = [];
    let fail = false;
    let slow = null;
    let entered = null; // resolves when a send has reached the (slow) gateway
    Object.assign(t.app.domain.sms, {
      enabled: true,
      sendOtp: async (mobile, code) => {
        if (slow) { entered?.(); await slow; }
        if (fail) throw new Error('gateway down');
        sent.push(code);
        return { id: '1' };
      },
    });
    const ask = () => t.call('POST', '/v1/auth/otp/request', { body: { phone: '09129990001', role: 'doctor' } });

    // Delivery fails → no cooldown, the user may retry at once.
    fail = true;
    assert.equal((await ask()).body.code, 'sms_failed');
    fail = false;

    // Two taps while the gateway is still answering: the second is refused, one SMS goes out.
    let release;
    slow = new Promise((r) => { release = r; });
    const reached = new Promise((r) => { entered = r; });
    const first = ask();
    await reached;
    const second = await ask();
    assert.equal(second.body.code, 'otp_in_progress');
    release();
    slow = null;
    assert.equal((await first).status, 202);
    assert.equal(sent.length, 1);

    // A repeat within a minute keeps the code already sent.
    const again = await ask();
    assert.equal(again.body.already_sent, true);
    assert.ok(again.body.resend_in > 0 && again.body.resend_in <= 60);
    assert.equal(sent.length, 1);
    const v = await t.call('POST', '/v1/auth/otp/verify', { body: { phone: '09129990001', code: sent[0] } });
    assert.equal(v.body.mfa_required, true);
  } finally {
    t.close();
  }
});

test('plainFetch sends only the headers it is given (nothing added like fetch does)', async () => {
  const http = await import('node:http');
  const { plainFetch } = await import('../src/lib/sms.js');
  let seen;
  const srv = http.createServer((req, res) => {
    let b = ''; req.on('data', (c) => { b += c; });
    req.on('end', () => { seen = { headers: req.headers, body: b }; res.end('{"success":true,"code":0}'); });
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  try {
    const r = await plainFetch(`http://127.0.0.1:${srv.address().port}/SmsOTP`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'User-Agent': 'curl/8.5.0' }, body: '{"a":1}' });
    assert.equal(r.status, 200);
    assert.deepEqual(await r.json(), { success: true, code: 0 });
    assert.equal(seen.body, '{"a":1}');
    assert.equal(seen.headers['user-agent'], 'curl/8.5.0');
    assert.equal(seen.headers['sec-fetch-mode'], undefined);
    assert.equal(seen.headers['accept-language'], undefined);
  } finally {
    srv.close();
  }
});
