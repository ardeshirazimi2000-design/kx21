import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { migrate } from '../src/db/migrate.js';
import { pool } from '../src/db/pool.js';
import { seed, SEED_PASSWORD } from '../src/db/seed.js';

/**
 * Thematic networks: the seed links Yazd's export commission (EXP) and Isfahan's trade commission (TRD)
 * in «شبکه ملی تجارت و صادرات» (threshold 2 chambers) and shares EXP-001.
 */
const app = createApp();
const tokens: Record<string, string> = {};

const as = (who: string) => ({
  get: (url: string) => request(app).get(url).set('authorization', `Bearer ${tokens[who]}`),
  post: (url: string, body: object = {}) => request(app).post(url).set('authorization', `Bearer ${tokens[who]}`).send(body),
  patch: (url: string, body: object = {}) => request(app).patch(url).set('authorization', `Bearer ${tokens[who]}`).send(body),
  del: (url: string) => request(app).delete(url).set('authorization', `Bearer ${tokens[who]}`),
});

async function login(who: string, identifier: string) {
  const r = await request(app).post('/api/auth/login').send({ identifier, password: SEED_PASSWORD });
  expect(r.status).toBe(200);
  tokens[who] = r.body.accessToken;
}

const events = async (who: string) => (await as(who).get('/api/notifications?pageSize=100')).body.items.map((n: any) => n.event);

let net: string;
let exp: string;
let trd: string;
let res1: string;
let res2: string;

beforeAll(async () => {
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await migrate(false);
  await seed();
  for (const [who, email] of [
    ['root', 'root@kx.local'],
    ['yazdAdmin', 'admin@kx.local'],
    ['isfAdmin', 'admin.isf@kx.local'],
    ['secretary', 'secretary@kx.local'],
    ['m1', 'member1@kx.local'],
    ['isfChair', 'chair.isf@kx.local'],
    ['guest', 'guest@kx.local'],
  ]) await login(who, email);
  const ids = (await pool.query(`SELECT id, code FROM commissions`)).rows;
  exp = ids.find((c) => c.code === 'EXP').id;
  trd = ids.find((c) => c.code === 'TRD').id;
  const rs = (await pool.query(`SELECT id, number FROM resolutions ORDER BY number`)).rows;
  res1 = rs.find((r) => r.number === 'EXP-001').id;
  res2 = rs.find((r) => r.number === 'EXP-002').id;
});

