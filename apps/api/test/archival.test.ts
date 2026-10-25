import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { migrate } from '../src/db/migrate.js';
import { pool } from '../src/db/pool.js';
import { seed, SEED_PASSWORD } from '../src/db/seed.js';
import { runScheduledJobs } from '../src/services/scheduler.js';

/** Recording a meeting held before the system was used (ثبت از سوابق). */
const app = createApp();
const tokens: Record<string, string> = {};
const ids: Record<string, string> = {};
let exp: string;
let meetingId: string;

const as = (who: string) => ({
  get: (url: string) => request(app).get(url).set('authorization', `Bearer ${tokens[who]}`),
  post: (url: string, b: object = {}) => request(app).post(url).set('authorization', `Bearer ${tokens[who]}`).send(b),
  patch: (url: string, b: object) => request(app).patch(url).set('authorization', `Bearer ${tokens[who]}`).send(b),
  del: (url: string) => request(app).delete(url).set('authorization', `Bearer ${tokens[who]}`),
});
const notifications = async () => Number((await pool.query('SELECT count(*) FROM notifications')).rows[0].count);

beforeAll(async () => {
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await migrate(false);
  await seed();
  for (const [who, email] of [['secretary', 'secretary@kx.local'], ['m1', 'member1@kx.local']]) {
    tokens[who] = (await request(app).post('/api/auth/login').send({ identifier: email, password: SEED_PASSWORD })).body.accessToken;
  }
  for (const email of ['member1@kx.local', 'member2@kx.local', 'member3@kx.local', 'guest@kx.local']) {
    ids[email] = (await pool.query('SELECT id FROM users WHERE email = $1', [email])).rows[0].id;
  }
  exp = (await as('secretary').get('/api/commissions?pageSize=50')).body.items.find((x: any) => x.code === 'EXP').id;
});

