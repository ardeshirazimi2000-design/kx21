import { config } from '../config.js';
import { one } from '../db/pool.js';
import { decryptText } from '../lib/crypto.js';

/**
 * SMS panels and the mail server used for notifications. They are set in «یکپارچه‌سازی» (integrations
 * rows kind='sms' / 'email'); while no row exists the older .env settings are used, and with neither
 * the messages are only logged.
 */

export const SMS_PROVIDERS = {
  soap: 'وب‌سرویس پنل پیامک (SOAP)',
  kavenegar: 'کاوه‌نگار',
  smsir: 'SMS.ir',
  melipayamak: 'ملی‌پیامک',
} as const;
export type SmsProvider = keyof typeof SMS_PROVIDERS;

export interface SmsConfig {
  provider: SmsProvider;
  sender: string;
  /** API key (kavenegar, smsir) or panel password (soap, melipayamak). */
  secret: string;
  /** soap: address of the panel's WSDL, e.g. https://sms.example.ir/APPs/SMS/WebService.php?wsdl */
  wsdlUrl?: string;
  domain?: string;
  username?: string;
  flash?: boolean;
}

export interface EmailConfig {
  host: string;
  port: number;
  /** true = TLS from the start (usually 465); false = STARTTLS when offered (587/25). */
  secure: boolean;
  user: string;
  password: string;
  from: string;
  fromName: string;
}

export async function loadSmsConfig(): Promise<SmsConfig | null> {
  const r = await one(`SELECT client_secret_enc, settings, is_active FROM integrations WHERE kind = 'sms'`);
  if (r) {
    if (!r.is_active) return null;
    const s = r.settings ?? {};
    return {
      provider: s.provider,
      sender: s.sender ?? '',
      secret: r.client_secret_enc ? decryptText(r.client_secret_enc) : '',
      wsdlUrl: s.wsdlUrl ?? undefined,
      domain: s.domain ?? undefined,
      username: s.username ?? undefined,
      flash: !!s.flash,
    };
  }
  if (config.smsProvider === 'kavenegar' && config.kavenegarApiKey) return { provider: 'kavenegar', secret: config.kavenegarApiKey, sender: config.kavenegarSender ?? '' };
  return null;
}

export async function loadEmailConfig(): Promise<EmailConfig | null> {
  const r = await one(`SELECT client_secret_enc, settings, is_active FROM integrations WHERE kind = 'email'`);
  if (r) {
    if (!r.is_active) return null;
    const s = r.settings ?? {};
    return {
      host: s.host,
      port: Number(s.port) || 587,
      secure: !!s.secure,
      user: s.user ?? '',
      password: r.client_secret_enc ? decryptText(r.client_secret_enc) : '',
      from: s.from,
      fromName: s.fromName ?? '',
    };
  }
  if (config.emailProvider === 'smtp' && config.smtpUrl) {
    const u = new URL(config.smtpUrl);
    const m = /^(.*?)\s*<([^>]+)>\s*$/.exec(config.emailFrom);
    return {
      host: u.hostname,
      port: Number(u.port) || (u.protocol === 'smtps:' ? 465 : 587),
      secure: u.protocol === 'smtps:',
      user: decodeURIComponent(u.username),
      password: decodeURIComponent(u.password),
      from: m ? m[2] : config.emailFrom,
      fromName: m ? m[1] : '',
    };
  }
  return null;
}

// ─────────────────────────────── SMS ───────────────────────────────

/** 09123456789 from «۰۹۱۲…», +98912…, 0098912… */
export function normalizeMobile(s: string): string {
  const d = s.replace(/[۰-۹]/g, (c) => String(c.charCodeAt(0) - 0x06f0)).replace(/[٠-٩]/g, (c) => String(c.charCodeAt(0) - 0x0660)).replace(/[^\d+]/g, '');
  if (d.startsWith('+98')) return `0${d.slice(3)}`;
  if (d.startsWith('0098')) return `0${d.slice(4)}`;
  if (/^9\d{9}$/.test(d)) return `0${d}`;
  return d;
}

