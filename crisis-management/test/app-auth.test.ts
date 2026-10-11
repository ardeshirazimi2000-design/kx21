import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { pool } from '../src/db/pool.js';
import { mockState } from '../src/integrations/apiir.js';
import { api, appLogin, bearer, mobile, nationalCode, resetDb, staff } from './helpers.js';

beforeEach(resetDb);
afterAll(() => pool.end());

describe('app sign-in: Shahkar on initial sign-in, OTP afterwards', () => {
  it('runs Shahkar + OTP on the first sign-in and OTP only on later sign-ins', async () => {
    const r = await staff(['responder'], { console: false });
    const first = await appLogin(r.nationalCode, r.mobile);
    expect(first.start.body).toMatchObject({ step: 'otp', firstLogin: true, shahkarVerified: true });
    expect(first.verify!.status).toBe(200);
    expect(first.verify!.body.firstLogin).toBe(true);
    expect(mockState.shahkarCalls).toBe(1);

    const second = await appLogin(r.nationalCode, r.mobile);
    expect(second.start.body).toMatchObject({ firstLogin: false, shahkarVerified: false });
    expect(second.verify!.status).toBe(200);
    expect(mockState.shahkarCalls).toBe(1);

    const enrolled = await pool.query('SELECT app_enrolled_at FROM users WHERE id = $1', [r.id]);
    expect(enrolled.rows[0].app_enrolled_at).not.toBeNull();
    const log = await pool.query('SELECT context, matched, national_code_masked FROM shahkar_inquiries');
    expect(log.rows).toEqual([{ context: 'app_enroll', matched: true, national_code_masked: expect.stringMatching(/^\d{3}\*{4}\d{3}$/) }]);
  });

  it('treats a new device as an initial sign-in (Shahkar again)', async () => {
    const r = await staff(['responder'], { console: false });
    await appLogin(r.nationalCode, r.mobile, 'device-AAAA');
    const other = await appLogin(r.nationalCode, r.mobile, 'device-BBBB');
    expect(other.start.body.firstLogin).toBe(true);
    expect(mockState.shahkarCalls).toBe(2);
  });

  it('re-runs Shahkar when the last match is older than the re-verification period', async () => {
    const r = await staff(['responder'], { console: false });
    await appLogin(r.nationalCode, r.mobile);
    await pool.query(`UPDATE users SET shahkar_verified_at = now() - interval '400 days' WHERE id = $1`, [r.id]);
    const again = await appLogin(r.nationalCode, r.mobile);
    expect(again.start.body.firstLogin).toBe(true);
  });

  it('refuses the sign-in and sends no OTP when Shahkar does not match', async () => {
    const r = await staff(['responder'], { console: false });
    mockState.mismatches.add(`${r.nationalCode}:${r.mobile}`);
    const res = await api().post('/api/app/auth/start').send({ nationalCode: r.nationalCode, mobile: r.mobile, deviceId: 'device-0001' });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('shahkar_mismatch');
    expect(mockState.sent.size).toBe(0);
    const audit = await pool.query(`SELECT outcome FROM audit_log WHERE action = 'shahkar.mismatch'`);
    expect(audit.rows).toHaveLength(1);
  });

  it('fails closed when Shahkar is unavailable', async () => {
    const r = await staff(['responder'], { console: false });
    mockState.shahkarDown = true;
    const res = await api().post('/api/app/auth/start').send({ nationalCode: r.nationalCode, mobile: r.mobile, deviceId: 'device-0001' });
    expect(res.status).toBe(502);
    expect(mockState.sent.size).toBe(0);
  });

  it('rejects a staff mobile that differs from the registered one', async () => {
    const r = await staff(['responder'], { console: false });
    const res = await api().post('/api/app/auth/start').send({ nationalCode: r.nationalCode, mobile: mobile(), deviceId: 'device-0001' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('identity_mismatch');
  });

  it('validates national code checksum and mobile format', async () => {
    const res = await api().post('/api/app/auth/start').send({ nationalCode: '1234567890', mobile: '0912', deviceId: 'device-0001' });
    expect(res.status).toBe(400);
    expect(res.body.error.details.map((d: { path: string }) => d.path).sort()).toEqual(['mobile', 'nationalCode']);
  });

  it('lets a citizen self-enrol (Shahkar + OTP + name) with the citizen role only', async () => {
    const nc = nationalCode();
    const m = mobile();
    const noName = await appLogin(nc, m);
    expect(noName.start.body.firstLogin).toBe(true);
    expect(noName.verify!.status).toBe(400);
    expect(noName.verify!.body.error.code).toBe('profile_required');

    const challengeId = noName.start.body.challengeId;
    const ok = await api().post('/api/app/auth/verify').send({ challengeId, code: mockState.sent.get(m), deviceId: 'device-0001', firstName: 'لیلا', lastName: 'کاظمی' });
    expect(ok.status).toBe(200);
    const me = await api().get('/api/app/me').set(bearer(ok.body.accessToken));
    expect(me.body.kind).toBe('citizen');
    expect(me.body.roles.map((r: { key: string }) => r.key)).toEqual(['citizen']);
    expect(me.body.permissions).toEqual(['alerts.read', 'app.access', 'incidents.read', 'incidents.report']);
  });

  it('burns the OTP after too many wrong attempts', async () => {
    const r = await staff(['responder'], { console: false });
    const s = await api().post('/api/app/auth/start').send({ nationalCode: r.nationalCode, mobile: r.mobile, deviceId: 'device-0001' });
    for (let i = 0; i < 5; i++) {
      const bad = await api().post('/api/app/auth/verify').send({ challengeId: s.body.challengeId, code: '000000' === mockState.sent.get(r.mobile) ? '111111' : '000000', deviceId: 'device-0001' });
      expect(bad.status).toBe(400);
    }
    const good = await api().post('/api/app/auth/verify').send({ challengeId: s.body.challengeId, code: mockState.sent.get(r.mobile), deviceId: 'device-0001' });
    expect(good.status).toBe(400);
  });

  it('binds the OTP to the device that requested it and rejects reuse', async () => {
    const r = await staff(['responder'], { console: false });
    const s = await api().post('/api/app/auth/start').send({ nationalCode: r.nationalCode, mobile: r.mobile, deviceId: 'device-0001' });
    const code = mockState.sent.get(r.mobile);
    const wrongDevice = await api().post('/api/app/auth/verify').send({ challengeId: s.body.challengeId, code, deviceId: 'device-9999' });
    expect(wrongDevice.status).toBe(401);
    const ok = await api().post('/api/app/auth/verify').send({ challengeId: s.body.challengeId, code, deviceId: 'device-0001' });
    expect(ok.status).toBe(200);
    const replay = await api().post('/api/app/auth/verify').send({ challengeId: s.body.challengeId, code, deviceId: 'device-0001' });
    expect(replay.status).toBe(400);
  });

  it('denies app sign-in to roles without app access and app tokens on the console API', async () => {
    const admin = await staff(['security_admin']);
    const denied = await api().post('/api/app/auth/start').send({ nationalCode: admin.nationalCode, mobile: admin.mobile, deviceId: 'device-0001' });
    expect(denied.status).toBe(403);

    const r = await staff(['responder'], { console: false });
    const { verify } = await appLogin(r.nationalCode, r.mobile);
    const res = await api().get('/api/console/users').set(bearer(verify!.body.accessToken));
    expect(res.status).toBe(401);
  });

  it('rotates refresh tokens and revokes the session when an old one is replayed', async () => {
    const r = await staff(['responder'], { console: false });
    const { verify } = await appLogin(r.nationalCode, r.mobile);
    const rt1 = verify!.body.refreshToken;
    const rot = await api().post('/api/app/auth/refresh').send({ refreshToken: rt1 });
    expect(rot.status).toBe(200);
    const replay = await api().post('/api/app/auth/refresh').send({ refreshToken: rt1 });
    expect(replay.status).toBe(401);
    const after = await api().get('/api/app/me').set(bearer(rot.body.accessToken));
    expect(after.status).toBe(401);
  });
});
