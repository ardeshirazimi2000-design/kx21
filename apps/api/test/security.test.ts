import request from 'supertest';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { migrate } from '../src/db/migrate.js';
import { pool } from '../src/db/pool.js';
import { seed, SEED_PASSWORD } from '../src/db/seed.js';
import { clearIpFailuresForTest, invalidateSecurityPolicy, solveCaptchaForTest } from '../src/services/security.js';

/** AFTA identification/authentication and product access: password policy, lockout, CAPTCHA, sessions. */
const app = createApp();
const login = (identifier: string, password: string, extra: object = {}) => request(app).post('/api/auth/login').send({ identifier, password, device: 'web', ...extra });
const get = (path: string, token: string) => request(app).get(path).set('authorization', `Bearer ${token}`);
const audits = async (action: string) => Number((await pool.query('SELECT count(*) FROM audit_logs WHERE action = $1', [action])).rows[0].count);
let root: string;

beforeAll(async () => {
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await migrate(false);
  await seed();
  root = (await login('root@kx.local', SEED_PASSWORD)).body.accessToken;
});

beforeEach(async () => {
  clearIpFailuresForTest();
  await pool.query(`UPDATE users SET failed_logins = 0, locked_until = NULL`);
});

describe('security policy', () => {
  it('is set by the IT administrator only, within its limits, and audited', async () => {
    const secretary = (await login('secretary@kx.local', SEED_PASSWORD)).body.accessToken;
    expect((await get('/api/security-policy', secretary)).status).toBe(403);
    const r = await get('/api/security-policy', root);
    expect(r.body.policy.lockout).toEqual({ maxFailures: 5, lockMinutes: 15, captchaAfter: 3 });
    const put = await request(app)
      .put('/api/security-policy')
      .set('authorization', `Bearer ${root}`)
      .send({ ...r.body.policy, password: { ...r.body.policy.password, minLength: 2 }, session: { ...r.body.policy.session, maxConcurrent: 2 } });
    expect(put.status).toBe(200);
    expect(put.body.policy.password.minLength).toBe(8);
    expect(put.body.policy.session.maxConcurrent).toBe(2);
    expect(await audits('security.policy_changed')).toBe(1);
    expect((await get('/api/password-rules', secretary)).body.text).toContain('۸');
  });
});

describe('passwords', () => {
  it('refuses a new password that breaks the policy and accepts one that keeps it', async () => {
    const t = (await login('member6@kx.local', SEED_PASSWORD)).body.accessToken;
    const change = (newPassword: string) => request(app).post('/api/auth/password').set('authorization', `Bearer ${t}`).send({ currentPassword: SEED_PASSWORD, newPassword });
    const weak = await change('simplepass');
    expect(weak.status).toBe(400);
    expect(weak.body.error.message).toContain('حرف بزرگ');
    expect((await change('member6-Strong!1')).status).toBe(400); // contains the user name
    expect((await change('N3w-Secure!Pass')).status).toBe(204);
    expect((await login('member6@kx.local', 'N3w-Secure!Pass')).status).toBe(200);
  });

  it('applies the policy when an administrator sets a password, and ends that person’s sessions', async () => {
    const admin = (await login('admin@kx.local', SEED_PASSWORD)).body.accessToken;
    const chamberId = (await pool.query(`SELECT chamber_id FROM users WHERE email = 'admin@kx.local'`)).rows[0].chamber_id;
    const weak = await request(app).post('/api/people').set('authorization', `Bearer ${admin}`).send({ chamberId, fullName: 'کاربر آزمایشی', mobile: '09121234567', password: '12345678' });
    expect(weak.status).toBe(400);
    const member5 = (await login('member5@kx.local', SEED_PASSWORD)).body.accessToken;
    const id = (await pool.query(`SELECT id FROM users WHERE email = 'member5@kx.local'`)).rows[0].id;
    expect((await request(app).patch(`/api/people/${id}`).set('authorization', `Bearer ${admin}`).send({ password: 'Reset-By-Admin!7' })).status).toBe(200);
    expect((await get('/api/auth/me', member5)).body.error.code).toBe('session_ended');
  });
});

