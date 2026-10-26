import { spawnSync } from 'node:child_process';
import path from 'node:path';
import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { config } from '../src/config.js';
import { createFirstSuperAdmin } from '../src/db/create-admin.js';
import { migrate } from '../src/db/migrate.js';
import { pool } from '../src/db/pool.js';
import { demoPasswordAccounts, seed, SEED_PASSWORD } from '../src/db/seed.js';

/** Production installs start without demo accounts, with one super admin whose password nobody else knows. */
const app = createApp();
const root = path.resolve(__dirname, '..');
const users = async () => Number((await pool.query('SELECT count(*) FROM users')).rows[0].count);
const empty = async () => {
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await migrate(false);
};

beforeAll(empty);

describe('first super admin', () => {
  it('refuses weak or demo passwords and creates nothing', async () => {
    await expect(createFirstSuperAdmin('root@example.org', 'short')).rejects.toThrow(/12 characters/);
    await expect(createFirstSuperAdmin('root@example.org', `${SEED_PASSWORD}-2026`)).rejects.toThrow(/demo password/);
    await expect(createFirstSuperAdmin('root@example.org', 'aaaaaaaaaaaaaaaa')).rejects.toThrow(/repetitive/);
    await expect(createFirstSuperAdmin('not-an-email', 'Long-Unique-Pass-91')).rejects.toThrow(/email/);
    expect(await users()).toBe(0);
  });

  it('creates exactly one super admin, who can sign in and create the chamber', async () => {
    expect(await createFirstSuperAdmin('Root@Example.org', 'Long-Unique-Pass-91')).toBe(true);
    expect(await createFirstSuperAdmin('other@example.org', 'Another-Unique-Pass-7')).toBe(false);
    expect((await pool.query('SELECT email, is_super_admin, chamber_id FROM users')).rows).toEqual([
      { email: 'root@example.org', is_super_admin: true, chamber_id: null },
    ]);
    const login = await request(app).post('/api/auth/login').send({ identifier: 'root@example.org', password: 'Long-Unique-Pass-91' });
    expect(login.status).toBe(200);
    const chamber = await request(app)
      .post('/api/chambers')
      .set('Authorization', `Bearer ${login.body.accessToken}`)
      .send({ name: 'اتاق آزمایشی', province: 'یزد' });
    expect(chamber.status).toBeLessThan(300);
    expect(await demoPasswordAccounts()).toEqual([]);
  });

  it('the command reads the password from standard input and never prints it', async () => {
    await empty();
    const password = 'Piped-Secret-Pass-4821';
    const run = () =>
      spawnSync('npx', ['tsx', 'src/db/create-admin.ts'], { cwd: root, input: `${password}\n`, encoding: 'utf8', env: { ...process.env, ADMIN_EMAIL: 'it@example.org' } });
    const first = run();
    expect(first.status, first.stderr).toBe(0);
    expect(first.stdout).toContain('created');
    expect(first.stdout + first.stderr).not.toContain(password);
    expect((await pool.query('SELECT email FROM users WHERE is_super_admin')).rows).toEqual([{ email: 'it@example.org' }]);
    const again = run();
    expect(again.status).toBe(0);
    expect(again.stdout).toContain('nothing changed');
  });
});

describe('demo data', () => {
  it('is refused in production unless explicitly allowed', async () => {
    await empty();
    const was = config.isProd;
    (config as { isProd: boolean }).isProd = true;
    try {
      await expect(seed()).rejects.toThrow(/Refusing to load demo data in production/);
      expect(await users()).toBe(0);
      process.env.ALLOW_DEMO_SEED = '1';
      await seed();
    } finally {
      (config as { isProd: boolean }).isProd = was;
      delete process.env.ALLOW_DEMO_SEED;
    }
    expect(await users()).toBeGreaterThan(0);
  });

  it('accounts still on the public demo password are listed for the startup warning', async () => {
    const before = await demoPasswordAccounts();
    expect(before).toContain('root@kx.local');
    expect(before).toContain('admin@kx.local');
    await pool.query(`UPDATE users SET is_active = false WHERE email = 'guest@kx.local'`);
    await pool.query(`UPDATE users SET password_hash = 'x' WHERE email = 'chair@kx.local'`);
    const after = await demoPasswordAccounts();
    expect(after).not.toContain('guest@kx.local');
    expect(after).not.toContain('chair@kx.local');
    expect(after.length).toBe(before.length - 2);
  });
});
