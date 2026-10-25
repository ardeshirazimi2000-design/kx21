import {
  formatJalaliLong,
  formatTime,
  MEETING_TYPE_LABELS,
  mergeNotificationSettings,
  renderTemplate,
  SOCKET_EVENTS,
  toPersianDigits,
  type EmailSettings,
  type MeetingType,
  type NotificationChannel,
  type NotificationEvent,
  type NotificationSettings,
  type SmsSettings,
} from '@kx/shared';
import nodemailer, { type Transporter } from 'nodemailer';
import { config } from '../config.js';
import { one, pool, query } from '../db/pool.js';
import { logger } from '../lib/logger.js';
import { emitToUser } from '../realtime.js';

export interface NotifyInput {
  chamberId: string | null;
  userIds: string[];
  event: NotificationEvent;
  title: string;
  body: string;
  data?: Record<string, unknown>;
}

interface Recipient {
  id: string;
  full_name: string;
  mobile: string | null;
  email: string | null;
  push_tokens: string[];
}

type Vars = Record<string, string>;

/** Messages "sent" while running tests (nothing leaves the machine). */
export const testOutbox: { channel: 'sms' | 'email'; to: string; text: string; subject?: string }[] = [];
type Result = 'sent' | 'skipped';

// ─────────────────────────────── Settings ───────────────────────────────

const cache = new Map<string, { at: number; value: NotificationSettings }>();

/** Notification settings of a chamber (cached briefly); the SMS key may also come from .env. */
export async function loadNotificationSettings(chamberId: string | null): Promise<NotificationSettings> {
  const key = chamberId ?? '-';
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < 30_000) return hit.value;
  const row = chamberId ? await one<{ n: unknown }>(`SELECT settings->'notifications' AS n FROM chambers WHERE id = $1`, [chamberId]) : null;
  const s = mergeNotificationSettings(row?.n);
  // Installs configured before the settings page: SMS_PROVIDER=kavenegar + KAVENEGAR_API_KEY in .env.
  if (!s.sms.apiKey && config.smsProvider === 'kavenegar' && config.kavenegarApiKey) {
    s.sms = { ...s.sms, enabled: true, apiKey: config.kavenegarApiKey, sender: s.sms.sender || (config.kavenegarSender ?? '') };
  }
  cache.set(key, { at: Date.now(), value: s });
  return s;
}

export function invalidateNotificationSettings(chamberId: string) {
  cache.delete(chamberId);
  transporters.clear();
}

/** Channels used for an event with the chamber's settings (in-app is always on). */
export function channelsFor(s: NotificationSettings, event: NotificationEvent): NotificationChannel[] {
  const e = s.events[event];
  const ch: NotificationChannel[] = ['in_app'];
  if (e.push.enabled) ch.push('push');
  if (s.sms.enabled && e.sms.enabled) ch.push('sms');
  if (s.email.enabled && e.email.enabled) ch.push('email');
  return ch;
}

// ─────────────────────────────── Variables ───────────────────────────────

const faDigits = (v: string | number | null | undefined) => (v === null || v === undefined || v === '' ? '' : toPersianDigits(String(v)));

