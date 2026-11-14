/**
 * Organisation profile (مشخصات سازمان): the name and logo of the organisation running the system. They are public —
 * the login page and the QR verification page show them before anybody signs in — and `org.manage` edits them.
 */
import { Router } from 'express';
import { z } from 'zod';
import { currentUser, requirePerm } from '../auth/middleware.js';
import { one, tx } from '../db/pool.js';
import { audit } from '../lib/audit.js';
import { badRequest, notFound } from '../lib/errors.js';
import { upload, uploadedName, validateFile } from '../lib/files.js';
import { getFile, putFile } from '../lib/storage.js';
import { body } from '../lib/validate.js';

/** Logos shipped with the web app, by builtin_logo. */
const BUILTIN_LOGOS: Record<string, string> = { chamber: '/iran-chamber-logo.png' };

export interface OrgProfile {
  name: string;
  shortName: string | null;
  /** The logo to show, or null for none: the uploaded image or a built-in one. */
  logoUrl: string | null;
  hasLogo: boolean;
  builtinLogo: string | null;
}

export async function orgProfile(): Promise<OrgProfile> {
  const p = await one('SELECT name, short_name, logo_key IS NOT NULL AS has_logo, builtin_logo, updated_at FROM org_profile');
  if (!p) return { name: '', shortName: null, logoUrl: null, hasLogo: false, builtinLogo: null };
  const version = new Date(p.updated_at).getTime();
  return {
    name: p.name,
    shortName: p.short_name,
    logoUrl: p.has_logo ? `/api/org-profile/logo?v=${version}` : (BUILTIN_LOGOS[p.builtin_logo] ?? null),
    hasLogo: p.has_logo,
    builtinLogo: p.builtin_logo,
  };
}

export const publicOrgProfileRouter = Router();

publicOrgProfileRouter.get('/org-profile', async (_req, res) => {
  res.json(await orgProfile());
});

publicOrgProfileRouter.get('/org-profile/logo', async (_req, res) => {
  const p = await one('SELECT logo_key, logo_mime FROM org_profile');
  if (!p?.logo_key) throw notFound('لوگویی ثبت نشده است');
  res.setHeader('content-type', p.logo_mime);
  res.setHeader('x-content-type-options', 'nosniff');
  // The URL carries the version, so the image can be cached.
  res.setHeader('cache-control', 'public, max-age=86400');
  res.send(await getFile(p.logo_key));
});

export const orgProfileRouter = Router();

orgProfileRouter.put('/org-profile', async (req, res) => {
  const u = currentUser(req);
  requirePerm(u, 'org.manage');
  const b = body(
    req,
    z.object({
      name: z.string().trim().max(300),
      shortName: z.string().trim().max(100).nullish(),
    }),
  );
  await tx(async (c) => {
    const before = (await c.query('SELECT name, short_name, builtin_logo FROM org_profile')).rows[0];
    await c.query(
      `INSERT INTO org_profile (id, name, short_name) VALUES (true, $1, $2)
       ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, short_name = EXCLUDED.short_name, updated_at = now()`,
      [b.name, b.shortName || null],
    );
    await audit(c, req, { action: 'org_profile.updated', entity: 'org_profile', before, after: { name: b.name, short_name: b.shortName || null } });
  });
  res.json(await orgProfile());
});

orgProfileRouter.post('/org-profile/logo', upload.single('file'), async (req, res) => {
  const u = currentUser(req);
  requirePerm(u, 'org.manage');
  if (!req.file) throw badRequest('فایل تصویر ارسال نشده است');
  const mime = validateFile(uploadedName(req.file), req.file.buffer);
  if (!['image/png', 'image/jpeg'].includes(mime)) throw badRequest('لوگو باید PNG یا JPG باشد');
  if (req.file.size > 2 * 1024 * 1024) throw badRequest('حجم لوگو حداکثر ۲ مگابایت است');
  const stored = await putFile('org', req.file.buffer);
  await tx(async (c) => {
    await c.query(
      `INSERT INTO org_profile (id, logo_key, logo_mime) VALUES (true, $1, $2)
       ON CONFLICT (id) DO UPDATE SET logo_key = EXCLUDED.logo_key, logo_mime = EXCLUDED.logo_mime, builtin_logo = NULL, updated_at = now()`,
      [stored.storageKey, mime],
    );
    await audit(c, req, { action: 'org_profile.logo_set', entity: 'org_profile', after: { sha256: stored.sha256, size: stored.size } });
  });
  res.json(await orgProfile());
});

orgProfileRouter.delete('/org-profile/logo', async (req, res) => {
  const u = currentUser(req);
  requirePerm(u, 'org.manage');
  await tx(async (c) => {
    const r = await c.query(
      'UPDATE org_profile SET logo_key = NULL, logo_mime = NULL, builtin_logo = NULL, updated_at = now() WHERE logo_key IS NOT NULL OR builtin_logo IS NOT NULL',
    );
    if (r.rowCount) await audit(c, req, { action: 'org_profile.logo_removed', entity: 'org_profile' });
  });
  res.json(await orgProfile());
});
