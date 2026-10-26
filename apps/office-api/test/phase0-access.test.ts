// Regression tests for the production readiness review, phase 0: R1 (confidentiality on every path) and R2 (no escalation).
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { pool } from '../src/db/pool.js';
import { seed, SEED_PASSWORD } from '../src/db/seed.js';

const app = createApp();
const tokens: Record<string, string> = {};
const me: Record<string, any> = {};

const as = (who: string) => ({
  get: (url: string) => request(app).get(url).set('authorization', `Bearer ${tokens[who]}`),
  post: (url: string, body: object = {}) => request(app).post(url).set('authorization', `Bearer ${tokens[who]}`).send(body),
  patch: (url: string, body: object = {}) => request(app).patch(url).set('authorization', `Bearer ${tokens[who]}`).send(body),
  upload: (url: string, file: Buffer, name: string) => request(app).post(url).set('authorization', `Bearer ${tokens[who]}`).attach('file', file, name),
});

async function login(who: string, password = SEED_PASSWORD) {
  const r = await request(app).post('/api/auth/login').send({ identifier: who, password });
  expect(r.status, `login ${who}`).toBe(200);
  tokens[who] = r.body.accessToken;
  me[who] = (await as(who).get('/api/auth/me')).body;
}

const PDF = Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF');

beforeAll(async () => {
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await seed();
  for (const u of ['admin', 'president', 'deputy', 'clerk', 'cmsexpert', 'reshead', 'expert', 'it']) await login(u);
});

afterAll(async () => {
  await pool.end();
});

