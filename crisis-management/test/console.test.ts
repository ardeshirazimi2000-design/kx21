import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { pool } from '../src/db/pool.js';
import { mockState } from '../src/integrations/apiir.js';
import { api, appLogin, bearer, consoleLogin, mobile, nationalCode, PASSWORD, resetDb, staff } from './helpers.js';

beforeEach(resetDb);
afterAll(() => pool.end());

describe('console sign-in (password + SMS OTP)', () => {
  it('requires the OTP sent to the registered mobile', async () => {
    const a = await staff(['operator']);
    const r1 = await api().post('/api/console/auth/login').send({ username: a.username, password: PASSWORD });
    expect(r1.body).toMatchObject({ step: 'otp', mobileMasked: expect.stringContaining('***') });
    expect(r1.body.accessToken).toBeUndefined();
    expect(mockState.sent.has(a.mobile)).toBe(true);
    const r2 = await api().post('/api/console/auth/verify').send({ challengeId: r1.body.challengeId, code: mockState.sent.get(a.mobile) });
    expect(r2.status).toBe(200);
    expect(r2.body.accessToken).toBeTruthy();
  });

  it('locks the account after repeated wrong passwords, with the same message for unknown users', async () => {
    const a = await staff(['operator']);
    const unknown = await api().post('/api/console/auth/login').send({ username: 'nobody', password: 'x' });
    const wrong = await api().post('/api/console/auth/login').send({ username: a.username, password: 'wrong' });
    expect(unknown.status).toBe(401);
    expect(unknown.body.error.message).toBe(wrong.body.error.message);
    for (let i = 0; i < 4; i++) await api().post('/api/console/auth/login').send({ username: a.username, password: 'wrong' });
    const locked = await api().post('/api/console/auth/login').send({ username: a.username, password: PASSWORD });
    expect(locked.status).toBe(423);
    expect((await pool.query(`SELECT count(*)::int AS n FROM audit_log WHERE action = 'account.locked'`)).rows[0].n).toBe(1);
  });

  it('denies console sign-in to app-only roles', async () => {
    const r = await staff(['responder']);
    const res = await api().post('/api/console/auth/login').send({ username: r.username, password: PASSWORD });
    expect(res.status).toBe(401);
  });

  it('suspends the account when the periodic Shahkar re-check fails', async () => {
    const a = await staff(['operator']);
    await pool.query(`UPDATE users SET shahkar_verified_at = now() - interval '400 days' WHERE id = $1`, [a.id]);
    mockState.mismatches.add(`${a.nationalCode}:${a.mobile}`);
    const res = await api().post('/api/console/auth/login').send({ username: a.username, password: PASSWORD });
    expect(res.status).toBe(403);
    expect((await pool.query('SELECT status FROM users WHERE id = $1', [a.id])).rows[0].status).toBe('suspended');
  });
});

