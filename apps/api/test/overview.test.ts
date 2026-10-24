import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { migrate } from '../src/db/migrate.js';
import { pool } from '../src/db/pool.js';
import { seed, SEED_PASSWORD } from '../src/db/seed.js';

/** Numbers of the dashboard cards. */
const app = createApp();
const tokens: Record<string, string> = {};
const get = (who: string, url: string) => request(app).get(url).set('authorization', `Bearer ${tokens[who]}`);

beforeAll(async () => {
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await migrate(false);
  await seed();
  for (const [who, email] of [['root', 'root@kx.local'], ['admin', 'admin@kx.local'], ['m1', 'member1@kx.local'], ['vice', 'vice@kx.local']]) {
    tokens[who] = (await request(app).post('/api/auth/login').send({ identifier: email, password: SEED_PASSWORD })).body.accessToken;
  }
});

describe('dashboard overview', () => {
  it("counts the member's own commissions and the chamber's totals", async () => {
    const r = await get('m1', '/api/me/overview');
    expect(r.status).toBe(200);
    expect(r.body.mine.commissions).toBe(2);
    expect(r.body.mine.upcoming).toBeGreaterThanOrEqual(1);
    expect(r.body.overall.commissions).toBe(2);
    expect(r.body.overall.members).toBeGreaterThanOrEqual(9);
    expect(r.body.scope).toContain('یزد');
    // Another chamber cannot be asked for by a member.
    const isf = (await pool.query(`SELECT id FROM chambers WHERE name LIKE '%اصفهان%'`)).rows[0]?.id;
    if (isf) expect((await get('m1', `/api/me/overview?chamberId=${isf}`)).body.scope).toContain('یزد');
  });

  it('uses the chosen chamber for its admin and every chamber for the Super Admin', async () => {
    const yazd = (await pool.query(`SELECT a.chamber_id FROM chamber_admins a JOIN users u ON u.id = a.user_id WHERE u.email = 'admin@kx.local'`)).rows[0].chamber_id;
    const a = await get('admin', `/api/me/overview?chamberId=${yazd}`);
    expect(a.body.mine.commissions).toBe(2);
    const all = await get('root', '/api/me/overview');
    expect(all.body.scope).toBe('همه اتاق‌ها');
    expect(all.body.overall.commissions).toBeGreaterThanOrEqual(a.body.overall.commissions);
  });
});
