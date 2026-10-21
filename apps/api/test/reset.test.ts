import { mkdir, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { config } from '../src/config.js';
import { migrate } from '../src/db/migrate.js';
import { pool } from '../src/db/pool.js';
import { resetToRoot } from '../src/db/reset.js';
import { seed } from '../src/db/seed.js';

/** Clearing the demo data before going live: only the super admin remains. */
const app = createApp();
const count = async (t: string) => Number((await pool.query(`SELECT count(*) FROM ${t}`)).rows[0].count);

beforeAll(async () => {
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await migrate(false);
  await seed();
});

describe('reset to root', () => {
  it('refuses without confirmation or while the demo password stays', async () => {
    await expect(resetToRoot({})).rejects.toThrow(/CONFIRM_RESET/);
    await expect(resetToRoot({ CONFIRM_RESET: 'DELETE-ALL-DATA' })).rejects.toThrow(/ROOT_PASSWORD/);
    await expect(resetToRoot({ CONFIRM_RESET: 'DELETE-ALL-DATA', ROOT_PASSWORD: 'short' })).rejects.toThrow(/10 characters/);
    expect(await count('meetings')).toBeGreaterThan(0);
  });

  it('deletes everything but the super admin, with the new password and details', async () => {
    await mkdir(config.uploadDir, { recursive: true });
    await writeFile(path.join(config.uploadDir, 'old-file'), 'x');
    await pool.query(`INSERT INTO app_settings (key, value) VALUES ('holiday_api_date_style', '{"field":"date","format":"j"}')`);
    const left = await resetToRoot({ CONFIRM_RESET: 'DELETE-ALL-DATA', ROOT_PASSWORD: 'N3w-Strong-Pass', ROOT_EMAIL: 'IT@Chamber.ir', ROOT_MOBILE: '09121234567' });
    expect(left).toEqual([{ full_name: 'مدیر سامانه', email: 'it@chamber.ir', mobile: '09121234567' }]);
    for (const t of ['chambers', 'commissions', 'meetings', 'resolutions', 'documents', 'notifications', 'audit_logs', 'networks']) {
      expect(await count(t), t).toBe(0);
    }
    expect(await count('schema_migrations')).toBeGreaterThan(0);
    expect(await count('app_settings')).toBe(1);
    expect(await readdir(config.uploadDir)).toEqual([]);

    const old = await request(app).post('/api/auth/login').send({ identifier: 'it@chamber.ir', password: 'Passw0rd!' });
    expect(old.status).toBe(401);
    const login = await request(app).post('/api/auth/login').send({ identifier: 'it@chamber.ir', password: 'N3w-Strong-Pass' });
    expect(login.status).toBe(200);
    // The root can start building the real structure right away.
    const ch = await request(app).post('/api/chambers').set('authorization', `Bearer ${login.body.accessToken}`).send({ name: 'اتاق بازرگانی سنندج', province: 'کردستان' });
    expect(ch.status).toBe(201);
  });
});