describe('user administration with Shahkar', () => {
  it('creates a staff user only after a Shahkar match and forces a password change', async () => {
    const admin = await staff(['security_admin']);
    const t = await consoleLogin(admin.username!);
    const nc = nationalCode();
    const m = mobile();

    mockState.mismatches.add(`${nc}:${m}`);
    const mismatch = await api().post('/api/console/users').set(bearer(t)).send({ nationalCode: nc, mobile: m, firstName: 'پرویز', lastName: 'نادری', consoleAccess: true, username: 'pnaderi', role: { key: 'operator' } });
    expect(mismatch.status).toBe(422);
    expect((await pool.query('SELECT count(*)::int AS n FROM users WHERE national_code = $1', [nc])).rows[0].n).toBe(0);

    mockState.mismatches.clear();
    const ok = await api().post('/api/console/users').set(bearer(t)).send({ nationalCode: nc, mobile: m, firstName: 'پرویز', lastName: 'نادری', consoleAccess: true, username: 'pnaderi', role: { key: 'operator' } });
    expect(ok.status).toBe(201);
    expect(ok.body.temporaryPassword).toBeTruthy();
    expect(ok.body.user.shahkar_verified_at).toBeTruthy();
    expect(ok.body.user.roles.map((r: { key: string }) => r.key)).toEqual(['operator']);

    // First console sign-in with the temporary password: only /me and change-password are allowed.
    const ut = await consoleLogin('pnaderi', ok.body.temporaryPassword);
    expect((await api().get('/api/console/me').set(bearer(ut))).body.passwordChangeRequired).toBe(true);
    expect((await api().get('/api/console/incidents').set(bearer(ut))).status).toBe(403);
    const weak = await api().post('/api/console/auth/change-password').set(bearer(ut)).send({ currentPassword: ok.body.temporaryPassword, newPassword: 'short' });
    expect(weak.status).toBe(400);
    const changed = await api().post('/api/console/auth/change-password').set(bearer(ut)).send({ currentPassword: ok.body.temporaryPassword, newPassword: 'New-Strong-Pass-99!' });
    expect(changed.status).toBe(204);
    expect((await api().get('/api/console/incidents').set(bearer(ut))).status).toBe(200);
  });

  it('issues a working temporary password on reset, unlocks the account and ends its sessions', async () => {
    const admin = await staff(['security_admin']);
    const t = await consoleLogin(admin.username!);
    const user = await staff(['operator']);
    const old = await consoleLogin(user.username!);
    await pool.query(`UPDATE users SET locked_until = now() + interval '1 hour' WHERE id = $1`, [user.id]);

    const r = await api().post(`/api/console/users/${user.id}/reset-password`).set(bearer(t));
    expect(r.status).toBe(200);
    expect(r.body.temporaryPassword).toMatch(/^Tmp-[A-HJ-NP-Za-km-np-z2-9]{12}#\d{2}$/);
    expect((await api().get('/api/console/me').set(bearer(old))).status).toBe(401);

    const ut = await consoleLogin(user.username!, r.body.temporaryPassword);
    expect((await api().get('/api/console/me').set(bearer(ut))).body.passwordChangeRequired).toBe(true);
  });

  it('re-verifies Shahkar when an administrator changes a mobile, and resets app enrolment', async () => {
    const admin = await staff(['security_admin']);
    const t = await consoleLogin(admin.username!);
    const r = await staff(['responder'], { console: false });
    const { verify } = await appLogin(r.nationalCode, r.mobile);
    const newMobile = mobile();
    mockState.mismatches.add(`${r.nationalCode}:${newMobile}`);
    expect((await api().patch(`/api/console/users/${r.id}`).set(bearer(t)).send({ mobile: newMobile })).status).toBe(422);
    mockState.mismatches.clear();
    const ok = await api().patch(`/api/console/users/${r.id}`).set(bearer(t)).send({ mobile: newMobile });
    expect(ok.status).toBe(200);
    expect(ok.body.user.app_enrolled_at).toBeNull();
    expect((await api().get('/api/app/me').set(bearer(verify!.body.accessToken))).status).toBe(401);
  });

  it('enforces least privilege: operators cannot manage users and the denial is audited', async () => {
    const op = await staff(['operator']);
    const t = await consoleLogin(op.username!);
    expect((await api().get('/api/console/users').set(bearer(t))).status).toBe(403);
    const a = await pool.query(`SELECT details FROM audit_log WHERE action = 'access.denied' AND actor_id = $1`, [op.id]);
    expect(a.rows[0].details.required).toEqual(['users.read']);
  });

  it('keeps exactly one role per user, forbids self-assignment, and ends sessions on a role change', async () => {
    const admin = await staff(['security_admin']);
    const t = await consoleLogin(admin.username!);
    const other = await staff(['operator']);
    const ot = await consoleLogin(other.username!);

    expect((await api().put(`/api/console/users/${admin.id}/role`).set(bearer(t)).send({ role: null })).status).toBe(403);
    // Arrays of roles are not accepted any more.
    expect((await api().put(`/api/console/users/${other.id}/role`).set(bearer(t)).send({ role: [{ key: 'operator' }, { key: 'observer' }] })).status).toBe(400);

    const r = await api().put(`/api/console/users/${other.id}/role`).set(bearer(t)).send({ role: { key: 'observer' } });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ before: 'operator', after: 'observer' });
    expect(r.body.user.roles.map((x: { key: string }) => x.key)).toEqual(['observer']);
    // FIA_USB.1.3: no attribute change inside a live session — the user must sign in again.
    expect((await api().get('/api/console/incidents').set(bearer(ot))).status).toBe(401);

    // Demoting the only other security administrator is fine while one remains; demoting the last is refused.
    await api().put(`/api/console/users/${other.id}/role`).set(bearer(t)).send({ role: { key: 'security_admin' } }).expect(200);
    const t2 = await consoleLogin(other.username!);
    await api().put(`/api/console/users/${admin.id}/role`).set(bearer(t2)).send({ role: { key: 'operator' } }).expect(200);
    const lastAdmin = await pool.query(`SELECT count(*)::int AS n FROM user_roles WHERE role_key = 'security_admin'`);
    expect(lastAdmin.rows[0].n).toBe(1);
  });

  it('does not let staff-only roles be granted to citizens', async () => {
    const admin = await staff(['security_admin']);
    const t = await consoleLogin(admin.username!);
    const nc = nationalCode();
    const m = mobile();
    await appLogin(nc, m, 'device-0001', { firstName: 'نسرین', lastName: 'یزدانی' });
    const citizen = (await pool.query('SELECT id FROM users WHERE national_code = $1', [nc])).rows[0];
    const res = await api().put(`/api/console/users/${citizen.id}/role`).set(bearer(t)).send({ role: { key: 'operator' } });
    expect(res.status).toBe(400);
  });

  it('suspending a user revokes their sessions immediately', async () => {
    const admin = await staff(['security_admin']);
    const t = await consoleLogin(admin.username!);
    const op = await staff(['operator']);
    const ot = await consoleLogin(op.username!);
    await api().post(`/api/console/users/${op.id}/status`).set(bearer(t)).send({ status: 'suspended', reason: 'ترک خدمت' }).expect(200);
    expect((await api().get('/api/console/incidents').set(bearer(ot))).status).toBe(401);
  });

  it('masks identity data for read-only viewers (auditor)', async () => {
    const auditor = await staff(['security_auditor']);
    const t = await consoleLogin(auditor.username!);
    const res = await api().get('/api/console/users').set(bearer(t));
    expect(res.status).toBe(200);
    expect(res.body.every((u: { national_code: string }) => u.national_code.includes('****'))).toBe(true);
  });
});

