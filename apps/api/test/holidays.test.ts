import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { toGregorian, toJalali } from '@kx/shared';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { config } from '../src/config.js';
import { migrate } from '../src/db/migrate.js';
import { pool } from '../src/db/pool.js';
import { seed, SEED_PASSWORD } from '../src/db/seed.js';

/** Holidays in the meetings calendar, and the check against scheduling a meeting on one by mistake. */
const app = createApp();
const tokens: Record<string, string> = {};
let yazd: string;
let isf: string;
let exp: string;

const as = (who: string) => ({
  get: (url: string) => request(app).get(url).set('authorization', `Bearer ${tokens[who]}`),
  post: (url: string, b: object = {}) => request(app).post(url).set('authorization', `Bearer ${tokens[who]}`).send(b),
  patch: (url: string, b: object) => request(app).patch(url).set('authorization', `Bearer ${tokens[who]}`).send(b),
  del: (url: string) => request(app).delete(url).set('authorization', `Bearer ${tokens[who]}`),
});
const pad = (n: number) => String(n).padStart(2, '0');
const g = (jy: number, jm: number, jd: number) => {
  const [y, m, d] = toGregorian(jy, jm, jd);
  return `${y}-${pad(m)}-${pad(d)}`;
};
/** 10:00 Tehran time on that day. */
const at10 = (date: string) => `${date}T10:00:00+03:30`;

beforeAll(async () => {
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await migrate(false);
  await seed();
  for (const [who, email] of [['root', 'root@kx.local'], ['admin', 'admin@kx.local'], ['isf', 'admin.isf@kx.local'], ['secretary', 'secretary@kx.local']]) {
    tokens[who] = (await request(app).post('/api/auth/login').send({ identifier: email, password: SEED_PASSWORD })).body.accessToken;
  }
  const c = (await as('admin').get('/api/commissions?pageSize=50')).body.items.find((x: any) => x.code === 'EXP');
  exp = c.id;
  yazd = c.chamber_id;
  isf = (await pool.query(`SELECT a.chamber_id FROM chamber_admins a JOIN users u ON u.id = a.user_id WHERE u.email = 'admin.isf@kx.local'`)).rows[0].chamber_id;
  config.meetingHolidayCheck = true;
});

afterAll(() => {
  config.meetingHolidayCheck = false;
  config.holidayProvider = 'mock';
});

describe('calendar holidays', () => {
  it('lists Fridays and official holidays of a month', async () => {
    const r = await as('secretary').get(`/api/holidays?chamberId=${yazd}&from=${g(1405, 1, 1)}&to=${g(1405, 1, 31)}`);
    expect(r.status).toBe(200);
    const byDate = new Map(r.body.map((h: any) => [h.date, h]));
    expect(byDate.get(g(1405, 1, 1))).toMatchObject({ title: 'عید نوروز', source: 'official' });
    expect(byDate.get(g(1405, 1, 13))).toMatchObject({ title: 'روز طبیعت' });
    const fridays = r.body.filter((h: any) => h.title.includes('جمعه'));
    expect(fridays.length).toBeGreaterThanOrEqual(4);
    expect(byDate.has(g(1405, 1, 16))).toBe(false);
  });

  it('the Super Admin defines nationwide holidays, a chamber admin its own', async () => {
    expect((await as('admin').post('/api/holidays', { chamberId: null, date: g(1405, 5, 10), title: 'تعطیلی سراسری' })).status).toBe(403);
    const nat = await as('root').post('/api/holidays', { chamberId: null, date: g(1405, 5, 10), title: 'تعطیلی سراسری' });
    expect(nat.status).toBe(201);
    const local = await as('admin').post('/api/holidays', { chamberId: yazd, date: g(1405, 5, 12), title: 'تعطیلی استانی یزد' });
    expect(local.status).toBe(201);
    expect((await as('admin').post('/api/holidays', { chamberId: yazd, date: g(1405, 5, 12), title: 'تکراری' })).status).toBe(409);
    expect((await as('secretary').post('/api/holidays', { chamberId: yazd, date: g(1405, 5, 13), title: 'دبیر' })).status).toBe(403);
    expect((await as('isf').del(`/api/holidays/${local.body.id}`)).status).toBe(403);

    const range = `from=${g(1405, 5, 1)}&to=${g(1405, 5, 31)}`;
    const forYazd = (await as('secretary').get(`/api/holidays?chamberId=${yazd}&${range}`)).body.map((h: any) => h.title);
    expect(forYazd).toEqual(expect.arrayContaining(['تعطیلی سراسری', 'تعطیلی استانی یزد']));
    const forIsf = (await as('isf').get(`/api/holidays?chamberId=${isf}&${range}`)).body.map((h: any) => h.title);
    expect(forIsf).toContain('تعطیلی سراسری');
    expect(forIsf).not.toContain('تعطیلی استانی یزد');
    // Another chamber's calendar is not visible.
    expect((await as('isf').get(`/api/holidays?chamberId=${yazd}&${range}`)).status).toBe(404);
  });
});

