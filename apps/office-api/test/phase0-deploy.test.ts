// Regression tests for the production readiness review, phase 0: R3 (no demo accounts on a real install) and
// R5 (no sample secrets in production). Production starts run in a child process so the test config is untouched.
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { DEMO_PASSWORD, DEMO_USERNAMES, demoPasswordAccounts } from '../src/db/bootstrap.js';
import { createAdminFromInput } from '../src/db/create-admin.js';
import { pool } from '../src/db/pool.js';
import { seed } from '../src/db/seed.js';

const app = createApp();
const root = path.resolve(__dirname, '..');
const repo = path.resolve(root, '../..');
const tsx = path.join(repo, 'node_modules/.bin/tsx');
const RANDOM_HEX = 'b7c41f0e9a2d58e3c6f1a0b9d8e7c6a5f4e3d2c1b0a99887766554433221100f';
const ADMIN_PASSWORD = 'Rk7-test-only-admin-2026';

// Production refuses the default database password, so production-mode runs connect as a role with a random one.
const PROD_ROLE = 'kx_phase0_prod';
const PROD_ROLE_PASSWORD = 'f3a9c27e1b4d5068';

/** Runs a script of this app as production would, with the given environment on top of a valid one. */
function runProd(script: string, env: Record<string, string>, input?: string) {
  const testUrl = new URL(process.env.DATABASE_URL!);
  testUrl.username = PROD_ROLE;
  testUrl.password = PROD_ROLE_PASSWORD;
  return spawnSync(tsx, [script], {
    cwd: root,
    input,
    encoding: 'utf8',
    timeout: 60_000,
    env: {
      PATH: process.env.PATH,
      NODE_ENV: 'production',
      JWT_SECRET: RANDOM_HEX,
      DATA_ENCRYPTION_KEY: RANDOM_HEX,
      DATABASE_URL: testUrl.toString(),
      ...env,
    },
  });
}

beforeAll(async () => {
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  const owner = (await pool.query('SELECT current_user AS u')).rows[0].u;
  await pool.query(`DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${PROD_ROLE}') THEN
    CREATE ROLE ${PROD_ROLE} LOGIN PASSWORD '${PROD_ROLE_PASSWORD}'; END IF; END $$`);
  await pool.query(`GRANT ${owner} TO ${PROD_ROLE}`);
});

afterAll(async () => {
  await pool.end();
});

describe('R3: a real install has no demo accounts', () => {
  it('demo data is refused in production unless explicitly allowed', () => {
    const r = runProd('src/db/seed.ts', {});
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain('Refusing to load demo data');
  });

  it('the first administrator needs a strong password that is not the demo one', async () => {
    await expect(createAdminFromInput('admin', DEMO_PASSWORD)).rejects.toThrow(/at least 12|demo password/);
    await expect(createAdminFromInput('admin', `${DEMO_PASSWORD}-longer`)).rejects.toThrow(/demo password/);
    await expect(createAdminFromInput('admin', 'aaaaaaaaaaaaaaaa')).rejects.toThrow(/repetitive/);
    expect((await pool.query(`SELECT count(*)::int AS n FROM users WHERE username <> 'system'`)).rows[0].n).toBe(0);
  });

  it('an empty install gets exactly one administrator, and the demo password does not sign in', async () => {
    expect(await createAdminFromInput('admin', ADMIN_PASSWORD)).toBe(true);
    const users = (await pool.query(`SELECT username, clearance FROM users WHERE username <> 'system'`)).rows;
    expect(users).toEqual([{ username: 'admin', clearance: 2 }]);
    expect((await request(app).post('/api/auth/login').send({ identifier: 'admin', password: DEMO_PASSWORD })).status).toBe(401);
    const ok = await request(app).post('/api/auth/login').send({ identifier: 'admin', password: ADMIN_PASSWORD });
    expect(ok.status).toBe(200);
    const meRes = await request(app).get('/api/auth/me').set('authorization', `Bearer ${ok.body.accessToken}`);
    expect(meRes.body.permissions).toContain('roles.manage');
    expect(await demoPasswordAccounts(pool, DEMO_USERNAMES)).toEqual([]);
  });

  it('creating the administrator again changes nothing', async () => {
    expect(await createAdminFromInput('admin', 'Another-strong-pass-2026')).toBe(false);
    expect((await request(app).post('/api/auth/login').send({ identifier: 'admin', password: 'Another-strong-pass-2026' })).status).toBe(401);
  });

  it('the install script reads the password from standard input and never prints it', async () => {
    await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
    const r = runProd('src/db/create-admin.ts', { ADMIN_USERNAME: 'chief' }, `${ADMIN_PASSWORD}\n`);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout + r.stderr).not.toContain(ADMIN_PASSWORD);
    expect((await pool.query(`SELECT username FROM users WHERE username <> 'system'`)).rows).toEqual([{ username: 'chief' }]);
    expect((await request(app).post('/api/auth/login').send({ identifier: 'chief', password: ADMIN_PASSWORD })).status).toBe(200);
  });

  it('accounts still on the demo password are detected (startup warning)', async () => {
    await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
    await seed();
    expect((await demoPasswordAccounts(pool, DEMO_USERNAMES)).sort()).toEqual([...DEMO_USERNAMES].sort());
  });

  it('install scripts load office demo data only when OFFICE_SEED=1 is given', () => {
    for (const f of ['deploy/install.sh', 'deploy/docker-install.sh']) {
      const s = readFileSync(path.join(repo, f), 'utf8');
      const seedLines = s.split('\n').filter((l) => l.includes('office-api') && l.includes('seed.js'));
      expect(seedLines.length, f).toBeGreaterThan(0);
      for (const l of seedLines) expect(l, f).toContain('ALLOW_DEMO_SEED=1');
      expect(s, f).toMatch(/OFFICE_SEED:-0/);
      expect(s, f).toContain('create-admin.js');
    }
  });
});

describe('R5: production refuses sample secrets', () => {
  const start = (env: Record<string, string>) => runProd('src/config.ts', env);

  it('starts with random secrets', () => {
    const r = start({});
    expect(r.status, r.stderr).toBe(0);
  });

  it.each([
    ['the .env.example JWT secret', { JWT_SECRET: 'change-me-in-production-with-a-long-random-secret' }, 'JWT_SECRET'],
    ['the development JWT secret', { JWT_SECRET: 'dev-only-office-secret-do-not-use-in-production' }, 'JWT_SECRET'],
    ['a repetitive encryption key', { DATA_ENCRYPTION_KEY: '0'.repeat(64) }, 'DATA_ENCRYPTION_KEY'],
    ['the compose default database password', { DATABASE_URL: 'postgres://kx:kx@office-db:5432/kx_office' }, 'DATABASE_URL'],
  ])('refuses %s, naming the variable but not the value', (_name, env, variable) => {
    const r = start(env as Record<string, string>);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain(variable);
    for (const v of Object.values(env)) expect(r.stderr).not.toContain(v);
  });
});
