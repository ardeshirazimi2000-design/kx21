import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { migrate } from '../src/db/migrate.js';
import { pool } from '../src/db/pool.js';
import { seed, SEED_PASSWORD } from '../src/db/seed.js';

/** Several executive bodies per resolution, each reporting its own progress; editing and cancelling resolutions. */
const app = createApp();
const tokens: Record<string, string> = {};
let exp: string;
let chamberId: string;
let heldMeeting: string;

const as = (who: string) => ({
  get: (url: string) => request(app).get(url).set('authorization', `Bearer ${tokens[who]}`),
  post: (url: string, b: object = {}) => request(app).post(url).set('authorization', `Bearer ${tokens[who]}`).send(b),
  patch: (url: string, b: object) => request(app).patch(url).set('authorization', `Bearer ${tokens[who]}`).send(b),
});

beforeAll(async () => {
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await migrate(false);
  await seed();
  for (const [who, email] of [['secretary', 'secretary@kx.local'], ['m1', 'member1@kx.local'], ['m2', 'member2@kx.local']]) {
    tokens[who] = (await request(app).post('/api/auth/login').send({ identifier: email, password: SEED_PASSWORD })).body.accessToken;
  }
  const c = (await as('secretary').get('/api/commissions?pageSize=50')).body.items.find((x: any) => x.code === 'EXP');
  exp = c.id;
  chamberId = c.chamber_id;
  heldMeeting = (await pool.query(`SELECT id FROM meetings WHERE commission_id = $1 AND status IN ('approved','archived') LIMIT 1`, [exp])).rows[0].id;
});

describe('executive bodies of a resolution', () => {
  let id: string;
  let bodies: any[];

  it('registers a lead and partners, joining the chamber’s list of bodies', async () => {
    const owner = (await pool.query(`SELECT id FROM users WHERE email = 'member1@kx.local'`)).rows[0].id;
    const r = await as('secretary').post('/api/resolutions', {
      commissionId: exp,
      text: 'پیگیری رفع موانع صادرات محصولات کشاورزی',
      ownerId: owner,
      executors: [
        { name: ' سازمان صمت  استان ', role: 'partner' },
        { name: 'گمرک', role: 'lead' },
        { name: 'سازمان جهاد كشاورزی' },
        { name: 'گمرک' },
      ],
    });
    expect(r.status).toBe(201);
    id = r.body.id;
    expect(r.body.executors.map((e: any) => [e.name, e.role])).toEqual([
      ['گمرک', 'lead'],
      ['سازمان صمت استان', 'partner'],
      ['سازمان جهاد کشاورزی', 'partner'],
    ]);
    expect(r.body.addressee).toBe('گمرک، سازمان صمت استان، سازمان جهاد کشاورزی');
    const list = (await as('secretary').get(`/api/organizations?chamberId=${chamberId}&q=سازمان`)).body.map((o: any) => o.name);
    expect(list).toEqual(expect.arrayContaining(['سازمان صمت استان', 'سازمان جهاد کشاورزی']));
    bodies = r.body.executors;
  });

  it('each body reports its own progress; the resolution follows their average', async () => {
    const [lead, p1, p2] = bodies;
    expect((await as('m2').patch(`/api/resolutions/${id}/executors/${lead.id}/progress`, { progress: 50 })).status).toBe(403);
    let r = await as('m1').patch(`/api/resolutions/${id}/executors/${lead.id}/progress`, { progress: 90, note: 'مکاتبه با گمرک' });
    expect(r.body).toMatchObject({ progress: 30, status: 'in_progress' });
    expect((await as('m1').patch(`/api/resolutions/${id}/progress`, { progress: 10 })).body.error.code).toBe('bad_request');
    r = await as('secretary').patch(`/api/resolutions/${id}/executors/${p1.id}/progress`, { progress: 100, note: 'انجام شد' });
    expect(r.body.executors.find((e: any) => e.id === p1.id)).toMatchObject({ status: 'done', progress: 100 });
    await as('secretary').patch(`/api/resolutions/${id}/executors/${p2.id}/progress`, { progress: 100 });
    r = await as('m1').patch(`/api/resolutions/${id}/executors/${lead.id}/progress`, { progress: 100 });
    expect(r.body).toMatchObject({ progress: 100, status: 'submitted' });
    const d = (await as('secretary').get(`/api/resolutions/${id}`)).body;
    expect(d.updates.filter((u: any) => u.kind === 'progress').map((u: any) => u.executor_name)).toContain('گمرک');
  });

  it('editing the list keeps the progress of the bodies that stay', async () => {
    const r = await as('secretary').post('/api/resolutions', { commissionId: exp, text: 'مصوبه برای ویرایش دستگاه‌ها', addressee: 'بانک مرکزی' });
    expect(r.body.executors).toEqual([expect.objectContaining({ name: 'بانک مرکزی', role: 'lead' })]);
    // One body: the old single report goes to it.
    await as('secretary').patch(`/api/resolutions/${r.body.id}/progress`, { progress: 40 });
    const e = await as('secretary').patch(`/api/resolutions/${r.body.id}`, { executors: [{ name: 'وزارت اقتصاد', role: 'lead' }, { name: 'بانک مرکزی' }] });
    expect(e.status).toBe(200);
    const d = (await as('secretary').get(`/api/resolutions/${r.body.id}`)).body;
    expect(d.executors.map((x: any) => [x.name, x.role, x.progress])).toEqual([
      ['وزارت اقتصاد', 'lead', 0],
      ['بانک مرکزی', 'partner', 40],
    ]);
    expect(d.addressee).toBe('وزارت اقتصاد، بانک مرکزی');
  });
});

