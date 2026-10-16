// Real SMS delivery (Kavenegar / SMS.ir templates) and production mode (no codes on screen,
// real administrator, demo accounts disabled).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSms } from '../src/lib/sms.js';
import { startApp, randomNationalId } from './helpers.js';
import { DEMO_ACCOUNTS } from '../src/seed.js';

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