export interface SmsResult {
  /** Message id from the panel, kept for delivery reports. */
  id?: string;
  note?: string;
}

const TIMEOUT = 15_000;

async function json(res: Response, what: string) {
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`${what}: پاسخ نامعتبر (HTTP ${res.status}) ${text.slice(0, 120)}`);
  }
}

export async function sendSms(c: SmsConfig, mobile: string, text: string): Promise<SmsResult> {
  const to = normalizeMobile(mobile);
  if (!/^09\d{9}$/.test(to)) throw new Error(`شماره موبایل نامعتبر است: ${mobile}`);
  switch (c.provider) {
    case 'soap':
      return soapSend(c, to, text);
    case 'kavenegar': {
      const body = new URLSearchParams({ receptor: to, message: text, ...(c.sender ? { sender: c.sender } : {}) });
      const res = await fetch(`https://api.kavenegar.com/v1/${encodeURIComponent(c.secret)}/sms/send.json`, { method: 'POST', body, signal: AbortSignal.timeout(TIMEOUT) });
      const j = await json(res, 'کاوه‌نگار');
      if (j?.return?.status !== 200) throw new Error(`کاوه‌نگار: ${j?.return?.message ?? `HTTP ${res.status}`}`);
      return { id: String(j.entries?.[0]?.messageid ?? '') };
    }
    case 'smsir': {
      const res = await fetch('https://api.sms.ir/v1/send/bulk', {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json', 'x-api-key': c.secret },
        body: JSON.stringify({ lineNumber: Number(c.sender), messageText: text, mobiles: [to] }),
        signal: AbortSignal.timeout(TIMEOUT),
      });
      const j = await json(res, 'SMS.ir');
      if (j?.status !== 1) throw new Error(`SMS.ir: ${j?.message ?? `HTTP ${res.status}`}`);
      return { id: String(j.data?.messageIds?.[0] ?? j.data?.packId ?? '') };
    }
    case 'melipayamak': {
      const body = new URLSearchParams({ username: c.username ?? '', password: c.secret, to, from: c.sender, text, isFlash: String(!!c.flash) });
      const res = await fetch('https://rest.payamak-panel.com/api/SendSMS/SendSMS', { method: 'POST', body, signal: AbortSignal.timeout(TIMEOUT) });
      const j = await json(res, 'ملی‌پیامک');
      if (j?.RetStatus !== 1) throw new Error(`ملی‌پیامک: ${j?.StrRetStatus ?? j?.Value ?? `HTTP ${res.status}`}`);
      return { id: String(j.Value ?? '') };
    }
    default:
      throw new Error('سرویس پیامک ناشناخته است');
  }
}

/** Remaining credit as the panel reports it (unit differs per panel), or null when it cannot tell. */
export async function smsCredit(c: SmsConfig): Promise<string | null> {
  switch (c.provider) {
    case 'soap':
      return soapCall(c, 'getCredit', [
        ['domain', c.domain ?? ''],
        ['username', c.username ?? ''],
        ['password', c.secret],
      ]);
    case 'kavenegar': {
      const j = await json(await fetch(`https://api.kavenegar.com/v1/${encodeURIComponent(c.secret)}/account/info.json`, { signal: AbortSignal.timeout(TIMEOUT) }), 'کاوه‌نگار');
      if (j?.return?.status !== 200) throw new Error(`کاوه‌نگار: ${j?.return?.message}`);
      return `${j.entries?.remaincredit} ریال`;
    }
    case 'smsir': {
      const j = await json(await fetch('https://api.sms.ir/v1/credit', { headers: { accept: 'application/json', 'x-api-key': c.secret }, signal: AbortSignal.timeout(TIMEOUT) }), 'SMS.ir');
      if (j?.status !== 1) throw new Error(`SMS.ir: ${j?.message}`);
      return String(j.data);
    }
    case 'melipayamak': {
      const body = new URLSearchParams({ username: c.username ?? '', password: c.secret });
      const j = await json(await fetch('https://rest.payamak-panel.com/api/SendSMS/GetCredit', { method: 'POST', body, signal: AbortSignal.timeout(TIMEOUT) }), 'ملی‌پیامک');
      if (j?.RetStatus !== 1) throw new Error(`ملی‌پیامک: ${j?.StrRetStatus ?? j?.Value}`);
      return String(j.Value);
    }
    default:
      return null;
  }
}

