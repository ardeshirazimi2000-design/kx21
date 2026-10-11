/** Tests for the AFTA protection profile (network-based application software, v1.1) requirements. */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { pool } from '../src/db/pool.js';
import { mockState } from '../src/integrations/apiir.js';
import { invalidateSettings, setSetting } from '../src/security/settings.js';
import { checkAuditCapacity } from '../src/services/auditStorage.js';
import { api, appLogin, bearer, consoleLogin, deviceTokens, PASSWORD, resetDb, staff } from './helpers.js';

beforeEach(resetDb);
afterAll(() => pool.end());

async function set(key: string, value: unknown) {
  const admin = (await pool.query(`SELECT id FROM users LIMIT 1`)).rows[0]?.id ?? (await staff(['observer'])).id;
  await setSetting(pool, key, value, admin);
  invalidateSettings();
}

async function incident(t: string) {
  const r = await api().post('/api/console/incidents').set(bearer(t)).send({ title: 'آتش‌سوزی انبار', type: 'fire', districtId: 1 });
  expect(r.status).toBe(201);
  return r.body.id as string;
}

describe('FAU: audit generation, review, protection', () => {
  it('records who, when, what, outcome, IP, client and severity (FAU_GEN.1.2) and chains records (FAU_STG.1.2)', async () => {
    const op = await staff(['operator']);
    await consoleLogin(op.username!);
    const row = (await pool.query(`SELECT * FROM audit_log WHERE action = 'console.login' ORDER BY id DESC LIMIT 1`)).rows[0];
    expect(row).toMatchObject({ actor_id: op.id, actor_name: op.username, outcome: 'success', channel: 'console', severity: 'low' });
    expect(row.ip).toBeTruthy();
    expect(row.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(row.prev_hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('lets only the auditor filter and sort the trail (FAU_SAR.2/3)', async () => {
    const auditor = await staff(['security_auditor']);
    const op = await staff(['operator']);
    await api().post('/api/console/auth/login').send({ username: op.username, password: 'wrong' });
    const t = await consoleLogin(auditor.username!);
    const r = await api().get('/api/console/security/audit?outcome=failure&channel=console&sort=severity_desc').set(bearer(t));
    expect(r.status).toBe(200);
    expect(r.body.length).toBeGreaterThan(0);
    expect(r.body.every((e: { outcome: string }) => e.outcome === 'failure')).toBe(true);
    const ot = await consoleLogin(op.username!);
    expect((await api().get('/api/console/security/audit').set(bearer(ot))).status).toBe(403);
  });

  it('detects tampering with audit records and with incident records (FAU_STG.1.2, FDP_SDI.2)', async () => {
    const auditor = await staff(['security_auditor']);
    const op = await staff(['operator']);
    const top = await consoleLogin(op.username!);
    const id = await incident(top);
    const t = await consoleLogin(auditor.username!);
    const clean = await api().post('/api/console/security/integrity/check').set(bearer(t));
    expect(clean.body.audit.ok).toBe(true);
    expect(clean.body.incidents.violations).toEqual([]);

    // Someone with database access edits records behind the application's back.
    await pool.query(`UPDATE incidents SET title = 'دستکاری' WHERE id = $1`, [id]);
    await pool.query('ALTER TABLE audit_log DISABLE TRIGGER audit_log_no_update');
    await pool.query(`UPDATE audit_log SET actor_name = 'someone-else' WHERE id = (SELECT min(id) FROM audit_log)`);
    await pool.query('ALTER TABLE audit_log ENABLE TRIGGER audit_log_no_update');

    const dirty = await api().post('/api/console/security/integrity/check').set(bearer(t));
    expect(dirty.body.incidents.violations).toEqual([id]);
    expect(dirty.body.audit.ok).toBe(false);
    expect((await pool.query('SELECT integrity_ok FROM incidents WHERE id = $1', [id])).rows[0].integrity_ok).toBe(false);
    const notes = await api().get('/api/console/security/notifications').set(bearer(t));
    expect(notes.body.map((n: { kind: string }) => n.kind).sort()).toEqual(['integrity.audit', 'integrity.incidents']);
    expect(mockState.serviceSms.length).toBeGreaterThan(0);
  });

  it('lets the auditor switch off operational events only (FAU_SEL.1)', async () => {
    const auditor = await staff(['security_auditor']);
    const t = await consoleLogin(auditor.username!);
    expect((await api().put('/api/console/security/settings/audit.disabledEvents').set(bearer(t)).send({ value: ['console.login'] })).status).toBe(400);
    expect((await api().put('/api/console/security/settings/audit.disabledEvents').set(bearer(t)).send({ value: ['incident.view'] })).status).toBe(200);
    const op = await staff(['operator']);
    const top = await consoleLogin(op.username!);
    const id = await incident(top);
    await api().get(`/api/console/incidents/${id}`).set(bearer(top)).expect(200);
    expect((await pool.query(`SELECT count(*)::int AS n FROM audit_log WHERE action = 'incident.view'`)).rows[0].n).toBe(0);
    expect((await pool.query(`SELECT count(*)::int AS n FROM audit_log WHERE action = 'audit.config'`)).rows[0].n).toBe(1);
  });

  it('warns, then blocks non-administrators when the trail is full, until the auditor exports and archives (FAU_STG.3/4)', async () => {
    const auditor = await staff(['security_auditor']);
    const op = await staff(['operator']);
    const top = await consoleLogin(op.username!);
    const ta = await consoleLogin(auditor.username!);
    await set('audit.warnRows', 1000);
    await set('audit.maxRows', 1001);
    await pool.query(`INSERT INTO audit_log (action, details) SELECT 'filler', '{}'::jsonb FROM generate_series(1, 1000)`);
    const cap = await checkAuditCapacity();
    expect(cap.full).toBe(true);
    expect((await api().get('/api/console/incidents').set(bearer(top))).status).toBe(503);
    expect(mockState.serviceSms.some((m) => m.message.includes('ممیزی'))).toBe(true);

    // The auditor can still act: export the oldest rows, then archive them with the digest of the kept file.
    const exp = await api().post('/api/console/security/audit/export').set(bearer(ta)).send({ limit: 900 });
    expect(exp.status).toBe(200);
    expect(exp.body.meta).toMatchObject({ rows: 900, classification: 'محرمانه' });
    const arc = await api().post('/api/console/security/audit/archive').set(bearer(ta)).send({ exportId: exp.body.exportId, sha256: exp.body.meta.sha256 });
    // The filler rows were inserted without a chain, so archiving is refused until the trail is verified.
    expect(arc.status).toBe(409);
  });

  it('archives exported audit rows and keeps the remaining chain verifiable', async () => {
    const auditor = await staff(['security_auditor']);
    const ta = await consoleLogin(auditor.username!);
    const before = Number((await pool.query('SELECT count(*) FROM audit_log')).rows[0].count);
    const exp = await api().post('/api/console/security/audit/export').set(bearer(ta)).send({ limit: 3 });
    const wrong = await api().post('/api/console/security/audit/archive').set(bearer(ta)).send({ exportId: exp.body.exportId, sha256: '0'.repeat(64) });
    expect(wrong.status).toBe(400);
    const arc = await api().post('/api/console/security/audit/archive').set(bearer(ta)).send({ exportId: exp.body.exportId, sha256: exp.body.meta.sha256 });
    expect(arc.status).toBe(200);
    expect(arc.body.archived).toBe(exp.body.meta.rows);
    const after = Number((await pool.query('SELECT count(*) FROM audit_log')).rows[0].count);
    expect(after).toBe(before - exp.body.meta.rows + 2); // + the export and archive events
    const check = await api().post('/api/console/security/integrity/check').set(bearer(ta));
    expect(check.body.audit.ok).toBe(true);
  });
});

describe('FMT: security management', () => {
  it('splits settings between the security administrator and the auditor, and audits every change (FMT_MOF/FMT_SMF)', async () => {
    const admin = await staff(['security_admin']);
    const t = await consoleLogin(admin.username!);
    const list = await api().get('/api/console/security/settings').set(bearer(t));
    expect(list.body.settings.find((s: { key: string }) => s.key === 'lockout.threshold').managedBy).toBe('settings.manage');
    expect((await api().put('/api/console/security/settings/lockout.threshold').set(bearer(t)).send({ value: 1 })).status).toBe(400);
    const ok = await api().put('/api/console/security/settings/lockout.threshold').set(bearer(t)).send({ value: 4 });
    expect(ok.body).toMatchObject({ before: 5, after: 4 });
    expect((await api().put('/api/console/security/settings/audit.fullAction').set(bearer(t)).send({ value: 'alert' })).status).toBe(403);
    const ev = (await pool.query(`SELECT details FROM audit_log WHERE action = 'settings.update'`)).rows[0];
    expect(ev.details).toMatchObject({ before: 5, after: 4 });
  });

  it('refuses a console network restriction that would lock out the administrator applying it', async () => {
    const admin = await staff(['security_admin']);
    const t = await consoleLogin(admin.username!);
    const r = await api().put('/api/console/security/settings/access.consoleCidrs').set(bearer(t)).send({ value: ['10.0.0.0/8'] });
    expect(r.status).toBe(400);
  });

  it('applies the configured password policy and audits rejected passwords (FIA_PMG_EXT.1)', async () => {
    await set('password.minLength', 16);
    const op = await staff(['operator']);
    const t = await consoleLogin(op.username!);
    const r = await api().post('/api/console/auth/change-password').set(bearer(t)).send({ currentPassword: PASSWORD, newPassword: 'Short-Pass-12!' });
    expect(r.status).toBe(400);
    expect((await pool.query(`SELECT count(*)::int AS n FROM audit_log WHERE action = 'password.rejected'`)).rows[0].n).toBe(1);
  });
});

describe('FIA: identification and authentication', () => {
  it('locks after the configured threshold, longer each time (FIA_AFL.1)', async () => {
    await set('lockout.threshold', 3);
    const op = await staff(['operator']);
    for (let i = 0; i < 3; i++) await api().post('/api/console/auth/login').send({ username: op.username, password: 'wrong' });
    expect((await api().post('/api/console/auth/login').send({ username: op.username, password: PASSWORD })).status).toBe(423);
    const first = (await pool.query(`SELECT lock_count, locked_until - now() AS left FROM users WHERE id = $1`, [op.id])).rows[0];
    await pool.query(`UPDATE users SET locked_until = now() - interval '1 second' WHERE id = $1`, [op.id]);
    for (let i = 0; i < 3; i++) await api().post('/api/console/auth/login').send({ username: op.username, password: 'wrong' });
    const second = (await pool.query(`SELECT lock_count, EXTRACT(EPOCH FROM locked_until - now()) AS left FROM users WHERE id = $1`, [op.id])).rows[0];
    expect(first.lock_count).toBe(1);
    expect(second.lock_count).toBe(2);
    expect(Number(second.left)).toBeGreaterThan(25 * 60); // 15 → 30 minutes
  });

  it('counts wrong app OTPs against the account too', async () => {
    await set('lockout.threshold', 3);
    const r = await staff(['responder'], { console: false });
    for (let i = 0; i < 3; i++) {
      const s = await api().post('/api/app/auth/start').send({ nationalCode: r.nationalCode, mobile: r.mobile, deviceId: 'device-0001' });
      const wrong = mockState.sent.get(r.mobile) === '000000' ? '111111' : '000000';
      await api().post('/api/app/auth/verify').send({ challengeId: s.body.challengeId, code: wrong, deviceId: 'device-0001' });
    }
    const locked = await api().post('/api/app/auth/start').send({ nationalCode: r.nationalCode, mobile: r.mobile, deviceId: 'device-0001' });
    expect(locked.status).toBe(423);
  });

  it('allows OTP-only sign-in only from a device holding its server-issued token (FIA_UAU.5.2)', async () => {
    const r = await staff(['responder'], { console: false });
    await appLogin(r.nationalCode, r.mobile, 'device-AAAA');
    const shahkarCalls = mockState.shahkarCalls;
    // Same device id but without the secret (e.g. copied id): treated as a new device → Shahkar again.
    const spoof = await api().post('/api/app/auth/start').send({ nationalCode: r.nationalCode, mobile: r.mobile, deviceId: 'device-AAAA', deviceToken: 'guess' });
    expect(spoof.body.firstLogin).toBe(true);
    expect(mockState.shahkarCalls).toBe(shahkarCalls + 1);
    await new Promise((res) => setTimeout(res, 5));
    const genuine = await api().post('/api/app/auth/start').send({ nationalCode: r.nationalCode, mobile: r.mobile, deviceId: 'device-AAAA', deviceToken: deviceTokens.get(`${r.nationalCode}:device-AAAA`) });
    expect(genuine.body.firstLogin).toBe(false);
  });

  it('shows the last successful and failed sign-in with the failure count (FTA_TAH.1)', async () => {
    const op = await staff(['operator']);
    await consoleLogin(op.username!);
    await api().post('/api/console/auth/login').send({ username: op.username, password: 'wrong' });
    await api().post('/api/console/auth/login').send({ username: op.username, password: 'wrong' });
    const t = await consoleLogin(op.username!);
    const me = await api().get('/api/console/me').set(bearer(t));
    expect(me.body.accessHistory).toMatchObject({ failuresSinceLastSuccess: 2, lastSuccessAt: expect.any(String), lastFailureAt: expect.any(String) });
  });
});

describe('FTA / FIA_USB: sessions', () => {
  it('replaces the older console session and tells it why (FTA_MCS.1, FIA_USB.1.2)', async () => {
    const op = await staff(['operator']);
    const first = await consoleLogin(op.username!);
    const second = await consoleLogin(op.username!);
    const old = await api().get('/api/console/incidents').set(bearer(first));
    expect(old.status).toBe(401);
    expect(old.body.error.code).toBe('session_replaced');
    expect((await api().get('/api/console/incidents').set(bearer(second))).status).toBe(200);
  });

  it('can deny a session beyond the limit instead (FDP_ACF.1.4)', async () => {
    await set('sessions.limitAction', 'deny');
    const op = await staff(['operator']);
    await consoleLogin(op.username!);
    await expect(consoleLogin(op.username!)).rejects.toThrow(/verify 409/);
  });

  it('ends a session whose token is replayed from another browser (FIA_USB.1.3)', async () => {
    const op = await staff(['operator']);
    const t = await consoleLogin(op.username!);
    const r = await api().get('/api/console/incidents').set(bearer(t)).set('User-Agent', 'OtherBrowser/1.0');
    expect(r.status).toBe(401);
    expect((await api().get('/api/console/incidents').set(bearer(t))).status).toBe(401);
    expect((await pool.query(`SELECT count(*)::int AS n FROM audit_log WHERE action = 'session.hijack_suspected'`)).rows[0].n).toBe(1);
  });

  it('terminates idle console sessions (FTA_SSL.3)', async () => {
    const op = await staff(['operator']);
    const t = await consoleLogin(op.username!);
    await pool.query(`UPDATE sessions SET last_seen_at = now() - interval '31 minutes' WHERE user_id = $1`, [op.id]);
    const r = await api().get('/api/console/incidents').set(bearer(t));
    expect(r.status).toBe(401);
    expect((await pool.query(`SELECT count(*)::int AS n FROM audit_log WHERE action = 'session.idle_timeout'`)).rows[0].n).toBe(1);
  });

  it('refuses console sessions from disallowed networks or days (FTA_TSE.1)', async () => {
    const op = await staff(['operator']);
    await set('access.consoleCidrs', ['10.0.0.0/8']);
    const net = await api().post('/api/console/auth/login').send({ username: op.username, password: PASSWORD });
    expect(net.status).toBe(403);
    expect(net.body.error.code).toBe('session_not_allowed');
    await set('access.consoleCidrs', ['127.0.0.1', '::1']);
    const today = new Date().toLocaleString('en-US', { timeZone: 'Asia/Tehran', weekday: 'short' });
    const day = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(today);
    await set('access.consoleDays', [(day + 1) % 7]);
    expect((await api().post('/api/console/auth/login').send({ username: op.username, password: PASSWORD })).status).toBe(403);
  });
});

describe('FDP: export and public information', () => {
  it('exports incidents with security attributes, only for permitted roles and only when enabled (FDP_ETC.2)', async () => {
    const dir = await staff(['crisis_director']);
    const op = await staff(['operator']);
    const td = await consoleLogin(dir.username!);
    const top = await consoleLogin(op.username!);
    await incident(td);
    expect((await api().get('/api/console/export/incidents').set(bearer(top))).status).toBe(403);
    const r = await api().get('/api/console/export/incidents').set(bearer(td));
    expect(r.status).toBe(200);
    expect(r.body.meta).toMatchObject({ rows: 1, classification: 'محرمانه', sha256: expect.stringMatching(/^[0-9a-f]{64}$/), signature: expect.any(String) });
    const csv = await api().get('/api/console/export/incidents?format=csv').set(bearer(td));
    expect(csv.headers['content-type']).toContain('text/csv');
    expect(csv.headers['x-export-sha256']).toMatch(/^[0-9a-f]{64}$/);
    await set('export.enabled', false);
    expect((await api().get('/api/console/export/incidents').set(bearer(td))).status).toBe(403);
    expect((await pool.query(`SELECT count(*)::int AS n FROM audit_log WHERE action = 'data.export'`)).rows[0].n).toBe(2);
  });

  it('serves only public alerts without authentication and plain 404s elsewhere (FDP_ACF.1.3)', async () => {
    const pub = await api().get('/api/public/alerts');
    expect(pub.status).toBe(200);
    const nf = await api().get('/nothing-here');
    expect(nf.status).toBe(404);
    expect(nf.text).not.toMatch(/express|Cannot GET/i);
    expect(nf.headers['x-powered-by']).toBeUndefined();
  });
});
