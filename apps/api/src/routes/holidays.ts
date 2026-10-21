import { toGregorian } from '@kx/shared';
import { Router } from 'express';
import { z } from 'zod';
import { currentUser, type AuthUser } from '../auth/middleware.js';
import { config } from '../config.js';
import { one, pool, query, tx } from '../db/pool.js';
import { audit } from '../lib/audit.js';
import { badRequest, conflict, forbidden, notFound } from '../lib/errors.js';
import { body, param, uuid } from '../lib/validate.js';
import { requireChamberAdmin, visibleChamberIds } from '../services/access.js';
import { askOfficial, dateStyle, dateStyleVerified, detectDateStyle, holidaysBetween, officialCalendarEnabled } from '../services/holidays.js';

/** Holidays of the meetings calendar (تعطیلات). */
export const holidaysRouter = Router();

const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'تاریخ باید به شکل YYYY-MM-DD باشد');

async function requireVisibleChamber(u: AuthUser, chamberId: string | null) {
  if (!chamberId) return;
  const ids = await visibleChamberIds(u);
  if (ids && !ids.includes(chamberId)) throw notFound();
}

/** Holidays shown in the calendar: Fridays, official holidays and those defined for the country or the chamber. */
holidaysRouter.get('/holidays', async (req, res) => {
  const q = z.object({ chamberId: uuid.nullish(), from: day, to: day }).parse(req.query);
  await requireVisibleChamber(currentUser(req), q.chamberId ?? null);
  if (q.to < q.from) throw badRequest('بازه تاریخ نامعتبر است');
  res.json(await holidaysBetween(q.chamberId ?? null, q.from, q.to));
});

/** Holidays defined in the system for a year range (management page). */
holidaysRouter.get('/holidays/defined', async (req, res) => {
  const q = z.object({ chamberId: uuid.nullish(), from: day, to: day }).parse(req.query);
  await requireVisibleChamber(currentUser(req), q.chamberId ?? null);
  const rows = await query(
    `SELECT h.id, to_char(h.date, 'YYYY-MM-DD') AS date, h.title, h.chamber_id, c.name AS chamber_name, u.full_name AS created_by_name
       FROM holidays h LEFT JOIN chambers c ON c.id = h.chamber_id LEFT JOIN users u ON u.id = h.created_by
      WHERE h.date BETWEEN $1 AND $2 AND (h.chamber_id IS NULL OR h.chamber_id = $3) ORDER BY h.date`,
    [q.from, q.to, q.chamberId ?? null],
  );
  res.json(rows);
});

/** Nationwide holidays are defined by the Super Admin, a chamber's own (e.g. a provincial occasion) by its admin. */
function requireHolidayManager(u: AuthUser, chamberId: string | null) {
  if (chamberId) requireChamberAdmin(u, chamberId);
  else if (!u.isSuperAdmin) throw forbidden('تعطیلات سراسری را مدیر سامانه تعریف می‌کند');
}

holidaysRouter.post('/holidays', async (req, res) => {
  const u = currentUser(req);
  const b = body(req, z.object({ chamberId: uuid.nullable(), date: day, title: z.string().trim().min(2).max(120) }));
  requireHolidayManager(u, b.chamberId);
  const row = await tx(async (c) => {
    const r = await one(
      `INSERT INTO holidays (chamber_id, date, title, created_by) VALUES ($1,$2,$3,$4)
       RETURNING id, to_char(date, 'YYYY-MM-DD') AS date, title, chamber_id`,
      [b.chamberId, b.date, b.title, u.id],
      c,
    ).catch((e) => {
      if (e.code === '23505') throw conflict('برای این روز قبلاً تعطیلی تعریف شده است');
      throw e;
    });
    await audit(c, req, { chamberId: b.chamberId, action: 'holiday.created', entity: 'holiday', entityId: r.id, after: r });
    return r;
  });
  res.status(201).json(row);
});

/** Official holidays fixed in the solar calendar (the same day every year). Lunar holidays move and are added by hand. */
const SOLAR_HOLIDAYS: [number, number, string][] = [
  [1, 1, 'عید نوروز'],
  [1, 2, 'عید نوروز'],
  [1, 3, 'عید نوروز'],
  [1, 4, 'عید نوروز'],
  [1, 12, 'روز جمهوری اسلامی'],
  [1, 13, 'روز طبیعت'],
  [3, 14, 'رحلت امام خمینی'],
  [3, 15, 'قیام ۱۵ خرداد'],
  [11, 22, 'پیروزی انقلاب اسلامی'],
  [12, 29, 'ملی شدن صنعت نفت'],
];