// ───────────────────── SOAP panel («راهنمای وب سرویس ارسال پیامک» v3) ─────────────────────

/** The panel's address as an admin types it → its WSDL address. */
export function wsdlAddress(input: string): string {
  const u = new URL(input.trim());
  if (/wsdl/i.test(u.search)) return u.toString();
  if (u.pathname === '/' || u.pathname === '') u.pathname = '/APPs/SMS/WebService.php';
  u.search = '?wsdl';
  return u.toString();
}

interface Wsdl {
  ns: string;
  location: string;
  rpc: boolean;
  actions: Record<string, string>;
}
const wsdlCache = new Map<string, { at: number; w: Wsdl }>();

export function parseWsdl(xml: string, wsdlUrl: string): Wsdl {
  const ns = /<(?:[\w.-]+:)?definitions\b[^>]*\btargetNamespace="([^"]+)"/.exec(xml)?.[1] ?? /\btargetNamespace="([^"]+)"/.exec(xml)?.[1];
  if (!ns) throw new Error('فایل WSDL پنل پیامک معتبر نیست (targetNamespace ندارد)');
  const loc = /<(?:[\w.-]+:)?address\b[^>]*\blocation="([^"]+)"/.exec(xml)?.[1];
  const location = loc ? loc.replace(/&amp;/g, '&') : wsdlUrl.replace(/\?wsdl.*$/i, '');
  const binding = /<(?:[\w.-]+:)?binding\b[^>]*\bstyle="(rpc|document)"/.exec(xml)?.[1];
  const actions: Record<string, string> = {};
  for (const m of xml.matchAll(/<(?:[\w.-]+:)?operation\b[^>]*\bname="(\w+)"[^>]*>\s*<(?:[\w.-]+:)?operation\b[^>]*\bsoapAction="([^"]*)"/g)) actions[m[1]] = m[2];
  return { ns, location, rpc: binding !== 'document', actions };
}

async function loadWsdl(c: SmsConfig): Promise<Wsdl> {
  if (!c.wsdlUrl) throw new Error('نشانی وب‌سرویس پنل پیامک تنظیم نشده است');
  const url = wsdlAddress(c.wsdlUrl);
  const hit = wsdlCache.get(url);
  if (hit && Date.now() - hit.at < 10 * 60_000) return hit.w;
  const res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT) });
  if (!res.ok) throw new Error(`دریافت WSDL پنل پیامک ناموفق بود (HTTP ${res.status})`);
  const w = parseWsdl(await res.text(), url);
  wsdlCache.set(url, { at: Date.now(), w });
  return w;
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

type Arg = [name: string, value: string | number | string[]];

export function soapEnvelope(w: Pick<Wsdl, 'ns' | 'rpc'>, op: string, args: Arg[]): string {
  const part = ([name, v]: Arg) => {
    if (Array.isArray(v)) {
      return w.rpc
        ? `<${name} xsi:type="SOAP-ENC:Array" SOAP-ENC:arrayType="xsd:string[${v.length}]">${v.map((x) => `<item xsi:type="xsd:string">${esc(x)}</item>`).join('')}</${name}>`
        : `<${name}>${v.map((x) => `<string>${esc(x)}</string>`).join('')}</${name}>`;
    }
    const type = typeof v === 'number' ? 'xsd:int' : 'xsd:string';
    return w.rpc ? `<${name} xsi:type="${type}">${esc(String(v))}</${name}>` : `<${name}>${esc(String(v))}</${name}>`;
  };
  return (
    '<?xml version="1.0" encoding="UTF-8"?>' +
    '<SOAP-ENV:Envelope xmlns:SOAP-ENV="http://schemas.xmlsoap.org/soap/envelope/" xmlns:SOAP-ENC="http://schemas.xmlsoap.org/soap/encoding/"' +
    ` xmlns:xsd="http://www.w3.org/2001/XMLSchema" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:tns="${esc(w.ns)}"` +
    (w.rpc ? ' SOAP-ENV:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/"' : '') +
    `><SOAP-ENV:Body><tns:${op}>${args.map(part).join('')}</tns:${op}></SOAP-ENV:Body></SOAP-ENV:Envelope>`
  );
}

