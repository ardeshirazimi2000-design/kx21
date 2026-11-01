import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { migrate } from '../src/db/migrate.js';
import { pool } from '../src/db/pool.js';
import { seed, SEED_PASSWORD } from '../src/db/seed.js';

/** Separation of duties (AFTA): IT administration, security audit, national secretariat and chamber processes. */
const app = createApp();
const tokens: Record<string, string> = {};
const ids: Record<string, string> = {};
let yazd: string;
let meetingId: string;

const as = (who: string) => ({
  get: (url: string) => request(app).get(url).set('authorization', `Bearer ${tokens[who]}`),
  post: (url: string, b: object = {}) => request(app).post(url).set('authorization', `Bearer ${tokens[who]}`).send(b),
  patch: (url: string, b: object = {}) => request(app).patch(url).set('authorization', `Bearer ${tokens[who]}`).send(b),
  put: (url: string, b: object = {}) => request(app).put(url).set('authorization', `Bearer ${tokens[who]}`).send(b),
  del: (url: string, b: object = {}) => request(app).delete(url).set('authorization', `Bearer ${tokens[who]}`).send(b),
});
const login = async (who: string, email: string) => {
  const r = await request(app).post('/api/auth/login').send({ identifier: email, password: SEED_PASSWORD });
  expect(r.status).toBe(200);
  tokens[who] = r.body.accessToken;
};

beforeAll(async () => {
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await migrate(false);
  await seed();
  for (const [who, email] of [['root', 'root@kx.local'], ['admin', 'admin@kx.local'], ['auditor', 'auditor@kx.local'], ['vice', 'vice@kx.local'], ['m1', 'member1@kx.local']]) {
    await login(who, email);
    ids[who] = (await pool.query('SELECT id, chamber_id FROM users WHERE email = $1', [email])).rows[0].id;
  }
  yazd = (await pool.query(`SELECT chamber_id FROM users WHERE email = 'admin@kx.local'`)).rows[0].chamber_id;
  meetingId = (await pool.query(`SELECT id FROM meetings WHERE chamber_id = $1 LIMIT 1`, [yazd])).rows[0].id;
});