/** Adds a year's fixed solar holidays as nationwide holidays (days already defined are left as they are). */
holidaysRouter.post('/holidays/solar', async (req, res) => {
  const u = currentUser(req);
  if (!u.isSuperAdmin) throw forbidden('تعطیلات سراسری را مدیر سامانه تعریف می‌کند');
  const b = body(req, z.object({ year: z.number().int().min(1390).max(1500) }));
  const added = await tx(async (c) => {
    let n = 0;
    for (const [m, d, title] of SOLAR_HOLIDAYS) {
      const [gy, gm, gd] = toGregorian(b.year, m, d);
      const r = await c.query(
        `INSERT INTO holidays (chamber_id, date, title, created_by) VALUES (NULL, $1, $2, $3) ON CONFLICT DO NOTHING`,
        [`${gy}-${String(gm).padStart(2, '0')}-${String(gd).padStart(2, '0')}`, title, u.id],
      );
      n += r.rowCount ?? 0;
    }
    await audit(c, req, { chamberId: null, action: 'holiday.solar_added', entity: 'holiday', entityId: String(b.year), after: { year: b.year, added: n } });
    return n;
  });
  res.status(201).json({ year: b.year, added, total: SOLAR_HOLIDAYS.length });
});

holidaysRouter.delete('/holidays/:id', async (req, res) => {
  const u = currentUser(req);
  const h = await one('SELECT * FROM holidays WHERE id = $1', [param(req, 'id')]);
  if (!h) throw notFound();
  requireHolidayManager(u, h.chamber_id);
  await tx(async (c) => {
    await c.query('DELETE FROM holidays WHERE id = $1', [h.id]);
    await audit(c, req, { chamberId: h.chamber_id, action: 'holiday.deleted', entity: 'holiday', entityId: h.id, before: h });
  });
  res.status(204).end();
});

/** Connection status of the official calendar web service. */
holidaysRouter.get('/holidays/service', async (req, res) => {
  const u = currentUser(req);
  if (!u.isSuperAdmin && !u.adminChambers.length) throw forbidden();
  const last = await one<{ n: number; last: string | null }>('SELECT count(*)::int AS n, max(checked_at) AS last FROM holiday_lookups');
  res.json({
    provider: config.holidayProvider,
    enabled: officialCalendarEnabled(),
    url: config.holidayApiUrl,
    dateStyle: config.holidayProvider === 'sapi' ? await dateStyle() : null,
    // Not used for the calendar until it is known to answer about the day asked.
    dateVerified: config.holidayProvider === 'sapi' ? await dateStyleVerified() : true,
    cachedDays: last?.n ?? 0,
    lastCheckedAt: last?.last ?? null,
  });
});

/** Asks the web service about one day and shows its answer as received (to check the connection). */
holidaysRouter.post('/holidays/service/test', async (req, res) => {
  const u = currentUser(req);
  if (!u.isSuperAdmin) throw forbidden();
  const b = body(req, z.object({ date: day }));
  try {
    res.json({ ok: true, ...(await askOfficial(b.date)) });
  } catch (e: any) {
    res.json({ ok: false, error: e.message, code: e.code, raw: e.raw });
  }
});

/** Finds the field name and date format the web service expects, by asking about Nowruz and a working day. */
holidaysRouter.post('/holidays/service/detect', async (req, res) => {
  const u = currentUser(req);
  if (!u.isSuperAdmin) throw forbidden();
  const r = await detectDateStyle(u.id);
  await audit(pool, req, { chamberId: null, action: 'holiday.service_detected', entity: 'setting', entityId: 'holiday_api_date_style', after: { found: r.found, style: r.style } });
  res.json(r);
});

/** Forgets cached answers (e.g. after the official calendar changed), so they are asked again. */
holidaysRouter.delete('/holidays/service/cache', async (req, res) => {
  const u = currentUser(req);
  if (!u.isSuperAdmin) throw forbidden();
  await query('DELETE FROM holiday_lookups');
  res.status(204).end();
});