describe('R1: confidentiality is enforced on every path', () => {
  let secret: any;
  let att: any;

  it('a secret letter cannot be referred to a user without clearance (P1)', async () => {
    expect(me.expert.clearance).toBe(0);
    secret = (await as('president').post('/api/letters', { kind: 'internal', subject: 'طرح سری بودجه', body: 'متن کاملاً سری', confidentiality: 2 })).body;
    att = (await as('president').upload(`/api/letters/${secret.id}/attachments`, PDF, 'secret.pdf')).body;
    const r = await as('president').post(`/api/letters/${secret.id}/routes`, { targets: [{ userId: me.expert.id, action: 'info' }] });
    expect(r.status).toBe(400);
    expect(r.body.error.message).toContain('کارشناس اقتصادی');
    expect((await pool.query('SELECT count(*)::int AS n FROM letter_routing WHERE letter_id = $1', [secret.id])).rows[0].n).toBe(0);
    // A position is refused when any of its current holders lacks the clearance (admin 2 and it 0 share the IT position).
    const itPosition = me.it.positions[0].positionId;
    expect((await as('president').post(`/api/letters/${secret.id}/routes`, { targets: [{ positionId: itPosition, action: 'info' }] })).status).toBe(400);
    // A cleared user is still accepted.
    expect((await as('president').post(`/api/letters/${secret.id}/routes`, { targets: [{ userId: me.admin.id, action: 'info' }] })).status).toBe(201);
  });

  it('a referral that already exists (made before the fix) gives no access (P1)', async () => {
    await pool.query(`INSERT INTO letter_routing (letter_id, from_user_id, to_user_id, action) VALUES ($1,$2,$3,'info')`, [secret.id, me.president.id, me.expert.id]);
    expect((await as('expert').get(`/api/letters/${secret.id}`)).status).toBe(404);
    expect((await as('expert').get(`/api/letters/${secret.id}/attachments/${att.id}/download`)).status).toBe(404);
    expect((await as('expert').get(`/api/letters/${secret.id}/barcode.svg`)).status).toBe(404);
    expect((await as('expert').post(`/api/letters/${secret.id}/routes`, { targets: [{ userId: me.it.id, action: 'info' }] })).status).toBe(404);
    const cartable = (await as('expert').get('/api/cartable')).body;
    expect(cartable.some((x: any) => x.letter_id === secret.id)).toBe(false);
    const list = (await as('expert').get('/api/letters?box=all')).body;
    expect(list.items.some((x: any) => x.id === secret.id)).toBe(false);
  });

  it('a creator whose clearance was lowered no longer sees their secret letter', async () => {
    const l = (await as('deputy').post('/api/letters', { kind: 'internal', subject: 'محرمانه معاون', body: 'x', confidentiality: 1 })).body;
    expect((await as('deputy').get(`/api/letters/${l.id}`)).status).toBe(200);
    await pool.query('UPDATE users SET clearance = 0 WHERE id = $1', [me.deputy.id]);
    expect((await as('deputy').get(`/api/letters/${l.id}`)).status).toBe(404);
    await pool.query('UPDATE users SET clearance = 1 WHERE id = $1', [me.deputy.id]);
  });

  it('internal recipients without clearance are refused, also when the level is raised later (P2)', async () => {
    const body = { kind: 'internal', subject: 'سری دوم', body: 'x', confidentiality: 2, recipients: [{ userId: me.cmsexpert.id, kind: 'to' }], register: true };
    expect((await as('president').post('/api/letters', body)).status).toBe(400);
    const units = (await as('admin').get('/api/org/units')).body.units;
    const research = units.find((u: any) => u.code !== 'PRS' && u.name.includes('پژوهش'));
    expect((await as('president').post('/api/letters', { ...body, recipients: [{ unitId: research.id, kind: 'to' }] })).status).toBe(400);
    const plain = (await as('president').post('/api/letters', { ...body, confidentiality: 0 })).body;
    expect((await as('cmsexpert').get(`/api/letters/${plain.id}`)).status).toBe(200);
    // Raising the confidentiality of a draft with uncleared recipients is refused too.
    const draft = (await as('president').post('/api/letters', { ...body, confidentiality: 0, register: false })).body;
    expect((await as('president').patch(`/api/letters/${draft.id}`, { confidentiality: 2 })).status).toBe(400);
    // An internal recipient row that predates the fix gives no access.
    const old = (await as('president').post('/api/letters', { kind: 'internal', subject: 'سری قدیمی', body: 'x', confidentiality: 2, register: true })).body;
    await pool.query(`INSERT INTO letter_recipients (letter_id, user_id, kind) VALUES ($1,$2,'to')`, [old.id, me.cmsexpert.id]);
    expect((await as('cmsexpert').get(`/api/letters/${old.id}`)).status).toBe(404);
  });

  it('the designated signatory needs the clearance of the letter', async () => {
    await pool.query('UPDATE users SET clearance = 0 WHERE id = $1', [me.reshead.id]);
    const r = await as('president').post('/api/letters', { kind: 'internal', subject: 'سری با امضاکننده', body: 'x', confidentiality: 1, signatoryId: me.reshead.id });
    expect(r.status).toBe(400);
    expect((await as('president').post('/api/letters', { kind: 'internal', subject: 'سری با امضاکننده', body: 'x', confidentiality: 1, signatoryId: me.deputy.id })).status).toBe(201);
  });

  it('no notification about a secret letter reaches a user without clearance', async () => {
    const before = (await pool.query('SELECT count(*)::int AS n FROM notifications WHERE user_id = $1', [me.expert.id])).rows[0].n;
    const { notify } = await import('../src/services/notifications.js');
    await notify({ userIds: [me.expert.id, me.admin.id], event: 'letter.received', vars: { subject: secret.subject, number: '1' }, data: { letterId: secret.id } });
    const n = (await pool.query(`SELECT user_id, title FROM notifications WHERE title LIKE '%طرح سری بودجه%'`)).rows;
    expect(n.some((x) => x.user_id === me.expert.id)).toBe(false);
    expect(n.some((x) => x.user_id === me.admin.id)).toBe(true);
    expect((await pool.query('SELECT count(*)::int AS n FROM notifications WHERE user_id = $1', [me.expert.id])).rows[0].n).toBe(before);
  });

  it('the audit log does not show the text of a letter above the viewer clearance (P3)', async () => {
    expect(me.it.permissions).toContain('audit.view');
    const a = await as('it').get(`/api/audit?entity=letter&entityId=${secret.id}`);
    expect(a.status).toBe(200);
    expect(a.body.items.length).toBeGreaterThan(0);
    expect(JSON.stringify(a.body.items)).not.toContain('متن کاملاً سری');
    expect(JSON.stringify(a.body.items)).not.toContain('طرح سری بودجه');
    expect(a.body.items.every((x: any) => x.redacted)).toBe(true);
    const full = await as('admin').get(`/api/audit?entity=letter&entityId=${secret.id}`);
    expect(JSON.stringify(full.body.items)).toContain('متن کاملاً سری');
  });

  it('meeting details do not show the subject of a letter above the viewer clearance (P5)', async () => {
    const mid = '11111111-1111-4111-8111-111111111111';
    await pool.query(`INSERT INTO meetings_cache (external_id, title, status) VALUES ($1,'جلسه','scheduled')`, [mid]);
    await pool.query(
      `INSERT INTO letter_meeting_refs (letter_id, commission_id, requested_meeting_id, external_issue_id, status) VALUES ($1,$2,$3,gen_random_uuid(),'proposed')`,
      [secret.id, mid, mid],
    );
    const m = await as('cmsexpert').get(`/api/meetings/${mid}`);
    expect(m.status).toBe(200);
    expect(m.body.referrals).toHaveLength(1);
    expect(m.body.referrals[0].subject).toBeNull();
    expect(JSON.stringify(m.body)).not.toContain('طرح سری بودجه');
    expect((await as('president').get(`/api/meetings/${mid}`)).body.referrals[0].subject).toBe('طرح سری بودجه');
  });
});