describe('separation of duties', () => {
  it('lists who holds which administrative role, with what still combines duties', async () => {
    const r = await as('root').get('/api/staff-roles');
    expect(r.status).toBe(200);
    const roles = (email: string) => r.body.items.filter((x: any) => x.email === email).map((x: any) => x.role).sort();
    expect(roles('root@kx.local')).toEqual(['chamber_admin', 'national', 'system_it']);
    expect(roles('admin@kx.local')).toEqual(['chamber_admin', 'it_admin']);
    expect(roles('auditor@kx.local')).toEqual(['auditor']);
    expect(r.body.warnings.join(' ')).toContain('مدیر سامانه هم مدیر فناوری اطلاعات سامانه است');
    expect(r.body.warnings.join(' ')).toContain('هم مدیر اتاق است و هم مدیر فناوری اطلاعات اتاق');
    for (const who of ['admin', 'auditor', 'm1']) expect((await as(who).get('/api/staff-roles')).status).toBe(403);
  });

  it('never makes an auditor an administrator, or an administrator an auditor', async () => {
    const asAuditor = await as('root').post('/api/staff-roles', { userId: ids.admin, role: 'auditor' });
    expect(asAuditor.status).toBe(409);
    expect(asAuditor.body.error.code).toBe('separation_of_duties');
    for (const b of [
      { userId: ids.auditor, role: 'system_it' },
      { userId: ids.auditor, role: 'chamber_admin', chamberId: yazd },
    ]) {
      expect((await as('root').post('/api/staff-roles', b)).body.error?.code).toBe('separation_of_duties');
    }
    // Neither through the older «chamber admins» form.
    expect((await as('root').post(`/api/chambers/${yazd}/admins`, { userId: ids.auditor })).status).toBe(409);
    // Nobody changes their own roles.
    expect((await as('root').post('/api/staff-roles', { userId: ids.root, role: 'auditor' })).status).toBe(400);
    // Chamber roles need a chamber and someone of that chamber; system roles none.
    expect((await as('root').post('/api/staff-roles', { userId: ids.m1, role: 'it_admin' })).status).toBe(400);
    expect((await as('root').post('/api/staff-roles', { userId: ids.m1, role: 'national', chamberId: yazd })).status).toBe(400);
  });

  it('the auditor reads the log and the security settings, and changes nothing', async () => {
    const policy = await as('auditor').get('/api/security-policy');
    expect(policy.status).toBe(200);
    expect((await as('auditor').put('/api/security-policy', policy.body.policy)).status).toBe(403);
    expect((await as('auditor').get(`/api/audit?chamberId=${yazd}`)).status).toBe(200);
    expect((await as('auditor').get('/api/audit/verify')).body.intact).toBe(true);
    expect((await as('auditor').get(`/api/people?chamberId=${yazd}`)).status).toBe(403);
    expect((await as('auditor').get(`/api/meetings/${meetingId}`)).status).toBe(404);
    expect((await as('auditor').get('/api/commissions')).body.items).toEqual([]);
    expect((await as('auditor').post('/api/chambers', { name: 'نفوذی', province: 'x' })).status).toBe(403);
    for (const who of ['root', 'admin']) expect((await as(who).get('/api/audit')).status).toBe(403);
  });

  it('logins are the IT administrator’s; the chamber admin keeps people’s details', async () => {
    // Take the chamber admin's IT role away: details still, passwords and activation no longer.
    expect((await as('root').del('/api/staff-roles', { userId: ids.admin, role: 'it_admin', chamberId: yazd })).status).toBe(204);
    expect((await as('admin').get('/api/auth/me')).body.error.code).toBe('session_ended');
    await login('admin', 'admin@kx.local');
    expect((await as('admin').get('/api/auth/me')).body.itChambers).toEqual([]);
    expect((await as('admin').patch(`/api/people/${ids.m1}`, { organization: 'شرکت تازه' })).status).toBe(200);
    expect((await as('admin').patch(`/api/people/${ids.m1}`, { password: 'Very-Strong#Pass1' })).status).toBe(403);
    expect((await as('admin').patch(`/api/people/${ids.m1}`, { isActive: false })).status).toBe(403);
    expect((await as('admin').post('/api/people', { chamberId: yazd, fullName: 'با رمز', mobile: '09199999999', password: 'Very-Strong#Pass1' })).status).toBe(403);
    expect((await as('admin').get(`/api/roles?chamberId=${yazd}`)).status).toBe(200);
    expect((await as('admin').post('/api/roles', { chamberId: yazd, title: 'نقش تازه', capabilities: [] })).status).toBe(403);
    expect((await as('root').patch(`/api/people/${ids.m1}`, { password: 'Very-Strong#Pass1' })).status).toBe(200);
    // The chamber admin still runs the chamber's processes.
    expect((await as('admin').get(`/api/meetings/${meetingId}`)).status).toBe(200);
  });

  it('the national secretariat sees every chamber’s commissions without acting in them', async () => {
    expect((await as('root').del('/api/staff-roles', { userId: ids.root, role: 'chamber_admin', chamberId: yazd })).status).toBe(400);
    // root holds national + chamber admin; a second IT administrator takes root's chamber role away.
    expect((await as('root').post('/api/staff-roles', { userId: ids.vice, role: 'system_it' })).status).toBe(201);
    await login('vice', 'vice@kx.local');
    expect((await as('vice').del('/api/staff-roles', { userId: ids.root, role: 'chamber_admin', chamberId: yazd })).status).toBe(204);
    await login('root', 'root@kx.local');
    const m = await as('root').get(`/api/meetings/${meetingId}`);
    expect(m.status).toBe(200);
    expect(m.body.capabilities).not.toContain('meeting.manage');
    expect((await as('root').post(`/api/meetings/${meetingId}/agenda`, { title: 'از دبیرخانهٔ ملی' })).status).toBe(403);
    expect((await as('root').get(`/api/dashboard/chamber?chamberId=${yazd}`)).status).toBe(200);
    // Without the national role, the IT administrator sees no meeting content at all.
    expect((await as('vice').del('/api/staff-roles', { userId: ids.root, role: 'national' })).status).toBe(204);
    await login('root', 'root@kx.local');
    expect((await as('root').get(`/api/meetings/${meetingId}`)).status).toBe(404);
    expect((await as('root').get(`/api/dashboard/chamber?chamberId=${yazd}`)).status).toBe(403);
    expect((await as('root').get(`/api/people?chamberId=${yazd}`)).status).toBe(200);
  });

  it('keeps one IT administrator and records every change for the auditor', async () => {
    expect((await as('vice').del('/api/staff-roles', { userId: ids.root, role: 'system_it' })).status).toBe(204);
    const last = await as('vice').del('/api/staff-roles', { userId: ids.vice, role: 'system_it' });
    expect(last.status).toBe(400); // their own
    const log = await as('auditor').get('/api/audit?action=staff.');
    expect(log.body.items.map((x: any) => x.action)).toEqual(expect.arrayContaining(['staff.role_granted', 'staff.role_revoked']));
    expect(log.body.items.find((x: any) => x.action === 'staff.role_granted').after).toMatchObject({ role: 'system_it', label: 'مدیر فناوری اطلاعات سامانه' });
  });
});
