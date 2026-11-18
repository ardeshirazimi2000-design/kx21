import { Router } from 'express';
import { z } from 'zod';
import { currentUser, requirePerm } from '../auth/middleware.js';
import { config } from '../config.js';
import { one, tx } from '../db/pool.js';
import { audit } from '../lib/audit.js';
import { encryptText } from '../lib/crypto.js';
import { badRequest } from '../lib/errors.js';
import { body } from '../lib/validate.js';
import { loadEmailConfig, loadSmsConfig, normalizeMobile, sendEmail, sendSms, smsCredit, SMS_PROVIDERS, wsdlAddress } from '../services/messaging.js';

/** «یکپارچه‌سازی ← پیامک و ایمیل»: SMS panel and mail server used for notifications. */
export const messagingRouter = Router();

const envSms = () => (config.smsProvider === 'kavenegar' && !!config.kavenegarApiKey ? 'کاوه‌نگار (از فایل .env)' : null);
const envEmail = () => (config.emailProvider === 'smtp' && !!config.smtpUrl ? 'SMTP (از فایل .env)' : null);

messagingRouter.get('/integrations/sms', async (req, res) => {
  requirePerm(currentUser(req), 'integration.manage');
  const r = await one(`SELECT client_secret_enc, settings, is_active, updated_at, last_error FROM integrations WHERE kind = 'sms'`);
  const s = r?.settings ?? {};
  res.json({
    configured: !!r,
    providers: SMS_PROVIDERS,
    provider: s.provider ?? 'soap',
    sender: s.sender ?? '',
    wsdlUrl: s.wsdlUrl ?? '',
    domain: s.domain ?? '',
    username: s.username ?? '',
    flash: !!s.flash,
    hasSecret: !!r?.client_secret_enc,
    isActive: r?.is_active ?? false,
    updatedAt: r?.updated_at ?? null,
    envFallback: r ? null : envSms(),
  });
});

messagingRouter.put('/integrations/sms', async (req, res) => {
  requirePerm(currentUser(req), 'integration.manage');
  const b = body(
    req,
    z.object({
      provider: z.enum(Object.keys(SMS_PROVIDERS) as [keyof typeof SMS_PROVIDERS]),
      sender: z.string().trim().max(30).default(''),
      wsdlUrl: z.string().trim().max(500).nullish(),
      domain: z.string().trim().max(200).nullish(),
      username: z.string().trim().max(200).nullish(),
      secret: z.string().max(500).nullish(), // undefined keeps the stored one, null or '' removes it
      flash: z.boolean().default(false),
      isActive: z.boolean().default(true),
    }),
  );
  let wsdlUrl: string | null = null;
  if (b.provider === 'soap') {
    if (!b.wsdlUrl) throw badRequest('نشانی وب‌سرویس پنل پیامک را وارد کنید');
    try {
      wsdlUrl = wsdlAddress(b.wsdlUrl);
    } catch {
      throw badRequest('نشانی وب‌سرویس معتبر نیست؛ مثال: https://sms.example.ir/APPs/SMS/WebService.php?wsdl');
    }
    if (!/^https?:$/.test(new URL(wsdlUrl).protocol)) throw badRequest('نشانی وب‌سرویس باید با http یا https شروع شود');
  }
  if ((b.provider === 'soap' || b.provider === 'melipayamak') && !b.username) throw badRequest('نام کاربری پنل را وارد کنید');
  if (b.isActive && !b.sender && b.provider !== 'kavenegar') throw badRequest('شماره فرستنده (خط پیامک) را وارد کنید');
  const settings = {
    provider: b.provider,
    sender: b.sender,
    wsdlUrl,
    domain: b.provider === 'soap' ? (b.domain ?? '') : null,
    username: b.provider === 'soap' || b.provider === 'melipayamak' ? b.username : null,
    flash: b.flash,
  };
  await tx(async (c) => {
    await c.query(
      `INSERT INTO integrations (kind, name, client_secret_enc, settings, is_active) VALUES ('sms','پیامک',$1,$2,$3)
       ON CONFLICT (kind) DO UPDATE SET
         client_secret_enc = CASE WHEN $4::boolean THEN EXCLUDED.client_secret_enc ELSE integrations.client_secret_enc END,
         settings = EXCLUDED.settings, is_active = EXCLUDED.is_active, last_error = NULL, updated_at = now()`,
      [b.secret ? encryptText(b.secret) : null, JSON.stringify(settings), b.isActive, b.secret !== undefined],
    );
    await audit(c, req, { action: 'integration.sms_configured', entity: 'integration', entityId: 'sms', after: { ...settings, isActive: b.isActive, secretChanged: b.secret !== undefined } });
  });
  res.status(204).end();
});

