import { Router } from 'express';
import { z } from 'zod';
import { jpegsToPdf } from '@kx/shared';
import { currentUser, requirePerm } from '../auth/middleware.js';
import { one, pool, query, tx } from '../db/pool.js';
import { audit } from '../lib/audit.js';
import { badRequest, conflict, HttpError, notFound } from '../lib/errors.js';
import { capabilities, EsclError, normalizeRoot, scan, status, type EsclCapabilities } from '../lib/escl.js';
import { body, param } from '../lib/validate.js';

/**
 * Network scanners (eSCL / AirScan). IT registers them; anyone who writes letters can scan straight into an attachment:
 * the server runs the job on the scanner and returns the pages as one PDF, which the browser attaches like any file.
 */
export const scannersRouter = Router();

const scannerSchema = z.object({
  name: z.string().trim().min(2).max(100),
  url: z.string().trim().min(8).max(500),
  location: z.string().trim().max(200).nullish(),
  isActive: z.boolean().optional(),
});

const root = (url: string) => {
  try {
    return normalizeRoot(url);
  } catch (e) {
    throw badRequest(e instanceof EsclError ? e.message : 'نشانی اسکنر معتبر نیست');
  }
};

/** Scanner errors reach the user as a plain 502 with the Persian reason; the last one is kept for IT. */
async function scannerCall<T>(id: string, fn: () => Promise<T>): Promise<T> {
  try {
    const out = await fn();
    await query('UPDATE scanners SET last_error = NULL, last_used_at = now() WHERE id = $1', [id]);
    return out;
  } catch (e) {
    if (!(e instanceof EsclError)) throw e;
    await query('UPDATE scanners SET last_error = $2 WHERE id = $1', [id, e.message]);
    throw new HttpError(502, 'scanner_error', e.message);
  }
}

scannersRouter.get('/scanners', async (req, res) => {
  const u = currentUser(req);
  const admin = u.can('integration.manage');
  if (!admin) requirePerm(u, 'letter.create');
  const rows = await query(
    `SELECT id, name, location, is_active${admin ? ', url, last_used_at, last_error' : ''} FROM scanners WHERE $1 OR is_active ORDER BY name`,
    [admin],
  );
  res.json(rows);
});

scannersRouter.post('/scanners', async (req, res) => {
  requirePerm(currentUser(req), 'integration.manage');
  const b = body(req, scannerSchema);
  const row = await tx(async (c) => {
    const r = await one(
      `INSERT INTO scanners (name, url, location, is_active) VALUES ($1,$2,$3,$4) RETURNING *`,
      [b.name, root(b.url), b.location ?? null, b.isActive ?? true],
      c,
    );
    await audit(c, req, { action: 'scanner.created', entity: 'scanner', entityId: r.id, after: r });
    return r;
  });
  res.status(201).json(row);
});

scannersRouter.patch('/scanners/:id', async (req, res) => {
  requirePerm(currentUser(req), 'integration.manage');
  const b = body(req, scannerSchema.partial());
  const row = await tx(async (c) => {
    const before = await one('SELECT * FROM scanners WHERE id = $1 FOR UPDATE', [param(req, 'id')], c);
    if (!before) throw notFound();
    const r = await one(
      `UPDATE scanners SET name = COALESCE($2, name), url = COALESCE($3, url), location = CASE WHEN $4::boolean THEN $5 ELSE location END,
         is_active = COALESCE($6, is_active), updated_at = now() WHERE id = $1 RETURNING *`,
      [before.id, b.name ?? null, b.url ? root(b.url) : null, b.location !== undefined, b.location ?? null, b.isActive ?? null],
      c,
    );
    await audit(c, req, { action: 'scanner.updated', entity: 'scanner', entityId: r.id, before, after: r });
    return r;
  });
  res.json(row);
});

scannersRouter.delete('/scanners/:id', async (req, res) => {
  requirePerm(currentUser(req), 'integration.manage');
  await tx(async (c) => {
    const before = await one('DELETE FROM scanners WHERE id = $1 RETURNING *', [param(req, 'id')], c);
    if (!before) throw notFound();
    await audit(c, req, { action: 'scanner.deleted', entity: 'scanner', entityId: before.id, before });
  });
  res.status(204).end();
});

async function activeScanner(id: string) {
  const s = await one('SELECT * FROM scanners WHERE id = $1 AND is_active', [id]);
  if (!s) throw notFound('اسکنر یافت نشد');
  return s;
}

/** Sources, colour modes and resolutions the scanner offers, and whether it is ready. */
scannersRouter.get('/scanners/:id/capabilities', async (req, res) => {
  requirePerm(currentUser(req), 'letter.create');
  const s = await activeScanner(param(req, 'id'));
  const out = await scannerCall(s.id, async () => {
    const caps = await capabilities(s.url);
    const st = await status(s.url).catch(() => null);
    return { ...caps, state: st?.state ?? null, adfState: st?.adf ?? null };
  });
  res.json(out);
});

// One job at a time per scanner: a second user waits for the paper of the first.
const running = new Set<string>();

scannersRouter.post('/scanners/:id/scan', async (req, res) => {
  const u = currentUser(req);
  requirePerm(u, 'letter.create');
  const b = body(
    req,
    z.object({
      source: z.enum(['Platen', 'Feeder', 'FeederDuplex']).default('Platen'),
      colorMode: z.enum(['RGB24', 'Grayscale8']).default('Grayscale8'),
      resolution: z.number().int().min(75).max(600).default(300),
    }),
  );
  const s = await activeScanner(param(req, 'id'));
  if (running.has(s.id)) throw conflict('اسکنر در حال اسکن برای کاربر دیگری است؛ چند لحظه بعد دوباره تلاش کنید');
  running.add(s.id);
  try {
    const pdf = await scannerCall(s.id, async () => {
      let caps: EsclCapabilities | undefined;
      try {
        caps = await capabilities(s.url);
      } catch {
        caps = undefined;
      }
      if (caps && !caps.sources.includes(b.source)) throw new EsclError('این اسکنر منبع انتخاب‌شده را ندارد');
      const offered = caps ? (caps.sourceResolutions[b.source === 'Platen' ? 'Platen' : 'Feeder'] ?? caps.resolutions) : [b.resolution];
      const resolution = offered.reduce((best, r) => (Math.abs(r - b.resolution) < Math.abs(best - b.resolution) ? r : best), offered[0]);
      const pages = await scan(s.url, { ...b, resolution }, caps);
      try {
        return { bytes: Buffer.from(jpegsToPdf(pages)), pages: pages.length };
      } catch {
        throw new EsclError('خروجی اسکنر تصویر JPEG معتبر نبود');
      }
    });
    await audit(pool, req, {
      action: 'scanner.scanned',
      entity: 'scanner',
      entityId: s.id,
      after: { pages: pdf.pages, source: b.source, colorMode: b.colorMode },
    });
    res.setHeader('content-type', 'application/pdf');
    res.setHeader('x-scan-pages', String(pdf.pages));
    res.setHeader('content-disposition', `attachment; filename*=UTF-8''${encodeURIComponent(`اسکن-${s.name}.pdf`)}`);
    res.setHeader('cache-control', 'private, no-store');
    res.send(pdf.bytes);
  } finally {
    running.delete(s.id);
  }
});