describe('commission networks', () => {
  it('lists networks only to people of member commissions, their admins and the Super Admin', async () => {
    for (const who of ['root', 'yazdAdmin', 'isfAdmin', 'secretary', 'm1', 'isfChair']) {
      const r = await as(who).get('/api/networks');
      expect(r.body.map((n: any) => n.name)).toEqual(['شبکه ملی تجارت و صادرات']);
    }
    net = (await as('root').get('/api/networks')).body[0].id;
    expect((await as('guest').get('/api/networks')).body).toEqual([]);
    expect((await as('guest').get(`/api/networks/${net}`)).status).toBe(404);
  });

  it('only the Super Admin creates networks; chamber admins join only their own commissions', async () => {
    expect((await as('yazdAdmin').post('/api/networks', { name: 'شبکه آزمایشی' })).status).toBe(403);
    const n = await as('root').post('/api/networks', { name: 'شبکه ملی انرژی', endorseThreshold: 3 });
    expect(n.status).toBe(201);
    expect((await as('yazdAdmin').post(`/api/networks/${n.body.id}/commissions`, { commissionId: trd })).status).toBe(403);
    expect((await as('isfAdmin').post(`/api/networks/${n.body.id}/commissions`, { commissionId: trd })).status).toBe(201);
    expect((await as('yazdAdmin').del(`/api/networks/${n.body.id}/commissions/${trd}`)).status).toBe(403);
    expect((await as('isfAdmin').del(`/api/networks/${n.body.id}/commissions/${trd}`)).status).toBe(204);
  });

  it('shows member commissions and who may act for which commission', async () => {
    const d = (await as('secretary').get(`/api/networks/${net}`)).body;
    expect(d.commissions.map((c: any) => c.name).sort()).toEqual(['کمیسیون تجارت اصفهان', 'کمیسیون تجارت و صادرات یزد'].sort());
    expect(d.permissions.actFor).toEqual([exp]);
    expect((await as('m1').get(`/api/networks/${net}`)).body.permissions.actFor).toEqual([]);
    expect((await as('isfChair').get(`/api/networks/${net}`)).body.permissions.actFor).toEqual([trd]);
  });

  it('shares resolutions only by officers; others see them in the network feed', async () => {
    expect((await as('m1').post(`/api/resolutions/${res2}/share`, {})).status).toBe(403);
    const s = await as('secretary').post(`/api/resolutions/${res2}/share`, { note: 'برای اطلاع' });
    expect(s.status).toBe(200);
    expect(await events('isfChair')).toContain('network.resolution_shared');
    const feed = (await as('isfChair').get(`/api/networks/${net}/resolutions`)).body;
    expect(feed.items.map((r: any) => r.number).sort()).toEqual(['EXP-001', 'EXP-002']);
    // Unsharing removes it from the feed.
    expect((await as('secretary').del(`/api/resolutions/${res2}/share`)).status).toBe(204);
    expect((await as('isfChair').get(`/api/networks/${net}/resolutions`)).body.items.map((r: any) => r.number)).toEqual(['EXP-001']);
  });

  it('endorsement by another chamber turns a shared resolution into a national proposal', async () => {
    expect((await as('m1').post(`/api/networks/${net}/resolutions/${res1}/endorsements`, { commissionId: exp })).status).toBe(403);
    expect((await as('secretary').post(`/api/networks/${net}/resolutions/${res1}/endorsements`, { commissionId: exp })).status).toBe(400);
    const e = await as('isfChair').post(`/api/networks/${net}/resolutions/${res1}/endorsements`, { commissionId: trd, comment: 'صادرکنندگان اصفهان هم همین مشکل را دارند' });
    expect(e.status).toBe(201);
    expect(e.body.nationalProposal).toBe(true);
    expect(await events('secretary')).toEqual(expect.arrayContaining(['network.endorsed', 'network.proposal_national']));
    expect(await events('root')).toContain('network.proposal_national');

    const feed = (await as('secretary').get(`/api/networks/${net}/resolutions?proposals=true`)).body;
    expect(feed.items).toHaveLength(1);
    expect(feed.items[0].chamber_support).toBe(2);
    expect(feed.items[0].endorsements[0].commission_name).toBe('کمیسیون تجارت اصفهان');
    expect(feed.items[0].proposal.status).toBe('new');
    // A national proposal can no longer be unshared.
    expect((await as('secretary').del(`/api/resolutions/${res1}/share`)).status).toBe(409);
  });

  it('coordinators and the Super Admin follow up national proposals', async () => {
    expect((await as('isfAdmin').patch(`/api/networks/${net}/proposals/${res1}`, { status: 'reviewing' })).status).toBe(403);
    const isfAdminId = (await as('isfAdmin').get('/api/auth/me')).body.id;
    expect((await as('root').post(`/api/networks/${net}/coordinators`, { userId: isfAdminId })).status).toBe(201);
    const p = await as('isfAdmin').patch(`/api/networks/${net}/proposals/${res1}`, { status: 'forwarded', response: 'به بانک مرکزی ارسال شد' });
    expect(p.status).toBe(200);
    expect(p.body.status).toBe('forwarded');
    expect(await events('isfChair')).toContain('network.proposal_updated');
    expect(await events('secretary')).toContain('network.proposal_updated');
  });

  it('the comparative dashboard is for admins of member chambers and national users', async () => {
    expect((await as('isfChair').get(`/api/networks/${net}/dashboard`)).status).toBe(403);
    const d = await as('yazdAdmin').get(`/api/networks/${net}/dashboard`);
    expect(d.status).toBe(200);
    expect(d.body.commissions).toHaveLength(2);
    const yazd = d.body.commissions.find((c: any) => c.id === exp);
    expect(yazd.shared).toBe(1);
    expect(yazd.endorsements_received).toBe(1);
    expect(d.body.commissions.find((c: any) => c.id === trd).endorsements_given).toBe(1);
    expect(d.body.proposals.forwarded).toBe(1);
  });

  it('the resolution page shows its networks and sharing rights', async () => {
    const r = (await as('secretary').get(`/api/resolutions/${res1}/networks`)).body;
    expect(r.canShare).toBe(true);
    expect(r.networks[0]).toMatchObject({ name: 'شبکه ملی تجارت و صادرات', proposal_status: 'forwarded' });
    expect((await as('m1').get(`/api/resolutions/${res1}/networks`)).body.canShare).toBe(false);
  });
});
