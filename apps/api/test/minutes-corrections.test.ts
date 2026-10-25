import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { migrate } from '../src/db/migrate.js';
import { pool } from '../src/db/pool.js';
import { seed, SEED_PASSWORD } from '../src/db/seed.js';

/** Corrections after a meeting: attendance carried into the minutes draft, withdrawing, and reopening approved minutes. */
const app = createApp();
const tokens: Record<string, string> = {};
const ids: Record<string, string> = {};
let meetingId: string;
let minutesId: string;

const as = (who: string) => ({
  get: (url: string) => request(app).get(url).set('authorization', `Bearer ${tokens[who]}`),
  post: (url: string, b: object = {}) => request(app).post(url).set('authorization', `Bearer ${tokens[who]}`).send(b),
  del: (url: string) => request(app).delete(url).set('authorization', `Bearer ${tokens[who]}`),
});
const minutes = async () => (await as('secretary').get(`/api/meetings/${meetingId}/minutes`)).body;
const absentSection = (body: string) => body.slice(body.indexOf('**غایبین:**'), body.indexOf('**وضعیت حد نصاب:**'));

beforeAll(async () => {
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await migrate(false);
  await seed();
  for (const [who, email] of [['secretary', 'secretary@kx.local'], ['chair', 'chair@kx.local'], ['admin', 'admin@kx.local'], ['m1', 'member1@kx.local'], ['isf', 'admin.isf@kx.local']]) {
    tokens[who] = (await request(app).post('/api/auth/login').send({ identifier: email, password: SEED_PASSWORD })).body.accessToken;
  }
  for (const email of ['member1@kx.local', 'guest@kx.local']) ids[email] = (await pool.query('SELECT id FROM users WHERE email = $1', [email])).rows[0].id;
  meetingId = (await pool.query(`SELECT id FROM meetings WHERE status = 'invitation_sent' ORDER BY scheduled_at LIMIT 1`)).rows[0].id;
  await pool.query(`UPDATE attendance SET status = 'present', checked_in_at = now() WHERE meeting_id = $1`, [meetingId]);
  expect((await as('chair').post(`/api/meetings/${meetingId}/start`)).status).toBe(200);
  expect((await as('chair').post(`/api/meetings/${meetingId}/end`)).status).toBe(200);
  minutesId = (await minutes()).id;
});