describe('roles and audit', () => {
  it('rejects reserved permissions in custom roles and edits to locked roles', async () => {
    const admin = await staff(['security_admin']);
    const t = await consoleLogin(admin.username!);
    const esc = await api().post('/api/console/roles').set(bearer(t)).send({ key: 'helper', title: 'دستیار', scope: 'city', permissions: ['console.access', 'users.create'] });
    expect(esc.status).toBe(400);
    const ok = await api().post('/api/console/roles').set(bearer(t)).send({ key: 'red_crescent', title: 'رابط هلال احمر', scope: 'city', permissions: ['console.access', 'incidents.read', 'tasks.read'] });
    expect(ok.status).toBe(201);
    expect(ok.body.permissions).toEqual(['console.access', 'incidents.read', 'tasks.read']);
    const locked = await api().put('/api/console/roles/security_auditor').set(bearer(t)).send({ title: 'x', scope: 'city', permissions: [] });
    expect(locked.status).toBe(403);
  });

  it('only the auditor reads the audit trail, and the trail is append-only', async () => {
    const admin = await staff(['security_admin']);
    const auditor = await staff(['security_auditor']);
    const ta = await consoleLogin(admin.username!);
    const tu = await consoleLogin(auditor.username!);
    expect((await api().get('/api/console/security/audit').set(bearer(ta))).status).toBe(403);
    const log = await api().get('/api/console/security/audit').set(bearer(tu));
    expect(log.status).toBe(200);
    expect(log.body.some((e: { action: string }) => e.action === 'console.login')).toBe(true);
    await expect(pool.query('UPDATE audit_log SET action = $1', ['x'])).rejects.toThrow(/append-only/);
    await expect(pool.query('DELETE FROM audit_log')).rejects.toThrow(/append-only/);
  });
});
