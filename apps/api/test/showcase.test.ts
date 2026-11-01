import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { migrate } from '../src/db/migrate.js';
import { pool } from '../src/db/pool.js';
import { seed } from '../src/db/seed.js';
import { showcase, SHOWCASE_PASSWORD } from '../src/db/showcase.js';

/** Presentation data: built through the API on an empty install only. */
const count = async (sql: string) => Number((await pool.query(sql)).rows[0].n);

beforeAll(async () => {
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await migrate(false);
});

describe('showcase data', () => {
  it('builds six chambers with their meetings, resolutions and networks', async () => {
    await showcase({ log: () => undefined });
    expect(await count(`SELECT count(*) n FROM chambers WHERE kind = 'provincial'`)).toBe(6);
    expect(await count(`SELECT count(*) n FROM chambers WHERE kind = 'national'`)).toBe(1);
    expect(await count(`SELECT count(*) n FROM commissions WHERE body_type = 'commission'`)).toBe(18);
    expect(await count(`SELECT count(*) n FROM commissions WHERE body_type = 'council' AND council_secretary_id IS NOT NULL`)).toBe(7);
    expect(await count(`SELECT count(*) n FROM meetings m JOIN commissions c ON c.id = m.commission_id WHERE c.body_type = 'commission' AND m.archival AND m.status = 'approved'`)).toBe(54);
    expect(await count(`SELECT count(*) n FROM meetings m JOIN commissions c ON c.id = m.commission_id WHERE c.body_type = 'commission' AND m.status = 'invitation_sent'`)).toBe(18);
    expect(await count(`SELECT count(*) n FROM minutes WHERE status = 'approved'`)).toBeGreaterThan(54);
    expect(await count('SELECT count(*) n FROM resolution_updates')).toBeGreaterThan(100);
    expect(await count('SELECT count(*) n FROM network_proposals')).toBe(4);
    expect(await count(`SELECT count(*) n FROM referrals WHERE status = 'answered'`)).toBe(18);
    // شورای گفت‌وگو: a case at every stage.
    const cases = (await pool.query(`SELECT k.title, k.level, k.status, k.confidential FROM council_cases k ORDER BY k.code`)).rows;
    expect(cases.map((k) => `${k.level}/${k.status}`)).toEqual([
      'national/closed', 'provincial/pending_approval', 'provincial/closed', 'provincial/expert_review', 'provincial/on_agenda', 'national/on_agenda', 'provincial/returned',
    ]);
    expect(cases.at(-1).confidential).toBe(true);
    const president = await request(createApp()).post('/api/auth/login').send({ identifier: 'president.shz@demo.ir', password: SHOWCASE_PASSWORD });
    const mine = await request(createApp()).get('/api/council-cases?status=pending_approval').set('authorization', `Bearer ${president.body.accessToken}`);
    expect(mine.body.items.length).toBe(1);
    const login = await request(createApp()).post('/api/auth/login').send({ identifier: 'secretary.agr.yzd@demo.ir', password: SHOWCASE_PASSWORD });
    expect(login.status).toBe(200);
  }, 240_000);

  it('refuses a database that already has data, and the demo seed does too', async () => {
    await expect(showcase({ log: () => undefined })).rejects.toThrow(/empty install/);
    const users = await count('SELECT count(*) n FROM users');
    await seed();
    expect(await count('SELECT count(*) n FROM users')).toBe(users);
  });
});