describe('failed sign-ins', () => {
  it('asks for a CAPTCHA after repeated failures, then locks the account for a while', async () => {
    for (let i = 0; i < 3; i++) expect((await login('vice@kx.local', 'wrong')).status).toBe(401);
    const third = await login('vice@kx.local', 'wrong');
    expect(third.body.error.code).toBe('captcha_required');
    // Without the CAPTCHA even the right password is not tried.
    expect((await login('vice@kx.local', SEED_PASSWORD)).body.error.code).toBe('captcha_required');
    const captcha = async () => {
      const c = (await request(app).get('/api/auth/captcha')).body;
      expect(c.image).toMatch(/^data:image\/png;base64,/);
      return { captchaId: c.id, captchaAnswer: solveCaptchaForTest(c.id)! };
    };
    const wrongCaptcha = await login('vice@kx.local', SEED_PASSWORD, { ...(await captcha()), captchaAnswer: '00000x' });
    expect(wrongCaptcha.body.error.code).toBe('captcha_required');
    // CAPTCHA mistakes do not count toward the lock; wrong passwords do: the fifth one locks the account.
    expect((await login('vice@kx.local', 'wrong', await captcha())).body.error.code).toBe('unauthorized');
    const locked = await login('vice@kx.local', 'wrong', await captcha());
    expect(locked.status).toBe(423);
    expect(locked.body.error.code).toBe('account_locked');
    expect((await login('vice@kx.local', SEED_PASSWORD, await captcha())).status).toBe(423);
    expect(await audits('auth.account_locked')).toBe(1);
    // It unlocks by itself when the time is up.
    await pool.query(`UPDATE users SET locked_until = now() - interval '1 second' WHERE email = 'vice@kx.local'`);
    clearIpFailuresForTest();
    const ok = await login('vice@kx.local', SEED_PASSWORD);
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    // ... and shows the last sign-in and the failures since.
    expect(ok.body.lastLogin).toBeNull();
    const again = await login('vice@kx.local', SEED_PASSWORD);
    expect(again.body.lastLogin).toMatchObject({ failedSince: 0 });
    expect(new Date(again.body.lastLogin.at).getTime()).toBeGreaterThan(Date.now() - 60_000);
  });

  it('counts failures between two sign-ins', async () => {
    await login('member4@kx.local', SEED_PASSWORD);
    await login('member4@kx.local', 'wrong');
    await login('member4@kx.local', 'wrong');
    clearIpFailuresForTest();
    const r = await login('member4@kx.local', SEED_PASSWORD);
    expect(r.body.lastLogin.failedSince).toBe(2);
  });
});

describe('sessions', () => {
  it('ends the oldest session when the user opens more than the policy allows', async () => {
    // The policy test set maxConcurrent = 2.
    invalidateSecurityPolicy();
    const a = (await login('member3@kx.local', SEED_PASSWORD)).body;
    const b = (await login('member3@kx.local', SEED_PASSWORD)).body;
    const c = (await login('member3@kx.local', SEED_PASSWORD)).body;
    expect(c.endedSessions).toBe(1);
    expect((await get('/api/auth/me', a.accessToken)).body.error.code).toBe('session_ended');
    expect((await get('/api/auth/me', b.accessToken)).status).toBe(200);
    expect((await get('/api/auth/me', c.accessToken)).status).toBe(200);
    expect((await request(app).post('/api/auth/refresh').send({ refreshToken: a.refreshToken })).status).toBe(401);
  });

  it('ends a session after the idle time, for requests and refreshes alike', async () => {
    const s = (await login('member2@kx.local', SEED_PASSWORD)).body;
    expect((await get('/api/auth/me', s.accessToken)).status).toBe(200);
    await pool.query(`UPDATE refresh_tokens SET last_used_at = now() - interval '2 hours' WHERE user_id = (SELECT id FROM users WHERE email = 'member2@kx.local')`);
    const r = await get('/api/auth/me', s.accessToken);
    expect(r.status).toBe(401);
    expect(r.body.error.code).toBe('session_idle');
    expect((await request(app).post('/api/auth/refresh').send({ refreshToken: s.refreshToken })).status).toBe(401);
  });

  it('keeps a mobile session for days, not minutes', async () => {
    const s = (await request(app).post('/api/auth/login').send({ identifier: 'member1@kx.local', password: SEED_PASSWORD, device: 'mobile' })).body;
    await pool.query(`UPDATE refresh_tokens SET last_used_at = now() - interval '2 hours' WHERE user_id = (SELECT id FROM users WHERE email = 'member1@kx.local')`);
    expect((await get('/api/auth/me', s.accessToken)).status).toBe(200);
  });

  it('signing out ends the session at once', async () => {
    const s = (await login('expert@kx.local', SEED_PASSWORD)).body;
    expect((await request(app).post('/api/auth/logout').send({ refreshToken: s.refreshToken })).status).toBe(204);
    expect((await get('/api/auth/me', s.accessToken)).body.error.code).toBe('session_ended');
  });
});