describe('editing and cancelling resolutions', () => {
  it('edits and cancels with a reason', async () => {
    const r = await as('secretary').post('/api/resolutions', { commissionId: exp, text: 'متن اولیه مصوبه آزمایشی', priority: 'normal' });
    const e = await as('secretary').patch(`/api/resolutions/${r.body.id}`, { text: 'متن اصلاح‌شده مصوبه', dueDate: '2027-01-01', priority: 'high' });
    expect(e.body).toMatchObject({ text: 'متن اصلاح‌شده مصوبه', priority: 'high' });
    expect((await as('m1').patch(`/api/resolutions/${r.body.id}`, { text: 'تغییر غیرمجاز' })).status).toBe(403);
    expect((await as('secretary').patch(`/api/resolutions/${r.body.id}`, { status: 'cancelled' })).status).toBe(400);
    const c = await as('secretary').patch(`/api/resolutions/${r.body.id}`, { status: 'cancelled', reason: 'تکراری ثبت شده بود' });
    expect(c.body.status).toBe('cancelled');
    expect((await as('secretary').patch(`/api/resolutions/${r.body.id}`, { text: 'پس از لغو' })).status).toBe(409);
    const d = (await as('secretary').get(`/api/resolutions/${r.body.id}`)).body;
    expect(d.updates[0].note).toContain('تکراری ثبت شده بود');
  });

  it('keeps the text of a resolution whose minutes are approved', async () => {
    const r = await as('secretary').post('/api/resolutions', { commissionId: exp, meetingId: heldMeeting, text: 'مصوبه جلسه تأییدشده' });
    expect(r.status).toBe(201);
    expect((await as('secretary').get(`/api/resolutions/${r.body.id}`)).body.textLocked).toBe(true);
    const t = await as('secretary').patch(`/api/resolutions/${r.body.id}`, { text: 'تغییر متن پس از تأیید' });
    expect(t.status).toBe(409);
    expect((await as('secretary').patch(`/api/resolutions/${r.body.id}`, { dueDate: '2027-02-01' })).status).toBe(200);
  });
});