/** The single value a panel method returns («returnValue»). */
export function soapResult(xml: string): string {
  const fault = /<(?:[\w.-]+:)?faultstring[^>]*>([\s\S]*?)<\/(?:[\w.-]+:)?faultstring>/.exec(xml);
  if (fault) throw new Error(`پنل پیامک: ${fault[1].trim()}`);
  const body = /<(?:[\w.-]+:)?Body[^>]*>([\s\S]*)<\/(?:[\w.-]+:)?Body>/.exec(xml)?.[1];
  if (body === undefined) throw new Error('پاسخ پنل پیامک SOAP نیست');
  // <ns:sendSMSResponse><return xsi:type="xsd:int">123</return></ns:sendSMSResponse>
  const leaf = /<(?:[\w.-]+:)?(?:return|returnValue|\w+Result)\b[^>]*>([^<]*)</.exec(body) ?? /<[^/!?][^>]*>([^<]+)</.exec(body);
  if (!leaf) throw new Error('پاسخ پنل پیامک مقدار بازگشتی ندارد');
  return leaf[1].trim().replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&amp;/g, '&');
}

async function soapCall(c: SmsConfig, op: string, args: Arg[]): Promise<string> {
  const w = await loadWsdl(c);
  const res = await fetch(w.location, {
    method: 'POST',
    headers: { 'content-type': 'text/xml; charset=utf-8', soapaction: `"${w.actions[op] ?? `${w.ns}#${op}`}"` },
    body: soapEnvelope(w, op, args),
    signal: AbortSignal.timeout(TIMEOUT),
  });
  const text = await res.text();
  if (!res.ok && !/faultstring/.test(text)) throw new Error(`پنل پیامک: HTTP ${res.status}`);
  return soapResult(text);
}

/** sendSMS return codes; a value above 0 is the message id. */
export const SOAP_SEND_ERRORS: Record<string, string> = {
  '-1': 'خطا در ارسال',
  '-2': 'نام کاربری یا کلمه عبور اشتباه است',
  '-3': 'شماره فرستنده معتبر نیست',
  '-4': 'اعتبار کافی نیست',
  '-6': 'شماره گیرنده صحیح نیست',
};

async function soapSend(c: SmsConfig, to: string, text: string): Promise<SmsResult> {
  const v = await soapCall(c, 'sendSMS', [
    ['domain', c.domain ?? ''],
    ['username', c.username ?? ''],
    ['password', c.secret],
    ['from', c.sender],
    ['to', [to]],
    ['text', text],
    ['isflash', c.flash ? 2 : 1],
  ]);
  if (v === '-5') return { note: 'پیام پس از تأیید در پنل ارسال می‌شود' };
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) throw new Error(`پنل پیامک: ${SOAP_SEND_ERRORS[v] ?? `کد ${v}`}`);
  return { id: v };
}

// ─────────────────────────────── Email ───────────────────────────────

export async function sendEmail(c: EmailConfig, to: string, subject: string, text: string): Promise<{ id?: string }> {
  const { default: nodemailer } = await import('nodemailer');
  const t = nodemailer.createTransport({
    host: c.host,
    port: c.port,
    secure: c.secure,
    auth: c.user ? { user: c.user, pass: c.password } : undefined,
    connectionTimeout: TIMEOUT,
    greetingTimeout: TIMEOUT,
    socketTimeout: 30_000,
  });
  const info = await t.sendMail({ from: c.fromName ? { name: c.fromName, address: c.from } : c.from, to, subject, text });
  return { id: info.messageId };
}