/** Sends one SMS right away (not through the queue) and reads the panel's credit. */
messagingRouter.post('/integrations/sms/test', async (req, res) => {
  requirePerm(currentUser(req), 'integration.manage');
  const b = body(req, z.object({ to: z.string().max(30).nullish() }));
  const c = await loadSmsConfig();
  if (!c) throw badRequest('سرویس پیامک تنظیم یا فعال نشده است');
  const out: Record<string, unknown> = {};
  try {
    out.credit = { ok: true, value: await smsCredit(c) };
  } catch (e) {
    out.credit = { ok: false, error: (e as Error).message };
  }
  if (b.to) {
    try {
      out.send = { ok: true, ...(await sendSms(c, b.to, `پیامک آزمایشی سامانه رسا — ${new Date().toLocaleString('fa-IR')}`)) };
    } catch (e) {
      out.send = { ok: false, error: (e as Error).message };
    }
  }
  await tx((x) => audit(x, req, { action: 'integration.sms_tested', entity: 'integration', entityId: 'sms', after: { to: b.to ? normalizeMobile(b.to) : null, ok: (out.send as any)?.ok ?? null } }));
  res.json(out);
});

messagingRouter.get('/integrations/email', async (req, res) => {
  requirePerm(currentUser(req), 'integration.manage');
  const r = await one(`SELECT client_secret_enc, settings, is_active, updated_at FROM integrations WHERE kind = 'email'`);
  const s = r?.settings ?? {};
  res.json({
    configured: !!r,
    host: s.host ?? '',
    port: s.port ?? 587,
    secure: !!s.secure,
    user: s.user ?? '',
    from: s.from ?? '',
    fromName: s.fromName ?? '',
    hasPassword: !!r?.client_secret_enc,
    isActive: r?.is_active ?? false,
    updatedAt: r?.updated_at ?? null,
    envFallback: r ? null : envEmail(),
  });
});

messagingRouter.put('/integrations/email', async (req, res) => {
  requirePerm(currentUser(req), 'integration.manage');
  const b = body(
    req,
    z.object({
      host: z.string().trim().min(1, 'نشانی سرور ایمیل را وارد کنید').max(255),
      port: z.coerce.number().int().min(1).max(65535).default(587),
      secure: z.boolean().default(false),
      user: z.string().trim().max(255).default(''),
      password: z.string().max(500).nullish(),
      from: z.string().trim().email('نشانی فرستنده معتبر نیست'),
      fromName: z.string().trim().max(100).default(''),
      isActive: z.boolean().default(true),
    }),
  );
  const settings = { host: b.host, port: b.port, secure: b.secure, user: b.user, from: b.from, fromName: b.fromName };
  await tx(async (c) => {
    await c.query(
      `INSERT INTO integrations (kind, name, client_secret_enc, settings, is_active) VALUES ('email','ایمیل (SMTP)',$1,$2,$3)
       ON CONFLICT (kind) DO UPDATE SET
         client_secret_enc = CASE WHEN $4::boolean THEN EXCLUDED.client_secret_enc ELSE integrations.client_secret_enc END,
         settings = EXCLUDED.settings, is_active = EXCLUDED.is_active, last_error = NULL, updated_at = now()`,
      [b.password ? encryptText(b.password) : null, JSON.stringify(settings), b.isActive, b.password !== undefined],
    );
    await audit(c, req, { action: 'integration.email_configured', entity: 'integration', entityId: 'email', after: { ...settings, isActive: b.isActive, passwordChanged: b.password !== undefined } });
  });
  res.status(204).end();
});

messagingRouter.post('/integrations/email/test', async (req, res) => {
  requirePerm(currentUser(req), 'integration.manage');
  const b = body(req, z.object({ to: z.string().trim().email('نشانی ایمیل گیرنده معتبر نیست') }));
  const c = await loadEmailConfig();
  if (!c) throw badRequest('ایمیل تنظیم یا فعال نشده است');
  let out: Record<string, unknown>;
  try {
    out = { ok: true, ...(await sendEmail(c, b.to, 'ایمیل آزمایشی سامانه رسا', `این ایمیل برای آزمایش تنظیمات سرور ایمیل سامانه رسا فرستاده شد.\n${new Date().toLocaleString('fa-IR')}`)) };
  } catch (e) {
    out = { ok: false, error: (e as Error).message };
  }
  await tx((x) => audit(x, req, { action: 'integration.email_tested', entity: 'integration', entityId: 'email', after: { to: b.to, ok: out.ok } }));
  res.json(out);
});
