import request from 'supertest';
import { createApp } from '../src/app.js';
import { migrate } from '../src/db/migrate.js';
import { pool } from '../src/db/pool.js';
import { createStaff, seedDistricts } from '../src/db/seed.js';
import { mockState } from '../src/integrations/apiir.js';

export const app = createApp();
export const api = () => request(app);
export const PASSWORD = 'Strong-Pass-123!';

export async function resetDb() {
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await migrate();
  await seedDistricts(5);
  mockState.reset();
}

let seq = 100;
/** Valid-checksum national code. */
export function nationalCode(): string {
  const prefix = String(100000000 + seq++).slice(0, 9);
  const d = prefix.split('').map(Number);
  const s = d.reduce((a, x, i) => a + x * (10 - i), 0) % 11;
  return prefix + String(s < 2 ? s : 11 - s);
}
export function mobile(): string {
  return `0935${String(1000000 + seq++).slice(-7)}`;
}

export async function staff(roles: string[], opts: { username?: string; districtId?: number | null; console?: boolean } = {}) {
  const nc = nationalCode();
  const m = mobile();
  const username = opts.console === false ? undefined : (opts.username ?? `u${seq++}`);
  const id = await createStaff({ nationalCode: nc, mobile: m, firstName: 'کاربر', lastName: 'آزمون', username, roles, districtId: opts.districtId ?? null, password: PASSWORD, mustChange: false });
  return { id, nationalCode: nc, mobile: m, username };
}

/** Full console sign-in (password + OTP); returns the access token. */
export async function consoleLogin(username: string, password = PASSWORD): Promise<string> {
  const r1 = await api().post('/api/console/auth/login').send({ username, password });
  if (r1.status !== 200) throw new Error(`login ${r1.status} ${JSON.stringify(r1.body)}`);
  const m = (await pool.query('SELECT mobile FROM users WHERE username = $1', [username])).rows[0].mobile;
  const r2 = await api().post('/api/console/auth/verify').send({ challengeId: r1.body.challengeId, code: mockState.sent.get(m) });
  if (r2.status !== 200) throw new Error(`verify ${r2.status} ${JSON.stringify(r2.body)}`);
  return r2.body.accessToken;
}

export async function appLogin(nc: string, m: string, deviceId = 'device-0001', extra: Record<string, string> = {}) {
  const r1 = await api().post('/api/app/auth/start').send({ nationalCode: nc, mobile: m, deviceId });
  if (r1.status !== 200) return { start: r1 } as const;
  const r2 = await api().post('/api/app/auth/verify').send({ challengeId: r1.body.challengeId, code: mockState.sent.get(m), deviceId, ...extra });
  return { start: r1, verify: r2 } as const;
}

export const bearer = (t: string) => ({ Authorization: `Bearer ${t}` });