describe('meetings recorded from the archive', () => {
  it('creates a past meeting with its real times and the members of that day, notifying nobody', async () => {
    const before = await notifications();
    expect((await as('secretary').post('/api/meetings/archival', { commissionId: exp, title: 'آینده', date: '2099-01-01', startTime: '10:00', endTime: '11:00' })).status).toBe(400);
    expect((await as('m1').post('/api/meetings/archival', { commissionId: exp, title: 'عضو', date: '2025-05-10', startTime: '10:00', endTime: '11:00' })).status).toBe(403);
    const r = await as('secretary').post('/api/meetings/archival', {
      commissionId: exp, number: 3, title: 'بررسی مشکلات صادرکنندگان', date: '2025-05-10', startTime: '10:00', endTime: '12:30', location: 'سالن جلسات',
    });
    expect(r.status).toBe(201);
    meetingId = r.body.id;
    expect(r.body).toMatchObject({ archival: true, status: 'minutes_draft', number: 3, duration_minutes: 150 });
    expect(new Date(r.body.started_at).toISOString()).toBe('2025-05-10T06:30:00.000Z');
    const dup = await as('secretary').post('/api/meetings/archival', { commissionId: exp, number: 3, title: 'تکراری', date: '2025-06-10', startTime: '10:00', endTime: '11:00' });
    expect(dup.status).toBe(409);
    const m = (await as('secretary').get(`/api/meetings/${meetingId}`)).body;
    expect(m.invitees.length).toBe(10);
    expect(m.invitees.every((i: any) => i.status === 'pending')).toBe(true);
    expect(await notifications()).toBe(before);
  });

  it('records attendance in bulk and person by person, and guests added afterwards', async () => {
    expect((await as('secretary').post(`/api/meetings/${meetingId}/attendance/bulk`, { status: 'manual_present' })).body.updated).toBe(10);
    await as('secretary').post(`/api/meetings/${meetingId}/attendance/bulk`, { status: 'absent', userIds: [ids['member2@kx.local']] });
    await as('secretary').post(`/api/meetings/${meetingId}/attendance/${ids['member3@kx.local']}/confirm`, { status: 'excused', reason: 'مأموریت' });
    const before = await notifications();
    expect((await as('secretary').post(`/api/meetings/${meetingId}/invitees`, { userId: ids['guest@kx.local'], role: 'guest' })).status).toBe(204);
    expect(await notifications()).toBe(before);
    const m = (await as('secretary').get(`/api/meetings/${meetingId}`)).body;
    expect(m.invitees.find((i: any) => i.user_id === ids['guest@kx.local']).status).toBe('pending');
    // The real day and hours can still be corrected.
    const e = await as('secretary').patch(`/api/meetings/${meetingId}`, { date: '2025-05-11', startTime: '09:00', endTime: '11:00', number: 4 });
    expect(e.status).toBe(200);
    expect(e.body).toMatchObject({ number: 4, duration_minutes: 120 });
    expect(new Date(e.body.ended_at).toISOString()).toBe('2025-05-11T07:30:00.000Z');
  });

  it('records the agenda, the vote result and resolutions for the record', async () => {
    const item = await as('secretary').post(`/api/meetings/${meetingId}/agenda`, { title: 'رفع موانع صادرات به عراق' });
    expect(item.status).toBe(201);
    const v = await as('secretary').post(`/api/agenda-items/${item.body.id}/vote/manual`, { yes: 6, no: 1, abstain: 1, passed: true });
    expect(v.status).toBe(201);
    const r = await as('secretary').post('/api/resolutions', {
      commissionId: exp, meetingId, agendaItemId: item.body.id, voteSessionId: v.body.id, number: '۴/۱', dueDate: '2025-06-01',
      text: 'پیگیری رفع موانع صادرات به عراق از طریق مرز', executors: [{ name: 'گمرک استان', role: 'lead' }, { name: 'سازمان صمت استان' }],
    });
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ number: '۴/۱', archival: true });
    ids.resolution = r.body.id;
    for (const e of r.body.executors) {
      await as('secretary').patch(`/api/resolutions/${r.body.id}/executors/${e.id}/progress`, { progress: 100, note: 'انجام شد' });
    }
    expect((await as('secretary').get(`/api/resolutions/${r.body.id}`)).body.status).toBe('done');
    // An unfinished archived resolution with a past deadline sends no reminder.
    const open = await as('secretary').post('/api/resolutions', { commissionId: exp, meetingId, text: 'مصوبه دیگر جلسه سوابق', dueDate: '2025-06-01' });
    await runScheduledJobs();
    const n = await pool.query(`SELECT 1 FROM notifications WHERE data->>'resolutionId' = $1`, [open.body.id]);
    expect(n.rowCount).toBe(0);
    expect((await pool.query('SELECT overdue_notified_at FROM resolutions WHERE id = $1', [open.body.id])).rows[0].overdue_notified_at).toBeNull();
  });

  it('finalizes as approved on paper, with the attendance as recorded', async () => {
    const pdf = Buffer.from('%PDF-1.4\n%%EOF\n');
    const up = await request(app).post('/api/documents').set('authorization', `Bearer ${tokens.secretary}`).field('meetingId', meetingId).field('kind', 'minutes_scan').attach('file', pdf, { filename: 'صورتجلسه امضاشده.pdf' });
    expect(up.body.kind).toBe('minutes_scan');
    const c = (await as('secretary').get(`/api/meetings/${meetingId}/archival/checklist`)).body;
    expect(c).toMatchObject({ invitees: 11, attendance_unset: 1, agenda: 1, resolutions: 2, signed_scans: 1, open: true });
    expect((await as('secretary').post(`/api/minutes/${(await pool.query('SELECT id FROM minutes WHERE meeting_id = $1', [meetingId])).rows[0].id}/submit`)).status).toBe(409);
    const f = await as('secretary').post(`/api/meetings/${meetingId}/archival/finalize`, { regenerate: true });
    expect(f.status).toBe(200);
    expect(f.body.markedAbsent).toBe(1);
    const m = (await as('secretary').get(`/api/meetings/${meetingId}`)).body;
    expect(m.status).toBe('approved');
    const minutes = (await as('secretary').get(`/api/meetings/${meetingId}/minutes`)).body;
    expect(minutes.status).toBe('approved');
    const [present, absent] = minutes.body.split('**غایبین:**');
    expect(present).toContain('زهرا محمدی');
    expect(absent).toContain('رضا حسینی');
    expect(absent).toContain('غیبت موجه');
    expect(minutes.body).toContain('ساعت شروع: ۰۹:۰۰');
    expect(minutes.body).toContain('موافق: ۶');
    expect(minutes.body).toContain('ثبت از سوابق');
    // Locked like any approved meeting.
    expect((await as('secretary').patch(`/api/meetings/${meetingId}`, { title: 'تغییر پس از نهایی‌سازی' })).status).toBe(409);
    expect((await as('secretary').post(`/api/meetings/${meetingId}/agenda`, { title: 'آیتم دیر' })).status).toBe(409);
  });
});

describe('regular meetings after they end', () => {
  it('accept new invitees until the minutes are sent, without an invitation', async () => {
    const r = await as('secretary').post('/api/meetings', { commissionId: exp, title: 'جلسه عادی', scheduledAt: new Date(Date.now() + 3600e3).toISOString(), schedule: true });
    await as('secretary').post(`/api/meetings/${r.body.id}/start`);
    await as('secretary').post(`/api/meetings/${r.body.id}/end`);
    const before = await notifications();
    expect((await as('secretary').post(`/api/meetings/${r.body.id}/invitees`, { userId: ids['guest@kx.local'], role: 'guest' })).status).toBe(204);
    expect(await notifications()).toBe(before);
    const m = (await as('secretary').get(`/api/meetings/${r.body.id}`)).body;
    expect(m.invitees.some((i: any) => i.user_id === ids['guest@kx.local'])).toBe(true);
  });
});
