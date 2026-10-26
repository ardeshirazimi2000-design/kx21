import { config } from '../config.js';
import { one, pool, query, type Db } from '../db/pool.js';
import { logger } from '../lib/logger.js';
import { enqueue, registerHandler } from './jobs.js';

export const NOTIFICATION_EVENTS = {
  'routing.assigned': 'ارجاع نامه',
  'letter.received': 'دریافت نامه داخلی',
  'workflow.step_assigned': 'اقدام در گردش کار',
  'workflow.reminder': 'یادآوری مهلت اقدام',
  'workflow.escalated': 'ارجاع خودکار به‌دلیل تأخیر (Escalation)',
  'workflow.completed': 'پایان گردش کار',
  'workflow.rejected': 'رد در گردش کار',
  'resolution.assigned': 'ابلاغ مصوبه کمیسیون',
  'meeting.referral_updated': 'وضعیت ارجاع به کمیسیون',
  'meeting.invitation_letters': 'پیش‌نویس نامه‌های دعوت جلسه',
  'archive.retention_due': 'سررسید نگهداری اسناد',
} as const;
export type NotificationEvent = keyof typeof NOTIFICATION_EVENTS;
type Channel = 'in_app' | 'email' | 'sms';

/** Default templates; {{var}} placeholders. Editable at /notification-templates. */
export const DEFAULT_TEMPLATES: Record<NotificationEvent, Partial<Record<Channel, { subject?: string; body: string }>>> = {
  'routing.assigned': {
    in_app: { subject: 'ارجاع: {{subject}}', body: '{{actor}} نامه {{number}} را برای «{{action}}» به شما ارجاع داد. {{instruction}}' },
    email: { subject: 'ارجاع نامه {{number}}', body: '{{name}} گرامی،\n{{actor}} نامه «{{subject}}» را به شما ارجاع داد.\nدستور: {{instruction}}\n{{link}}' },
    sms: { body: 'ارجاع نامه {{number}} از {{actor}}: {{subject}}' },
  },
  'letter.received': {
    in_app: { subject: 'نامه جدید: {{subject}}', body: 'نامه {{number}} برای شما ارسال شد.' },
    email: { subject: 'نامه {{number}}', body: '{{name}} گرامی،\nنامه «{{subject}}» برای شما ارسال شد.\n{{link}}' },
  },
  'workflow.step_assigned': {
    in_app: { subject: '{{step}}: {{subject}}', body: 'گام «{{step}}» از گردش «{{workflow}}» برای نامه {{number}} در کارتابل شماست. مهلت: {{due}}' },
    email: { subject: 'اقدام لازم: {{step}}', body: '{{name}} گرامی،\nگام «{{step}}» نامه «{{subject}}» در کارتابل شماست.\nمهلت: {{due}}\n{{link}}' },
    sms: { body: 'اقدام لازم ({{step}}) برای نامه {{number}} — مهلت {{due}}' },
  },
  'workflow.reminder': {
    in_app: { subject: 'یادآوری: {{step}}', body: 'مهلت اقدام «{{step}}» برای نامه {{number}} نزدیک است ({{due}}).' },
    sms: { body: 'یادآوری: مهلت «{{step}}» نامه {{number}} تا {{due}}' },
  },
  'workflow.escalated': {
    in_app: { subject: 'ارجاع به‌دلیل تأخیر: {{subject}}', body: 'مهلت گام «{{step}}» نامه {{number}} گذشت و به شما ارجاع شد.' },
    email: { subject: 'Escalation نامه {{number}}', body: '{{name}} گرامی،\nمهلت گام «{{step}}» نامه «{{subject}}» گذشته و برای اقدام به شما ارجاع شد.\n{{link}}' },
  },
  'workflow.completed': { in_app: { subject: 'پایان گردش: {{subject}}', body: 'گردش «{{workflow}}» نامه {{number}} با موفقیت به پایان رسید.' } },
  'workflow.rejected': { in_app: { subject: 'رد شد: {{subject}}', body: 'نامه {{number}} در گام «{{step}}» رد شد. {{comment}}' } },
  'resolution.assigned': {
    in_app: { subject: 'مصوبه {{resolution}}', body: 'اجرای مصوبه {{resolution}} کمیسیون {{commission}} به شما ابلاغ شد. مهلت: {{due}}' },
    email: { subject: 'ابلاغ مصوبه {{resolution}}', body: '{{name}} گرامی،\nمصوبه {{resolution}} کمیسیون {{commission}}:\n«{{text}}»\nمهلت اجرا: {{due}}\n{{link}}' },
    sms: { body: 'ابلاغ مصوبه {{resolution}} کمیسیون {{commission}} — مهلت {{due}}' },
  },
  'meeting.referral_updated': { in_app: { subject: 'ارجاع به کمیسیون: {{subject}}', body: 'وضعیت ارجاع نامه {{number}} به کمیسیون {{commission}}: {{status}}' } },
  'meeting.invitation_letters': {
    in_app: { subject: 'نامه‌های دعوت: {{meeting}}', body: '{{count}} پیش‌نویس نامه دعوت برای جلسه «{{meeting}}» کمیسیون {{commission}} ({{date}}) آماده ثبت و امضاست.' },
    email: { subject: 'نامه‌های دعوت جلسه {{meeting}}', body: '{{name}} گرامی،\n{{count}} پیش‌نویس نامه دعوت برای جلسه «{{meeting}}» کمیسیون {{commission}} ({{date}}) آماده ثبت و امضاست.\n{{link}}' },
  },
  'archive.retention_due': { in_app: { subject: 'سررسید نگهداری', body: '{{count}} سند به پایان دوره نگهداری رسیده و منتظر تصمیم (امحا/بازبینی) است.' } },
};

