// SMS delivery for OTP codes and notifications. Iranian operators require one-time codes to be
// sent through a pre-approved "verify" template; free-text messages need a dedicated line.
//   SMS_PROVIDER=kavenegar  SMS_API_KEY=…  SMS_OTP_TEMPLATE=<template name>   [SMS_SENDER=<line>]
//   SMS_PROVIDER=smsir      SMS_API_KEY=…  SMS_OTP_TEMPLATE=<template id>     [SMS_SENDER=<line>] [SMS_TEMPLATE_PARAM=Code]
//   SMS_PROVIDER=apiir      (uses SAPI_TOKEN, the same api.ir token as Shahkar)   [SMS_OTP_TEMPLATE=1]
//     api.ir SmsOTP sends the code by text message with template number SMS_OTP_TEMPLATE (default 1);
//     SMS_APIIR_SERVICE=CallOTP instead reads the code to the user in a phone call (voice).
// The phone number and the code are the only data sent.

import { request as httpsRequest } from 'node:https';
import { request as httpRequest } from 'node:http';

export class SmsError extends Error {}

// Plain HTTPS request with exactly the headers given — like curl. Node's built-in fetch adds
// headers of its own (sec-fetch-mode, accept-language…), and the api.ir gateway answered such
// requests with "Duplicate request: trackId already exists" while the same call from curl worked.
export function plainFetch(url, { method = 'GET', headers = {}, body, signal } = {}) {
  return new Promise((resolve, reject) => {
    const data = body == null ? null : Buffer.from(body);
    const u = new URL(url);
    const req = (u.protocol === 'http:' ? httpRequest : httpsRequest)(u, {
      method, signal, headers: { ...headers, ...(data ? { 'Content-Length': data.length } : {}) },
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        resolve({ status: res.statusCode, ok: res.statusCode >= 200 && res.statusCode < 300, text: async () => text, json: async () => JSON.parse(text) });
      });
      res.on('error', reject);
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

export function createSms(config, fetchImpl = plainFetch) {
  const provider = String(config.smsProvider ?? '').toLowerCase();
  const clean = (t) => String(t ?? '').trim().replace(/^["']|["']$/g, '').replace(/^bearer\s+/i, '').trim();
  const key = clean(config.smsApiKey || (provider === 'apiir' ? config.sapiToken : ''));
  const enabled = provider === 'apiir' ? !!key : !!(provider && key && config.smsOtpTemplate);
  const canSendText = enabled && provider !== 'apiir' && !!config.smsSender;
  const apiirService = String(config.smsApiirService || 'SmsOTP').replace(/[^A-Za-z0-9]/g, '');
  // How the user receives the code: a text message, or a phone call reading it out.
  const delivery = provider === 'apiir' && /call/i.test(apiirService) ? 'voice' : 'sms';

  async function call(url, init) {
    let res;
    try {
      res = await fetchImpl(url, { ...init, signal: AbortSignal.timeout(15000) });
    } catch (e) {
      throw new SmsError(`unreachable: ${e.cause?.code ?? e.message}`);
    }
    const body = await res.json().catch(() => null);
    return { status: res.status, body };
  }

  async function kavenegar(path, params) {
    const u = new URL(`https://api.kavenegar.com/v1/${encodeURIComponent(key)}/${path}`);
    for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
    const r = await call(u, { method: 'GET', headers: { Accept: 'application/json' } });
    const st = r.body?.return?.status;
    if (st !== 200) throw new SmsError(`kavenegar ${st ?? r.status}: ${r.body?.return?.message ?? ''}`);
    return { id: String(r.body?.entries?.[0]?.messageid ?? '') };
  }

  async function smsir(path, payload) {
    const r = await call(`https://api.sms.ir/v1/${path}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'x-api-key': key }, body: JSON.stringify(payload),
    });
    if (r.body?.status !== 1) throw new SmsError(`sms.ir ${r.body?.status ?? r.status}: ${r.body?.message ?? ''}`);
    return { id: String(r.body?.data?.messageId ?? r.body?.data?.packId ?? '') };
  }

  // Sent exactly as api.ir's own curl sample (see plainFetch).
  async function apiir(payload) {
    const base = String(config.sapiBase || 'https://s.api.ir/api/sw1').replace(/\/$/, '');
    const r = await call(`${base}/${apiirService}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: '*/*', 'User-Agent': 'curl/8.5.0', Authorization: `Bearer ${key}` },
      body: JSON.stringify(payload),
    });
    const b = r.body;
    // Same envelope as the Shahkar service: {data, success, code, message}.
    const ok = r.status >= 200 && r.status < 300 && b && b.success !== false && (b.code === undefined || b.code === 0);
    if (!ok) throw new SmsError(`api.ir ${r.status} ${b?.code ?? ''}: ${b?.message ?? ''}`.trim());
    return { id: String(b?.data?.id ?? b?.data ?? '') };
  }

  /** One-time code through the approved template (purpose 'login' | 'mfa'). */
  async function sendOtp(mobile, code, purpose = 'login') {
    if (!enabled) throw new SmsError('sms not configured');
    if (provider === 'apiir') {
      if (/call/i.test(apiirService)) return apiir({ code: String(code), number: mobile });
      const tpl = Number((purpose === 'mfa' && config.smsMfaTemplate) || config.smsOtpTemplate || 1);
      return apiir({ code: String(code), mobile, template: Number.isFinite(tpl) ? tpl : 1 });
    }
    const template = purpose === 'mfa' && config.smsMfaTemplate ? config.smsMfaTemplate : config.smsOtpTemplate;
    if (provider === 'kavenegar') return kavenegar('verify/lookup.json', { receptor: mobile, token: code, template });
    if (provider === 'smsir') {
      return smsir('send/verify', { mobile, templateId: Number(template), parameters: [{ name: config.smsTemplateParam || 'Code', value: String(code) }] });
    }
    throw new SmsError(`unknown SMS_PROVIDER ${provider}`);
  }

  /** Free-text notification (needs a sender line). */
  async function sendText(mobile, text) {
    if (!canSendText) throw new SmsError('no sender line configured');
    if (provider === 'kavenegar') return kavenegar('sms/send.json', { receptor: mobile, sender: config.smsSender, message: text });
    if (provider === 'smsir') return smsir('send/bulk', { lineNumber: Number(config.smsSender), messageText: text, mobiles: [mobile] });
    throw new SmsError(`unknown SMS_PROVIDER ${provider}`);
  }

  return { enabled, canSendText, provider, delivery, sendOtp, sendText };
}
