import { toGregorian } from '@kx/shared';
import { Router } from 'express';
import { z } from 'zod';
import { currentUser, type AuthUser } from '../auth/middleware.js';
import { one, query, tx } from '../db/pool.js';
import { audit } from '../lib/audit.js';
import { badRequest, conflict, forbidden, notFound } from '../lib/errors.js';
import { body, param, uuid } from '../lib/validate.js';
import { requireChamberAdmin, visibleChamberIds } from '../services/access.js';
import { IRAN_HOLIDAYS } from '../services/iranHolidays.js';
import { holidaysBetween } from '../services/holidays.js';

/** Holidays of the meetings calendar (تعطیلات). */
export const holidaysRouter = Router();

const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'تاریخ باید به شکل YYYY-MM-DD باشد');

async function requireVisibleChamber(u: AuthUser, chamberId: string | null) {
  if (!chamberId) return;
  const ids = await visibleChamberIds(u);
  if (ids && !ids.includes(chamberId)) throw notFound();
}

/** Holidays shown in the calendar: Fridays and those defined for the country or the chamber. */
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

/** Official holidays fixed in the solar calendar (the same day every year), for years outside the dataset. */
const SOLAR_HOLIDAYS: [string, string][] = [
  ['01/01', 'عید نوروز'],
  ['01/02', 'عید نوروز'],
  ['01/03', 'عید نوروز'],
  ['01/04', 'عید نوروز'],
  ['01/12', 'روز جمهوری اسلامی'],
  ['01/13', 'روز طبیعت'],
  ['03/14', 'رحلت امام خمینی'],
  ['03/15', 'قیام ۱۵ خرداد'],
  ['11/22', 'پیروزی انقلاب اسلامی'],
  ['12/29', 'ملی شدن صنعت نفت'],
];

/** A year's official holidays: the dataset when it has the year, otherwise the fixed solar ones only. */
function officialList(year: number) {
  const known = IRAN_HOLIDAYS[year];
  const days = known?.days ?? SOLAR_HOLIDAYS;
  return {
    source: known ? ('dataset' as const) : ('solar' as const),
    missing: known?.missing ?? [],
    items: days.map(([md, title]) => {
      const [m, d] = md.split('/').map(Number);
      const [gy, gm, gd] = toGregorian(year, m, d);
      return { date: `${gy}-${String(gm).padStart(2, '0')}-${String(gd).padStart(2, '0')}`, jalali: `${year}/${md}`, title };
    }),
  };
}

const yearParam = z.coerce.number().int().min(1390).max(1500);

/** Preview of a year's official holidays, with the days already defined marked. */
holidaysRouter.get('/holidays/official', async (req, res) => {
  const u = currentUser(req);
  if (!u.isSuperAdmin) throw forbidden();
  const year = yearParam.parse(req.query.year);
  const list = officialList(year);
  const existing = new Set(
    (await query<{ date: string }>(`SELECT to_char(date, 'YYYY-MM-DD') AS date FROM holidays WHERE chamber_id IS NULL AND date = ANY($1::date[])`, [list.items.map((i) => i.date)])).map(
      (r) => r.date,
    ),
  );
  res.json({ year, ...list, items: list.items.map((i) => ({ ...i, exists: existing.has(i.date) })) });
});

/** Adds the reviewed official holidays (all, or the chosen days) as nationwide holidays; days already defined stay. */
holidaysRouter.post('/holidays/official', async (req, res) => {
  const u = currentUser(req);
  if (!u.isSuperAdmin) throw forbidden('تعطیلات سراسری را مدیر سامانه تعریف می‌کند');
  const b = body(req, z.object({ year: yearParam, dates: z.array(day).optional() }));
  const list = officialList(b.year);
  const chosen = b.dates ? list.items.filter((i) => b.dates!.includes(i.date)) : list.items;
  const added = await tx(async (c) => {
    let n = 0;
    for (const i of chosen) {
      const r = await c.query(`INSERT INTO holidays (chamber_id, date, title, created_by) VALUES (NULL, $1, $2, $3) ON CONFLICT DO NOTHING`, [i.date, i.title, u.id]);
      n += r.rowCount ?? 0;
    }
    await audit(c, req, { chamberId: null, action: 'holiday.official_added', entity: 'holiday', entityId: String(b.year), after: { year: b.year, source: list.source, added: n } });
    return n;
  });
  res.status(201).json({ year: b.year, source: list.source, added, total: chosen.length });
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
