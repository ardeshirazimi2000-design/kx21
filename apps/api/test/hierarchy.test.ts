import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { migrate } from '../src/db/migrate.js';
import { pool } from '../src/db/pool.js';
import { seed, SEED_PASSWORD } from '../src/db/seed.js';

/**
 * Organisational hierarchy: the Super Admin (اتاق ایران) defines provincial chambers and their admins;
 * a chamber admin defines terms and commissions of their own chamber only; secretaries and members see
 * only the commissions they belong to.
 */
const app = createApp();
const tokens: Record<string, string> = {};
const PW = 'Sanandaj-Admin-1405';

const as = (who: string) => ({
  get: (url: string) => request(app).get(url).set('authorization', `Bearer ${tokens[who]}`),
  post: (url: string, body: object = {}) => request(app).post(url).set('authorization', `Bearer ${tokens[who]}`).send(body),
});

async function login(who: string, identifier: string, password = SEED_PASSWORD) {
  const r = await request(app).post('/api/auth/login').send({ identifier, password });
  expect(r.status).toBe(200);
  tokens[who] = r.body.accessToken;
}

const names = (r: request.Response) => (r.body.items ?? r.body).map((x: any) => x.name ?? x.title).sort();

let yazd: string;
let sdj: string;
let sdjTerm: string;
let kb: string;

beforeAll(async () => {
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await migrate(false);
  await seed();
  await login('root', 'root@kx.local');
  await login('yazdAdmin', 'admin@kx.local');
  await login('yazdSecretary', 'secretary@kx.local');
  await login('yazdMember', 'member1@kx.local');
  yazd = (await pool.query(`SELECT chamber_id FROM users WHERE email = 'admin@kx.local'`)).rows[0].chamber_id;
});