/** Values for {تاریخ}, {کمیسیون}, … taken from the meeting / resolution the notification is about. */
async function contextVars(n: NotifyInput, s: NotificationSettings): Promise<Vars> {
  const vars: Vars = { عنوان: n.title, متن: n.body };
  const base = s.publicUrl.replace(/\/+$/, '');
  const d = n.data ?? {};
  let chamberId = n.chamberId;
  if (typeof d.meetingId === 'string') {
    const m = await one(
      `SELECT m.title, m.number, m.scheduled_at, m.location, m.type, c.name AS commission, m.chamber_id
         FROM meetings m JOIN commissions c ON c.id = m.commission_id WHERE m.id = $1`,
      [d.meetingId],
    );
    if (m) {
      Object.assign(vars, {
        عنوان_جلسه: m.title,
        شماره_جلسه: faDigits(m.number),
        کمیسیون: m.commission,
        تاریخ: formatJalaliLong(m.scheduled_at),
        ساعت: faDigits(formatTime(m.scheduled_at)),
        مکان: m.location ?? (m.type === 'online' ? 'برخط (وبینار)' : ''),
        نوع_جلسه: MEETING_TYPE_LABELS[m.type as MeetingType] ?? '',
      });
      chamberId ??= m.chamber_id;
      if (base) vars.لینک = `${base}/meetings/${d.meetingId}`;
    }
  }
  if (typeof d.resolutionId === 'string') {
    const r = await one(
      `SELECT r.number, r.text, r.due_date, c.name AS commission, r.chamber_id
         FROM resolutions r JOIN commissions c ON c.id = r.commission_id WHERE r.id = $1`,
      [d.resolutionId],
    );
    if (r) {
      Object.assign(vars, {
        شماره_مصوبه: r.number,
        متن_مصوبه: r.text,
        مهلت: r.due_date ? formatJalaliLong(`${r.due_date}T12:00:00`) : 'تعیین نشده',
        کمیسیون: vars.کمیسیون ?? r.commission,
      });
      chamberId ??= r.chamber_id;
      if (base) vars.لینک = `${base}/resolutions/${d.resolutionId}`;
    }
  }
  if (typeof d.referralId === 'string') {
    const f = await one(`SELECT c.name AS commission FROM referrals f JOIN commissions c ON c.id = f.commission_id WHERE f.id = $1`, [d.referralId]);
    if (f) vars.کمیسیون ??= f.commission;
    if (base) vars.لینک ??= `${base}/referrals`;
  }
  if (chamberId) {
    const ch = await one<{ name: string }>('SELECT name FROM chambers WHERE id = $1', [chamberId]);
    if (ch) vars.اتاق = ch.name;
  }
  vars.لینک ??= base;
  return vars;
}

// ─────────────────────────────── Providers ───────────────────────────────

/** Kavenegar «sms/send»: the message text is composed here from the chamber's template. */
export async function sendSms(sms: SmsSettings, mobile: string, text: string): Promise<Result> {
  if (!mobile) return 'skipped';
  if (config.isTest) {
    testOutbox.push({ channel: 'sms', to: mobile, text });
    return 'sent';
  }
  if (!sms.apiKey) throw new Error('کلید API کاوه‌نگار تنظیم نشده است');
  const res = await fetch(`https://api.kavenegar.com/v1/${encodeURIComponent(sms.apiKey)}/sms/send.json`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ receptor: mobile, message: text, ...(sms.sender ? { sender: sms.sender } : {}) }),
  });
  const body: any = await res.json().catch(() => null);
  if (!res.ok || body?.return?.status !== 200) {
    const status = body?.return?.status ?? res.status;
    const hint: Record<number, string> = {
      403: 'کلید API نامعتبر است؛ آن را از پنل کاوه‌نگار دوباره کپی کنید',
      412: 'شماره خط فرستنده نامعتبر است؛ شماره خط خود را از پنل کاوه‌نگار (بخش خطوط) در «شماره خط فرستنده» وارد کنید',
      418: 'اعتبار حساب کاوه‌نگار کافی نیست',
      411: 'شماره موبایل گیرنده نامعتبر است',
    };
    throw new Error(`کاوه‌نگار: ${hint[status] ?? body?.return?.message ?? `HTTP ${res.status}`}`);
  }
  return 'sent';
}

const transporters = new Map<string, Transporter>();
function transporter(e: EmailSettings): Transporter {
  const key = JSON.stringify([e.host, e.port, e.secure, e.user, e.password]);
  let t = transporters.get(key);
  if (!t) {
    t = nodemailer.createTransport({
      host: e.host,
      port: e.port,
      secure: e.secure,
      auth: e.user ? { user: e.user, pass: e.password } : undefined,
      connectionTimeout: 15_000,
    });
    transporters.set(key, t);
  }
  return t;
}

const escapeHtml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export async function sendEmail(e: EmailSettings, to: string, subject: string, text: string): Promise<Result> {
  if (!to) return 'skipped';
  if (config.isTest) {
    testOutbox.push({ channel: 'email', to, subject, text });
    return 'sent';
  }
  if (!e.host || !e.from) throw new Error('سرور ایمیل یا نشانی فرستنده تنظیم نشده است');
  const html = `<div dir="rtl" style="font-family:Tahoma,Arial,sans-serif;font-size:14px;line-height:1.9">${escapeHtml(text)
    .replace(/(https?:\/\/\S+)/g, '<a href="$1">$1</a>')
    .replace(/\n/g, '<br>')}</div>`;
  await transporter(e).sendMail({ from: e.fromName ? { name: e.fromName, address: e.from } : e.from, to, subject, text, html });
  return 'sent';
}

