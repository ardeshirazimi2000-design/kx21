import {
  mergeNotificationSettings,
  NOTIFICATION_EVENTS,
  renderTemplate,
  TEMPLATE_VARIABLES,
  type NotificationSettings,
} from '@kx/shared';
import { Router } from 'express';
import { z } from 'zod';
import { currentUser } from '../auth/middleware.js';
import { one, tx } from '../db/pool.js';
import { audit } from '../lib/audit.js';
import { badRequest, notFound } from '../lib/errors.js';
import { body, param } from '../lib/validate.js';
import { requireChamberAdmin } from '../services/access.js';
import { invalidateNotificationSettings, sendEmail, sendSms } from '../services/notifications.js';

/** Chamber notification settings: SMS panel, mail server and message texts (chamber admins). */
export const notificationSettingsRouter = Router();

const mask = (v: string) => (v ? `••••${v.slice(-4)}` : '');

/** Secrets never leave the server: the API key is shown masked and the mail password only as "set". */
function publicView(s: NotificationSettings) {
  return {
    ...s,
    sms: { ...s.sms, apiKey: '', apiKeyHint: mask(s.sms.apiKey) },
    email: { ...s.email, password: '', hasPassword: !!s.email.password },
  };
}

async function stored(chamberId: string) {
  const row = await one<{ n: unknown }>(`SELECT settings->'notifications' AS n FROM chambers WHERE id = $1`, [chamberId]);
  if (!row) throw notFound();
  return mergeNotificationSettings(row.n);
}

notificationSettingsRouter.get('/chambers/:id/notification-settings', async (req, res) => {
  const id = param(req, 'id');
  requireChamberAdmin(currentUser(req), id);
  res.json(publicView(await stored(id)));
});

const channels = z.object({
  push: z.object({ enabled: z.boolean() }),
  sms: z.object({ enabled: z.boolean(), text: z.string().max(1000) }),
  email: z.object({ enabled: z.boolean(), subject: z.string().max(200), text: z.string().max(5000) }),
});

const settingsSchema = z.object({
  publicUrl: z.string().max(200).refine((v) => !v || /^https?:\/\/\S+$/.test(v), 'آدرس سامانه باید با http:// یا https:// شروع شود'),
  sms: z.object({
    enabled: z.boolean(),
    provider: z.literal('kavenegar'),
    /** null or empty = keep the stored key */
    apiKey: z.string().max(200).nullish(),
    sender: z.string().max(30),
  }),
  email: z.object({
    enabled: z.boolean(),
    host: z.string().max(200),
    port: z.number().int().min(1).max(65535),
    secure: z.boolean(),
    user: z.string().max(200),
    /** null or empty = keep the stored password */
    password: z.string().max(200).nullish(),
    from: z.string().max(200).refine((v) => !v || /^[^\s@]+@[^\s@]+$/.test(v), 'نشانی ایمیل فرستنده معتبر نیست'),
    fromName: z.string().max(100),
  }),
  events: z.object(Object.fromEntries(NOTIFICATION_EVENTS.map((e) => [e, channels])) as Record<(typeof NOTIFICATION_EVENTS)[number], typeof channels>),
});

notificationSettingsRouter.put('/chambers/:id/notification-settings', async (req, res) => {
  const id = param(req, 'id');
  requireChamberAdmin(currentUser(req), id);
  const b = body(req, settingsSchema);
  const saved = await tx(async (c) => {
    const before = await stored(id);
    const next: NotificationSettings = {
      publicUrl: b.publicUrl.replace(/\/+$/, ''),
      sms: { ...b.sms, apiKey: b.sms.apiKey ? b.sms.apiKey.trim() : before.sms.apiKey },
      email: { ...b.email, password: b.email.password ? b.email.password : before.email.password },
      events: b.events,
    };
    if (next.sms.enabled && !next.sms.apiKey) throw badRequest('برای فعال کردن پیامک، کلید API کاوه‌نگار را وارد کنید');
    if (next.email.enabled && (!next.email.host || !next.email.from)) throw badRequest('برای فعال کردن ایمیل، سرور SMTP و نشانی فرستنده را وارد کنید');
    await c.query(`UPDATE chambers SET settings = jsonb_set(settings, '{notifications}', $2::jsonb) WHERE id = $1`, [id, JSON.stringify(next)]);
    await audit(c, req, {
      chamberId: id,
      action: 'chamber.notification_settings_updated',
      entity: 'chamber',
      entityId: id,
      before: publicView(before),
      after: publicView(next),
    });
    return next;
  });
  invalidateNotificationSettings(id);
  res.json(publicView(saved));
});

/** Sends one message with the saved settings, using sample values for the variables. */
notificationSettingsRouter.post('/chambers/:id/notification-settings/test', async (req, res) => {
  const id = param(req, 'id');
  const u = currentUser(req);
  requireChamberAdmin(u, id);
  const b = body(req, z.object({ channel: z.enum(['sms', 'email']), to: z.string().min(5).max(200), event: z.enum(NOTIFICATION_EVENTS).default('meeting.invited') }));
  const s = await stored(id);
  const chamber = await one<{ name: string }>('SELECT name FROM chambers WHERE id = $1', [id]);
  const vars = Object.fromEntries(TEMPLATE_VARIABLES.map((v) => [v.key, v.sample]));
  Object.assign(vars, { نام: u.fullName, اتاق: chamber?.name ?? vars.اتاق, لینک: s.publicUrl || vars.لینک });
  const tpl = s.events[b.event];
  try {
    if (b.channel === 'sms') {
      if (!s.sms.apiKey) throw new Error('ابتدا کلید API کاوه‌نگار را ذخیره کنید');
      await sendSms(s.sms, b.to.trim(), renderTemplate(tpl.sms.text, vars));
    } else {
      if (!s.email.host) throw new Error('ابتدا تنظیمات سرور ایمیل را ذخیره کنید');
      await sendEmail(s.email, b.to.trim(), renderTemplate(tpl.email.subject, vars), renderTemplate(tpl.email.text, vars));
    }
  } catch (e) {
    throw badRequest(`ارسال آزمایشی ناموفق بود: ${(e as Error).message}`);
  }
  res.json({ sent: true });
});