describe('fixed solar holidays', () => {
  it('the Super Admin adds a year\'s fixed holidays once', async () => {
    expect((await as('admin').post('/api/holidays/solar', { year: 1406 })).status).toBe(403);
    const r = await as('root').post('/api/holidays/solar', { year: 1406 });
    expect(r.body).toEqual({ year: 1406, added: 10, total: 10 });
    expect((await as('root').post('/api/holidays/solar', { year: 1406 })).body.added).toBe(0);
    const list = (await as('admin').get(`/api/holidays/defined?chamberId=${yazd}&from=${g(1406, 1, 1)}&to=${g(1406, 12, 29)}`)).body;
    expect(list.map((h: any) => h.date)).toEqual(expect.arrayContaining([g(1406, 1, 1), g(1406, 3, 14), g(1406, 11, 22), g(1406, 12, 29)]));
    expect(list.find((h: any) => h.date === g(1406, 1, 13)).title).toBe('روز طبیعت');
  });
});

describe('meetings on holidays', () => {
  it('asks for confirmation instead of scheduling on a holiday', async () => {
    const date = g(1405, 11, 22);
    const r = await as('secretary').post('/api/meetings', { commissionId: exp, title: 'جلسه روز تعطیل', scheduledAt: at10(date) });
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe('holiday');
    expect(r.body.error.message).toContain('پیروزی انقلاب اسلامی');
    expect(r.body.error.details.holiday.date).toBe(date);
    const ok = await as('secretary').post('/api/meetings', { commissionId: exp, title: 'جلسه روز تعطیل', scheduledAt: at10(date), allowHoliday: true });
    expect(ok.status).toBe(201);
  });

  it('checks a meeting moved to another day, including chamber holidays', async () => {
    const m = await as('secretary').post('/api/meetings', { commissionId: exp, title: 'جلسه عادی', scheduledAt: at10(g(1405, 5, 11)) });
    expect(m.status).toBe(201);
    const moved = await as('secretary').patch(`/api/meetings/${m.body.id}`, { scheduledAt: at10(g(1405, 5, 12)) });
    expect(moved.status).toBe(409);
    expect(moved.body.error.message).toContain('تعطیلی استانی یزد');
    expect((await as('secretary').patch(`/api/meetings/${m.body.id}`, { scheduledAt: at10(g(1405, 5, 12)), allowHoliday: true })).status).toBe(200);
    // Changing only the hour on the same day is not asked again.
    expect((await as('secretary').patch(`/api/meetings/${m.body.id}`, { scheduledAt: `${g(1405, 5, 12)}T12:00:00+03:30` })).status).toBe(200);
  });
});