describe('chamber → term → commission hierarchy', () => {
  it('only the Super Admin defines chambers and their admins', async () => {
    const denied = await as('yazdAdmin').post('/api/chambers', { name: 'اتاق بازرگانی سنندج', province: 'کردستان' });
    expect(denied.status).toBe(403);
    const c = await as('root').post('/api/chambers', { name: 'اتاق بازرگانی سنندج', province: 'کردستان' });
    expect(c.status).toBe(201);
    sdj = c.body.id;
    const a = await as('root').post(`/api/chambers/${sdj}/admins`, {
      person: { fullName: 'مدیر اتاق سنندج', email: 'sdj-admin@kx.local', mobile: '09181111111', password: PW },
    });
    expect(a.status).toBe(201);
    await login('sdjAdmin', 'sdj-admin@kx.local', PW);
  });

  it('a chamber admin sees only their own chamber', async () => {
    const r = await as('sdjAdmin').get('/api/chambers');
    expect(r.body.map((c: any) => c.id)).toEqual([sdj]);
    expect((await as('sdjAdmin').get(`/api/terms?chamberId=${yazd}`)).status).toBe(404);
  });

  it('a chamber admin defines terms and commissions only in their own chamber', async () => {
    const t = await as('sdjAdmin').post('/api/terms', { chamberId: sdj, number: 10, title: 'دوره دهم', startDate: '2023-04-21', status: 'active' });
    expect(t.status).toBe(201);
    sdjTerm = t.body.id;
    expect((await as('yazdAdmin').post('/api/terms', { chamberId: sdj, number: 11, title: 'دوره یازدهم', startDate: '2027-04-21' })).status).toBe(403);

    const k = await as('sdjAdmin').post('/api/commissions', { chamberId: sdj, termId: sdjTerm, name: 'کمیسیون کسب و کارهای دانش بنیان', code: 'KBBC' });
    expect(k.status).toBe(201);
    kb = k.body.id;
    expect((await as('yazdAdmin').post('/api/commissions', { chamberId: sdj, termId: sdjTerm, name: 'نفوذی', code: 'X' })).status).toBe(403);
    const yazdTerm = (await pool.query(`SELECT id FROM terms WHERE chamber_id = $1`, [yazd])).rows[0].id;
    // A term of another chamber cannot be used, even by the Super Admin.
    expect((await as('root').post('/api/commissions', { chamberId: sdj, termId: yazdTerm, name: 'اشتباه', code: 'Y' })).status).toBe(400);
  });

  it('chamber admins see only their chamber’s commissions; the Super Admin sees all', async () => {
    const sdjList = names(await as('sdjAdmin').get('/api/commissions'));
    expect(sdjList).toEqual(['کمیسیون کسب و کارهای دانش بنیان']);
    const yazdList = names(await as('yazdAdmin').get('/api/commissions'));
    expect(yazdList).not.toContain('کمیسیون کسب و کارهای دانش بنیان');
    expect(yazdList.length).toBeGreaterThan(0);
    const all = (await as('root').get('/api/commissions?pageSize=100')).body.items;
    expect(all.find((c: any) => c.id === kb)?.chamber_name).toBe('اتاق بازرگانی سنندج');
    expect((await as('yazdAdmin').get(`/api/commissions/${kb}`)).status).toBe(404);
  });

  it('the secretary and members see only their own commission', async () => {
    const person = await as('sdjAdmin').post('/api/people', { chamberId: sdj, fullName: 'دبیر دانش بنیان', email: 'kb-sec@kx.local', mobile: '09182222222', password: PW });
    expect(person.status).toBe(201);
    const member = await as('sdjAdmin').post('/api/people', { chamberId: sdj, fullName: 'عضو دانش بنیان', email: 'kb-m@kx.local', mobile: '09183333333', password: PW });
    for (const [id, position] of [
      [person.body.id, 'secretary'],
      [member.body.id, 'member'],
    ]) {
      const r = await as('sdjAdmin').post(`/api/commissions/${kb}/members`, { userId: id, position, startDate: '2023-04-21' });
      expect(r.status).toBe(201);
    }
    // A second commission in the same chamber that these people are not part of.
    const other = await as('sdjAdmin').post('/api/commissions', { chamberId: sdj, termId: sdjTerm, name: 'کمیسیون معدن', code: 'MIN' });
    await login('kbSec', 'kb-sec@kx.local', PW);
    await login('kbMember', 'kb-m@kx.local', PW);

    for (const who of ['kbSec', 'kbMember']) {
      expect(names(await as(who).get('/api/commissions'))).toEqual(['کمیسیون کسب و کارهای دانش بنیان']);
      expect((await as(who).get(`/api/commissions/${kb}`)).status).toBe(200);
      expect((await as(who).get(`/api/commissions/${other.body.id}`)).status).toBe(404);
    }
    // Yazd's secretary and members do not see the Sanandaj commission either.
    for (const who of ['yazdSecretary', 'yazdMember']) {
      expect(names(await as(who).get('/api/commissions'))).not.toContain('کمیسیون کسب و کارهای دانش بنیان');
      expect((await as(who).get(`/api/commissions/${kb}`)).status).toBe(404);
    }
  });

  it('meetings of a commission are visible only to its members and admins', async () => {
    // Meetings are run by the commission's secretary.
    const m = await as('kbSec').post('/api/meetings', { commissionId: kb, title: 'جلسه اول دانش بنیان', scheduledAt: '2026-11-01T06:30:00Z', type: 'in_person' });
    expect(m.status).toBe(201);
    const titles = async (who: string) => (await as(who).get('/api/meetings?pageSize=100')).body.items.map((x: any) => x.title);
    expect(await titles('kbSec')).toContain('جلسه اول دانش بنیان');
    expect(await titles('yazdSecretary')).not.toContain('جلسه اول دانش بنیان');
    expect(await titles('yazdAdmin')).not.toContain('جلسه اول دانش بنیان');
    expect((await as('yazdSecretary').get(`/api/meetings/${m.body.id}`)).status).toBe(404);
  });
});
