// SMS diagnostic: sends one test code through the configured provider/template.
//   sudo /opt/node22/bin/node /opt/kx21/scripts/check-sms.js 09xxxxxxxxx
// Reads SMS_* from the environment or /etc/kx21.env; the API key is never printed.
import { readFileSync } from 'node:fs';
import { createSms } from '../src/lib/sms.js';
import { normalizePhone } from '../src/lib/fa.js';

const env = { ...process.env };
try {
  for (const line of readFileSync('/etc/kx21.env', 'utf8').split('\n')) {
    const m = line.match(/^([A-Z_]+)=(.*)$/);
    if (m && env[m[1]] === undefined) env[m[1]] = m[2];
  }
} catch { /* no env file */ }
const phone = normalizePhone(process.argv[2] ?? '');
if (!phone) { console.log('usage: node scripts/check-sms.js 09xxxxxxxxx'); process.exit(1); }
const config = {
  smsProvider: env.SMS_PROVIDER, smsApiKey: env.SMS_API_KEY, smsOtpTemplate: env.SMS_OTP_TEMPLATE, smsMfaTemplate: env.SMS_MFA_TEMPLATE,
  smsTemplateParam: env.SMS_TEMPLATE_PARAM || 'Code', smsSender: env.SMS_SENDER,
  sapiToken: env.SAPI_TOKEN, sapiBase: env.SAPI_BASE, smsApiirService: env.SMS_APIIR_SERVICE,
};
console.log('SMS_PROVIDER     :', config.smsProvider || 'NOT SET');
console.log('SMS_API_KEY      :', config.smsApiKey ? `set (${config.smsApiKey.length} chars)` : config.smsProvider === 'apiir' ? (config.sapiToken ? 'using SAPI_TOKEN (api.ir)' : 'NOT SET (SAPI_TOKEN missing)') : 'NOT SET');
console.log('SMS_OTP_TEMPLATE :', config.smsOtpTemplate || 'NOT SET');
console.log('SMS_MFA_TEMPLATE :', config.smsMfaTemplate || '(same as OTP)');
console.log('SMS_SENDER       :', config.smsSender || '(none — notifications stay in the app)');
const sms = createSms(config);
if (!sms.enabled) { console.log('→ SMS is not fully configured.'); process.exit(2); }
const code = String(Math.floor(100000 + Math.random() * 900000));
try {
  const r = await sms.sendOtp(phone, code);
  console.log(`✓ sent test code ${code} to ${phone} via ${sms.delivery === 'voice' ? 'voice call' : 'SMS'} (id ${r.id || '—'}). Check the phone.`);
} catch (e) {
  console.log('✗ failed:', e.message);
}