describe('official calendar web service (s.api.ir IsHoliday)', () => {
  let server: http.Server;
  const calls: any[] = [];
  let reply: (b: any) => unknown = () => ({});

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      let data = '';
      req.on('data', (c) => (data += c));
      req.on('end', () => {
        const b = JSON.parse(data);
        calls.push({ body: b, auth: req.headers.authorization });
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify(reply(b)));
      });
    });
    await new Promise<void>((r) => server.listen(0, r));
    config.holidayProvider = 'sapi';
    config.holidayApiUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/sw1/IsHoliday`;
    config.holidayApiToken = 'Bearer test-token';
    await pool.query('DELETE FROM holiday_lookups');
  });
  afterAll(async () => {
    config.holidayApiDateVerified = false;
    await new Promise((r) => server.close(r));
  });

  it('asks with the Jalali date, reads the answer and caches it', async () => {
    reply = (b) => ({ isSuccess: true, data: { isHoliday: b.date === '1405/12/29', events: [{ description: 'روز ملی شدن صنعت نفت', isHoliday: true }] } });
    const d = g(1405, 12, 29);
    // Not used for the calendar until it is known to answer about the day asked.
    expect((await as('secretary').get(`/api/holidays?chamberId=${yazd}&from=${d}&to=${d}`)).body).toEqual([]);
    expect(calls.length).toBe(0);
    config.holidayApiDateVerified = true;
    const r = await as('secretary').get(`/api/holidays?chamberId=${yazd}&from=${d}&to=${d}`);
    expect(r.body).toEqual([expect.objectContaining({ date: d, title: 'روز ملی شدن صنعت نفت', source: 'official' })]);
    expect(calls[0]).toEqual({ body: { date: '1405/12/29', weekend: true }, auth: 'Bearer test-token' });
    await as('secretary').get(`/api/holidays?chamberId=${yazd}&from=${d}&to=${d}`);
    expect(calls.length).toBe(1);
  });

  it('lets the Super Admin test the connection and see the raw answer', async () => {
    reply = () => ({ status: 'ok', something: 1 });
    const t = await as('root').post('/api/holidays/service/test', { date: g(1405, 12, 20) });
    expect(t.body).toMatchObject({ ok: false, code: 'holiday_unrecognized', raw: { sent: { date: '1405/12/20', weekend: true }, received: { status: 'ok', something: 1 } } });
    expect((await as('admin').post('/api/holidays/service/test', { date: g(1405, 12, 20) })).status).toBe(403);
    expect((await as('admin').get('/api/holidays/service')).body).toMatchObject({ provider: 'sapi', enabled: true });
  });

  it('detects the field and date format the service expects', async () => {
    // Like s.api.ir: a bare answer, and an unknown field is ignored (it then answers about today, a working day).
    const now = new Date();
    const [jy] = toJalali(now.getFullYear(), now.getMonth() + 1, now.getDate());
    reply = (b) => ({ data: b.persianDate === `${jy}/1/1`, success: true, code: 0, message: '' });
    config.holidayApiDateVerified = false;
    calls.length = 0;
    const r = await as('root').post('/api/holidays/service/detect');
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ found: true, style: { field: 'persianDate', format: 'jn' } });
    expect(r.body.tried.length).toBeGreaterThan(5);
    expect((await as('admin').post('/api/holidays/service/detect')).status).toBe(403);
    // From now on days are asked that way.
    calls.length = 0;
    const d = g(jy, 1, 1);
    const h = await as('secretary').get(`/api/holidays?chamberId=${yazd}&from=${d}&to=${d}`);
    expect(calls[0].body).toEqual({ persianDate: `${jy}/1/1`, weekend: true });
    expect(h.body).toEqual([expect.objectContaining({ date: d, title: 'تعطیل رسمی', source: 'official' })]);
    expect((await as('root').get('/api/holidays/service')).body.dateStyle).toEqual({ field: 'persianDate', format: 'jn' });
  });

  it('reports when no format works', async () => {
    reply = () => ({ data: false, success: true, code: 0, message: '' });
    const r = await as('root').post('/api/holidays/service/detect');
    expect(r.body).toMatchObject({ found: false, style: { field: 'persianDate', format: 'jn' } });
    await pool.query(`DELETE FROM app_settings`);
  });

  it('does not block scheduling when the service cannot answer', async () => {
    reply = () => ({ unexpected: true });
    const d = g(1405, 12, 18);
    const m = await as('secretary').post('/api/meetings', { commissionId: exp, title: 'جلسه بدون پاسخ سرویس', scheduledAt: at10(d) });
    expect(m.status).toBe(201);
  });
});
