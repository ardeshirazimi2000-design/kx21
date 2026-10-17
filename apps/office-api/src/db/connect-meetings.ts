/**
 * Connects office automation to the commission meetings system in one step (used by deploy scripts):
 * logs in to the meetings API as a chamber admin, registers this system as an integration client with
 * its webhook, and stores the issued API key and webhook secret (encrypted) in the office database.
 *
 *   MEETINGS_URL=http://api:4000 MEETINGS_ADMIN_EMAIL=admin@kx.local MEETINGS_ADMIN_PASSWORD=… \
 *   OFFICE_WEBHOOK_URL=http://office-api:4100/api/integrations/meetings/webhook node dist/db/connect-meetings.js
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { encryptText } from '../lib/crypto.js';
import { pool } from './pool.js';

async function call(base: string, method: string, url: string, token: string | null, body?: unknown) {
  const r = await fetch(`${base}/api${url}`, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await r.text();
  const data = text ? JSON.parse(text) : null;
  if (!r.ok) throw new Error(`${method} ${url}: ${r.status} ${data?.error?.message ?? text}`);
  return data;
}

export async function connectMeetings(opts: { meetingsUrl: string; email: string; password: string; webhookUrl: string; name?: string }) {
  const base = opts.meetingsUrl.replace(/\/+$/, '');
  const login = await call(base, 'POST', '/auth/login', null, { identifier: opts.email, password: opts.password });
  if (!login.accessToken) throw new Error('ورود دومرحله‌ای برای این حساب فعال است؛ اتصال را از صفحه یکپارچه‌سازی انجام دهید');
  const me = await call(base, 'GET', '/auth/me', login.accessToken);
  const chamberId = me.adminChambers?.[0] ?? me.chamber_id;
  if (!chamberId) throw new Error('این حساب مدیر هیچ اتاقی نیست');
  const name = opts.name ?? 'اتوماسیون اداری';
  const existing = (await call(base, 'GET', `/integrations?chamberId=${chamberId}`, login.accessToken)).items.find((c: any) => c.name === name);
  const client = existing
    ? await call(base, 'POST', `/integrations/${existing.id}/rotate`, login.accessToken)
    : await call(base, 'POST', '/integrations', login.accessToken, { chamberId, name, webhookUrl: opts.webhookUrl });
  if (existing) await call(base, 'PATCH', `/integrations/${existing.id}`, login.accessToken, { webhookUrl: opts.webhookUrl, isActive: true });
  await pool.query(
    `INSERT INTO integrations (kind, name, base_url, client_id, client_secret_enc, webhook_secret_enc, settings, is_active)
     VALUES ('meetings', 'سامانه جلسات کمیسیون‌ها', $1, $2, $3, $4, '{}'::jsonb, true)
     ON CONFLICT (kind) DO UPDATE SET base_url = EXCLUDED.base_url, client_id = EXCLUDED.client_id, client_secret_enc = EXCLUDED.client_secret_enc,
       webhook_secret_enc = EXCLUDED.webhook_secret_enc, is_active = true, last_error = NULL, updated_at = now()`,
    [base, client.clientId, encryptText(client.apiKey), encryptText(client.webhookSecret)],
  );
  return { chamberId, clientId: client.clientId as string };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const need = (k: string) => {
    const v = process.env[k];
    if (!v) throw new Error(`${k} is required`);
    return v;
  };
  connectMeetings({
    meetingsUrl: need('MEETINGS_URL'),
    email: need('MEETINGS_ADMIN_EMAIL'),
    password: need('MEETINGS_ADMIN_PASSWORD'),
    webhookUrl: need('OFFICE_WEBHOOK_URL'),
  })
    .then((r) => console.log('Connected to the meetings system (client %s).', r.clientId))
    .catch((e) => {
      console.error(e.message);
      process.exitCode = 1;
    })
    .finally(() => pool.end());
}