describe('minutes corrections', () => {
  it('carries an attendance correction into the draft without losing the secretary edits', async () => {
    const m = await minutes();
    expect(m.attendanceSynced).toBe(true);
    const edited = `${m.body}\n\nیادداشت دبیر: جلسه با تلاوت قرآن آغاز شد.`;
    expect((await as('secretary').post(`/api/meetings/${meetingId}/minutes`, { body: edited })).status).toBe(200);
    const r = await as('secretary').post(`/api/meetings/${meetingId}/attendance/${ids['member1@kx.local']}/confirm`, { status: 'absent', reason: 'اشتباه در ثبت حضور' });
    expect(r.body.minutes).toBe('synced');
    const after = await minutes();
    const name = (await pool.query('SELECT full_name FROM users WHERE id = $1', [ids['member1@kx.local']])).rows[0].full_name;
    expect(absentSection(after.body)).toContain(name);
    expect(after.body).toContain('یادداشت دبیر: جلسه با تلاوت قرآن آغاز شد.');
    expect(after.version).toBe(m.version + 2);
    expect(after.attendanceSynced).toBe(true);
  });

  it('removes a guest listed by mistake after the meeting, and from the minutes', async () => {
    const guest = (await pool.query('SELECT full_name FROM users WHERE id = $1', [ids['guest@kx.local']])).rows[0].full_name;
    expect((await minutes()).body).toContain(guest);
    expect((await as('secretary').del(`/api/meetings/${meetingId}/invitees/${ids['guest@kx.local']}`)).status).toBe(204);
    expect((await minutes()).body).not.toContain(guest);
  });

  it('warns before submitting minutes whose attendance differs from the record', async () => {
    await pool.query(`UPDATE attendance SET status = 'excused' WHERE meeting_id = $1 AND user_id = $2`, [meetingId, ids['member1@kx.local']]);
    expect((await minutes()).attendanceSynced).toBe(false);
    const blocked = await as('secretary').post(`/api/minutes/${minutesId}/submit`);
    expect(blocked.status).toBe(409);
    expect(blocked.body.error.code).toBe('attendance_mismatch');
    expect((await as('secretary').post(`/api/meetings/${meetingId}/minutes/sync-attendance`)).body.result).toBe('synced');
    expect(absentSection((await minutes()).body)).toContain('غیبت موجه');
    expect((await as('secretary').post(`/api/minutes/${minutesId}/submit`)).status).toBe(204);
  });

  it('lets the secretary take submitted minutes back before the chair decides', async () => {
    expect((await as('m1').post(`/api/minutes/${minutesId}/withdraw`)).status).toBe(403);
    expect((await as('secretary').post(`/api/minutes/${minutesId}/withdraw`)).status).toBe(204);
    expect((await as('chair').post(`/api/minutes/${minutesId}/approve`)).status).toBe(409);
    expect((await minutes()).status).toBe('draft');
    expect((await as('secretary').post(`/api/minutes/${minutesId}/submit`)).status).toBe(204);
    const ap = await as('chair').post(`/api/minutes/${minutesId}/approve`);
    expect(ap.status).toBe(200);
    ids.number = ap.body.minutes_number;
    expect((await as('secretary').post(`/api/minutes/${minutesId}/withdraw`)).status).toBe(409);
  });

  it('reopens approved minutes only by the chamber admin with a reason, keeping the history', async () => {
    const approved = await minutes();
    expect(approved.canReopen).toBe(false);
    expect((await as('admin').get(`/api/meetings/${meetingId}/minutes`)).body.canReopen).toBe(true);
    expect((await as('secretary').post(`/api/minutes/${minutesId}/reopen`, { reason: 'نام یکی از اعضا اشتباه است' })).status).toBe(403);
    expect((await as('chair').post(`/api/minutes/${minutesId}/reopen`, { reason: 'نام یکی از اعضا اشتباه است' })).status).toBe(403);
    expect((await as('isf').post(`/api/minutes/${minutesId}/reopen`, { reason: 'نام یکی از اعضا اشتباه است' })).status).toBe(404);
    expect((await as('admin').post(`/api/minutes/${minutesId}/reopen`, {})).status).toBe(400);
    expect((await as('admin').post(`/api/minutes/${minutesId}/reopen`, { reason: 'نام یکی از اعضا اشتباه است' })).status).toBe(204);

    const m = await minutes();
    expect(m).toMatchObject({ status: 'draft', reopen_reason: 'نام یکی از اعضا اشتباه است', body: approved.body });
    expect(m.versions.some((v: any) => v.version === approved.version)).toBe(true);
    expect((await as('admin').get(`/api/meetings/${meetingId}/minutes`)).status).toBe(200);
    expect((await as('m1').get(`/api/meetings/${meetingId}/minutes`)).status).toBe(404);
    const meeting = (await as('secretary').get(`/api/meetings/${meetingId}`)).body;
    expect(meeting.status).toBe('minutes_draft');
    const notes = (await as('m1').get('/api/notifications?pageSize=50')).body.items;
    expect(notes.some((n: any) => n.event === 'minutes.reopened' && n.data.meetingId === meetingId)).toBe(true);
    const log = await pool.query(`SELECT reason, before FROM audit_logs WHERE action = 'minutes.reopened' AND entity_id = $1`, [minutesId]);
    expect(log.rows[0]).toMatchObject({ reason: 'نام یکی از اعضا اشتباه است', before: { number: ids.number } });

    // Corrected, then approved again under the same number.
    expect((await as('secretary').post(`/api/meetings/${meetingId}/minutes`, { body: `${m.body}\n\nاصلاحیه: نام عضو اصلاح شد.` })).status).toBe(200);
    expect((await as('secretary').post(`/api/minutes/${minutesId}/submit`)).status).toBe(204);
    const ap = await as('chair').post(`/api/minutes/${minutesId}/approve`);
    expect(ap.body).toMatchObject({ status: 'approved', minutes_number: ids.number });
    await expect(pool.query(`UPDATE minutes SET body = 'x' WHERE id = $1`, [minutesId])).rejects.toThrow(/locked/);
    await expect(pool.query(`UPDATE minutes SET status = 'draft' WHERE id = $1`, [minutesId])).rejects.toThrow(/locked/);
  });
});
