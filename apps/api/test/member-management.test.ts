import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { migrate } from '../src/db/migrate.js';
import { pool } from '../src/db/pool.js';
import { seed, SEED_PASSWORD } from '../src/db/seed.js';

/** The chair and secretary add the commission's members; duplicates entered by mistake can be deleted. */
const app = createApp();
const tokens: Record<string, string> = {};
let chamberId: string;
let exp: string;

const as = (who: string) => ({
  get: (url: string) => request(app).get(url).set('authorization', `Bearer ${tokens[who]}`),
  post: (url: string, b: object = {}) => request(app).post(url).set('authorization', `Bearer ${tokens[who]}`).send(b),
  patch: (url: string, b: object) => request(app).patch(url).set('authorization', `Bearer ${tokens[who]}`).send(b),
  del: (url: string) => request(app).delete(url).set('authorization', `Bearer ${tokens[who]}`),
});

beforeAll(async () => {
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await migrate(false);
  await seed();
  for (const [who, email] of [['admin', 'admin@kx.local'], ['secretary', 'secretary@kx.local'], ['chair', 'chair@kx.local'], ['m1', 'member1@kx.local']]) {
    tokens[who] = (await request(app).post('/api/auth/login').send({ identifier: email, password: SEED_PASSWORD })).body.accessToken;
  }
  const c = (await as('admin').get('/api/commissions?pageSize=50')).body.items.find((x: any) => x.code === 'EXP');
  exp = c.id;
  chamberId = c.chamber_id;
});

describe('commission officers manage members', () => {
  it('the secretary and chair add members, not officers or logins', async () => {
    const p = await as('secretary').post('/api/people', { chamberId, fullName: 'عضو جدید صادرات', mobile: '09125550001' });
    expect(p.status).toBe(201);
    const add = await as('secretary').post(`/api/commissions/${exp}/members`, { userId: p.body.id, position: 'member' });
    expect(add.status).toBe(201);
    expect(add.body.has_vote).toBe(true);
    // Officers are appointed by the chamber admin.
    const q = await as('chair').post('/api/people', { chamberId, fullName: 'نامزد نایب رئیس', mobile: '09125550002' });
    expect((await as('chair').post(`/api/commissions/${exp}/members`, { userId: q.body.id, position: 'vice_chair', replaceExisting: true })).status).toBe(403);
    expect((await as('chair').post(`/api/commissions/${exp}/members`, { userId: q.body.id, position: 'expert' })).status).toBe(201);
    // No login for a new person through the commission.
    const withPw = await as('secretary').post(`/api/commissions/${exp}/members`, { person: { fullName: 'با رمز', mobile: '09125550003', password: 'Passw0rd!x' }, position: 'member' });
    expect(withPw.status).toBe(403);
    // Ordinary members cannot.
    expect((await as('m1').post(`/api/commissions/${exp}/members`, { userId: p.body.id, position: 'observer' })).status).toBe(403);
  });

  it('they change, end and delete ordinary memberships but not the officers’', async () => {
    const members = (await as('secretary').get(`/api/commissions/${exp}/members`)).body;
    const fresh = members.find((m: any) => m.full_name === 'عضو جدید صادرات');
    const changed = await as('secretary').patch(`/api/memberships/${fresh.id}`, { position: 'observer' });
    expect(changed.status).toBe(200);
    expect((await as('secretary').patch(`/api/memberships/${changed.body.id}`, { position: 'secretary' })).status).toBe(403);
    const chair = members.find((m: any) => m.position === 'chair');
    expect((await as('secretary').post(`/api/memberships/${chair.id}/end`, { reason: 'x' })).status).toBe(403);
    expect((await as('secretary').del(`/api/memberships/${changed.body.id}`)).status).toBe(204);
    // The chamber admin still manages officers.
    const vice = members.find((m: any) => m.position === 'vice_chair');
    expect((await as('admin').patch(`/api/memberships/${vice.id}`, { hasVote: true })).status).toBe(200);
  });

  it('a custom role with executive capabilities counts as an officer', async () => {
    const role = await as('admin').post('/api/roles', { chamberId, title: 'معاون دبیر', capabilities: ['meeting.manage'] });
    expect(role.status).toBe(201);
    const p = await as('secretary').post('/api/people', { chamberId, fullName: 'معاون احتمالی', mobile: '09125550004' });
    expect((await as('secretary').post(`/api/commissions/${exp}/members`, { userId: p.body.id, position: role.body.key })).status).toBe(403);
  });
});

describe('deleting a person registered by mistake', () => {
  it('deletes an unverified person without history, with memberships and pending invitations', async () => {
    const dup = await as('admin').post('/api/people', { chamberId, fullName: 'شخص تکراری', mobile: '09125550010' });
    await as('admin').post(`/api/commissions/${exp}/members`, { userId: dup.body.id, position: 'member' });
    expect((await as('secretary').del(`/api/people/${dup.body.id}`)).status).toBe(404);
    expect((await as('admin').del(`/api/people/${dup.body.id}`)).status).toBe(204);
    expect((await pool.query('SELECT 1 FROM users WHERE id = $1', [dup.body.id])).rowCount).toBe(0);
    expect((await pool.query('SELECT 1 FROM commission_memberships WHERE user_id = $1', [dup.body.id])).rowCount).toBe(0);
    const log = await pool.query(`SELECT 1 FROM audit_logs WHERE action = 'person.deleted' AND entity_id = $1`, [dup.body.id]);
    expect(log.rowCount).toBe(1);
  });

  it('keeps verified people, people with history and chamber admins', async () => {
    const verified = await as('admin').post('/api/people', { chamberId, fullName: 'استعلام‌شده', mobile: '09125550011' });
    await pool.query('UPDATE users SET identity_verified_at = now() WHERE id = $1', [verified.body.id]);
    expect((await as('admin').del(`/api/people/${verified.body.id}`)).status).toBe(409);

    const withHistory = (await pool.query(`SELECT id FROM users WHERE email = 'member1@kx.local'`)).rows[0].id;
    const r = await as('admin').del(`/api/people/${withHistory}`);
    expect(r.status).toBe(409);
    expect(r.body.error?.code ?? r.body.code).toBe('person_has_history');

    const adminId = (await pool.query(`SELECT id FROM users WHERE email = 'admin@kx.local'`)).rows[0].id;
    expect((await as('admin').del(`/api/people/${adminId}`)).status).toBe(400);
  });
});