describe('R2: user management cannot escalate privileges', () => {
  let hr: any;
  let adminRole: any;

  beforeAll(async () => {
    const roles = (await as('admin').get('/api/roles')).body.roles;
    adminRole = roles.find((r: any) => r.key === 'admin');
    hr = (await as('admin').post('/api/roles', { key: 'hr', name: 'منابع انسانی', permissions: ['users.manage'] })).body;
    expect((await as('admin').patch(`/api/users/${me.it.id}`, { roles: [{ roleId: hr.id }] })).status).toBe(200);
    await login('it');
    expect(me.it.permissions).toEqual(['users.manage']);
  });

  it('users.manage cannot grant itself the admin role or a higher clearance (P7)', async () => {
    expect((await as('it').patch(`/api/users/${me.it.id}`, { roles: [{ roleId: hr.id }, { roleId: adminRole.id }] })).status).toBe(403);
    expect((await as('it').patch(`/api/users/${me.it.id}`, { clearance: 2 })).status).toBe(403);
    await login('it');
    expect(me.it.permissions).not.toContain('roles.manage');
    expect(me.it.clearance).toBe(0);
  });

  it('users.manage cannot hand out roles or clearance it does not hold', async () => {
    expect((await as('it').patch(`/api/users/${me.expert.id}`, { roles: [{ roleId: adminRole.id }] })).status).toBe(403);
    expect((await as('it').patch(`/api/users/${me.expert.id}`, { clearance: 1 })).status).toBe(403);
    const fresh = { username: 'hr.made', fullName: 'کاربر جدید منابع انسانی', password: 'Strong-Pass-2026!' };
    expect((await as('it').post('/api/users', { ...fresh, roles: [{ roleId: adminRole.id }] })).status).toBe(403);
    expect((await as('it').post('/api/users', { ...fresh, clearance: 2 })).status).toBe(403);
    expect((await pool.query(`SELECT 1 FROM users WHERE username = 'hr.made'`)).rowCount).toBe(0);
    // What it does hold, it may give.
    expect((await as('it').post('/api/users', { ...fresh, roles: [{ roleId: hr.id }] })).status).toBe(201);
  });

  it('users.manage cannot take over or disable a user who outranks it', async () => {
    expect((await as('it').patch(`/api/users/${me.admin.id}`, { password: 'Taken-Over-2026!' })).status).toBe(403);
    expect((await as('it').patch(`/api/users/${me.admin.id}`, { isActive: false })).status).toBe(403);
    expect((await as('it').patch(`/api/users/${me.president.id}`, { roles: [] })).status).toBe(403);
    expect((await request(app).post('/api/auth/login').send({ identifier: 'admin', password: 'Taken-Over-2026!' })).status).toBe(401);
    await login('admin');
    expect(me.admin.permissions).toContain('roles.manage');
  });

  it('users.manage cannot change its own positions', async () => {
    const units = (await as('admin').get('/api/org/units')).body;
    const head = units.positions.find((p: any) => p.is_manager);
    expect((await as('it').patch(`/api/users/${me.it.id}`, { positions: [{ positionId: head.id, isPrimary: true }] })).status).toBe(403);
  });

  it('the administrator still manages users, roles and clearances', async () => {
    expect((await as('admin').patch(`/api/users/${me.expert.id}`, { clearance: 1 })).status).toBe(200);
    expect((await as('admin').patch(`/api/users/${me.it.id}`, { roles: [{ roleId: hr.id }, { roleId: adminRole.id }] })).status).toBe(200);
    expect((await as('admin').patch(`/api/users/${me.it.id}`, { roles: [] })).status).toBe(200);
    const r = await as('admin').post('/api/users', { username: 'second.admin', fullName: 'مدیر دوم', password: 'Strong-Pass-2026!', clearance: 2, roles: [{ roleId: adminRole.id }] });
    expect(r.status).toBe(201);
  });
});