async function sendPush(r: Recipient, title: string, body: string, data: Record<string, unknown>): Promise<Result> {
  if (!r.push_tokens.length) return 'skipped';
  if (config.isTest || config.pushProvider !== 'expo') {
    logger.info({ to: r.id, title }, 'push (log provider)');
    return 'sent';
  }
  const messages = r.push_tokens.map((to) => ({ to, title, body, data, sound: 'default', channelId: 'default' }));
  const res = await fetch('https://exp.host/--/api/v2/push/send', {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify(messages),
  });
  if (!res.ok) throw new Error(`expo push failed: ${res.status}`);
  return 'sent';
}

// ─────────────────────────────── Dispatch ───────────────────────────────

/** Meetings and resolutions recorded from the archive are kept for the record: nobody is notified about them. */
async function aboutArchive(data: Record<string, unknown> | undefined) {
  const meetingId = typeof data?.meetingId === 'string' ? data.meetingId : null;
  const resolutionId = typeof data?.resolutionId === 'string' ? data.resolutionId : null;
  if (!meetingId && !resolutionId) return false;
  const r = await query<{ archival: boolean }>(
    `SELECT archival FROM meetings WHERE id = $1::uuid AND archival UNION ALL SELECT archival FROM resolutions WHERE id = $2::uuid AND archival LIMIT 1`,
    [meetingId, resolutionId],
  );
  return r.length > 0;
}

/**
 * Stores in-app notifications, pushes them over the socket and sends push / SMS / email according
 * to the chamber's settings, with each recipient's own text. Call after the transaction committed.
 */
export async function notify(n: NotifyInput): Promise<void> {
  const userIds = [...new Set(n.userIds.filter(Boolean))];
  if (!userIds.length) return;
  if (await aboutArchive(n.data)) return;
  const settings = await loadNotificationSettings(n.chamberId);
  const channels = channelsFor(settings, n.event);
  const recipients = await query<Recipient>(
    `SELECT u.id, u.full_name, u.mobile, u.email, COALESCE(array_agg(d.push_token) FILTER (WHERE d.push_token IS NOT NULL), '{}') AS push_tokens
       FROM users u LEFT JOIN devices d ON d.user_id = u.id
      WHERE u.id = ANY($1) AND u.is_active GROUP BY u.id`,
    [userIds],
  );
  const needVars = channels.some((c) => c === 'sms' || c === 'email');
  const vars = needVars ? await contextVars(n, settings).catch(() => ({ عنوان: n.title, متن: n.body }) as Vars) : {};
  for (const r of recipients) {
    const [row] = await query<{ id: string; created_at: Date }>(
      `INSERT INTO notifications (chamber_id, user_id, event, title, body, data, channels)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id, created_at`,
      [n.chamberId, r.id, n.event, n.title, n.body, JSON.stringify(n.data ?? {}), channels],
    );
    emitToUser(r.id, SOCKET_EVENTS.notification, {
      id: row.id,
      event: n.event,
      title: n.title,
      body: n.body,
      data: n.data ?? {},
      createdAt: row.created_at,
    });
    void dispatch(row.id, r, n, channels, settings, { ...vars, نام: r.full_name });
  }
}

async function dispatch(id: string, r: Recipient, n: NotifyInput, channels: NotificationChannel[], s: NotificationSettings, vars: Vars) {
  const delivery: Record<string, string> = { in_app: 'sent' };
  const tpl = s.events[n.event];
  for (const ch of channels) {
    if (ch === 'in_app') continue;
    try {
      if (ch === 'push') delivery.push = await sendPush(r, n.title, n.body, { event: n.event, ...n.data });
      if (ch === 'sms') delivery.sms = await sendSms(s.sms, r.mobile ?? '', renderTemplate(tpl.sms.text, vars));
      if (ch === 'email') delivery.email = await sendEmail(s.email, r.email ?? '', renderTemplate(tpl.email.subject, vars), renderTemplate(tpl.email.text, vars));
    } catch (e) {
      delivery[ch] = 'failed';
      logger.warn({ err: (e as Error).message, ch, notificationId: id }, 'notification delivery failed');
    }
  }
  await pool.query('UPDATE notifications SET delivery = $2 WHERE id = $1', [id, JSON.stringify(delivery)]).catch(() => {});
}