export const render = (tpl: string, vars: Record<string, unknown>) =>
  tpl.replace(/\{\{(\w+)\}\}/g, (_m, k) => (vars[k] === undefined || vars[k] === null ? '' : String(vars[k]))).trim();

async function template(event: string, channel: Channel, db: Db) {
  const row = await one('SELECT subject, body, enabled FROM notification_templates WHERE event = $1 AND channel = $2', [event, channel], db);
  if (row) return row.enabled ? row : null;
  const d = DEFAULT_TEMPLATES[event as NotificationEvent]?.[channel];
  return d ? { subject: d.subject ?? null, body: d.body } : null;
}

export interface NotifyInput {
  userIds: (string | null | undefined)[];
  event: NotificationEvent;
  vars: Record<string, unknown>;
  data?: Record<string, unknown>;
}

/** In-app notification now; e-mail/SMS through the job queue (retried, never blocks the request). */
export async function notify(n: NotifyInput, db: Db = pool) {
  const ids = [...new Set(n.userIds.filter(Boolean))] as string[];
  if (!ids.length) return;
  // A letter's notification carries its subject: nobody below the letter's confidentiality receives it.
  const letter = n.data?.letterId ? await one('SELECT confidentiality FROM letters WHERE id = $1', [n.data.letterId], db) : null;
  const users = await query('SELECT id, full_name, email, mobile FROM users WHERE id = ANY($1::uuid[]) AND is_active AND clearance >= $2', [ids, letter?.confidentiality ?? 0], db);
  const link = n.data?.letterId ? `${config.publicUrl}/letters/${n.data.letterId}` : config.publicUrl;
  const inApp = await template(n.event, 'in_app', db);
  const email = await template(n.event, 'email', db);
  const sms = await template(n.event, 'sms', db);
  for (const u of users) {
    const vars = { ...n.vars, name: u.full_name, link };
    if (inApp) {
      await query(`INSERT INTO notifications (user_id, event, title, body, data) VALUES ($1,$2,$3,$4,$5)`, [
        u.id, n.event, render(inApp.subject ?? NOTIFICATION_EVENTS[n.event], vars), render(inApp.body, vars), JSON.stringify(n.data ?? {}),
      ], db);
    }
    if (email && u.email) await enqueue('email.send', { to: u.email, subject: render(email.subject ?? NOTIFICATION_EVENTS[n.event], vars), text: render(email.body, vars) }, db);
    if (sms && u.mobile) await enqueue('sms.send', { to: u.mobile, text: render(sms.body, vars) }, db);
  }
}

/** Current holders of a position. */
export async function positionHolders(positionId: string, db: Db = pool): Promise<string[]> {
  const rows = await query<{ user_id: string }>(
    `SELECT up.user_id FROM user_positions up JOIN users u ON u.id = up.user_id
      WHERE up.position_id = $1 AND (up.end_date IS NULL OR up.end_date >= current_date) AND u.is_active`,
    [positionId],
    db,
  );
  return rows.map((r) => r.user_id);
}

/** Messages "sent" in log mode (tests, trial installs). */
export const outbox: { channel: 'email' | 'sms'; to: string; text: string; subject?: string }[] = [];

registerHandler('email.send', async (p: { to: string; subject: string; text: string }) => {
  if (config.emailProvider === 'smtp' && config.smtpUrl) {
    const { default: nodemailer } = await import('nodemailer');
    await nodemailer.createTransport(config.smtpUrl).sendMail({ from: config.emailFrom, to: p.to, subject: p.subject, text: p.text });
    return;
  }
  outbox.push({ channel: 'email', ...p });
  logger.info({ to: p.to, subject: p.subject }, 'email (log mode)');
});

registerHandler('sms.send', async (p: { to: string; text: string }) => {
  if (config.smsProvider === 'kavenegar' && config.kavenegarApiKey) {
    const url = `https://api.kavenegar.com/v1/${config.kavenegarApiKey}/sms/send.json`;
    const body = new URLSearchParams({ receptor: p.to, message: p.text, ...(config.kavenegarSender ? { sender: config.kavenegarSender } : {}) });
    const r = await fetch(url, { method: 'POST', body, signal: AbortSignal.timeout(10_000) });
    if (!r.ok) throw new Error(`kavenegar HTTP ${r.status}`);
    return;
  }
  outbox.push({ channel: 'sms', ...p });
  logger.info({ to: p.to }, 'sms (log mode)');
});
