import { mkdtemp, readFile, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { pool } from '../src/db/pool.js';
import { seed, SEED_PASSWORD } from '../src/db/seed.js';
import { setPbxAdapter, type PbxAdapter } from '../src/services/pbx.js';
import { DEFAULT_IVR, renderDialplan, wavProblem, writePbxConfig, type IvrSettings } from '../src/services/pbxConfig.js';

const app = createApp();
const tokens: Record<string, string> = {};
const me: Record<string, any> = {};
const auth = (who: string) => ({ authorization: `Bearer ${tokens[who]}` });

const fake: PbxAdapter = {
  kind: 'asterisk-ami',
  configured: true,
  connected: () => true,
  async provisionExtension() {},
  async disableExtension() {},
  async sync() {},
  async originate() {},
};

/** A WAV header + silence. */
function wav(o: { rate?: number; channels?: number; bits?: number; format?: number; seconds?: number } = {}) {
  const rate = o.rate ?? 8000;
  const channels = o.channels ?? 1;
  const bits = o.bits ?? 16;
  const data = Math.round((o.seconds ?? 1) * rate * channels * (bits / 8));
  const b = Buffer.alloc(44 + data);
  b.write('RIFF', 0, 'ascii');
  b.writeUInt32LE(36 + data, 4);
  b.write('WAVE', 8, 'ascii');
  b.write('fmt ', 12, 'ascii');
  b.writeUInt32LE(16, 16);
  b.writeUInt16LE(o.format ?? 1, 20);
  b.writeUInt16LE(channels, 22);
  b.writeUInt32LE(rate, 24);
  b.writeUInt32LE((rate * channels * bits) / 8, 28);
  b.writeUInt16LE((channels * bits) / 8, 32);
  b.writeUInt16LE(bits, 34);
  b.write('data', 36, 'ascii');
  b.writeUInt32LE(data, 40);
  return b;
}

const exts = [
  { number: '201', name: 'الف', secret: 'x'.repeat(24), external: false },
  { number: '202', name: 'ب', secret: 'y'.repeat(24), external: false },
];
const ivr = (o: Partial<IvrSettings> = {}): IvrSettings => ({ ...DEFAULT_IVR, enabled: true, ...o });
const settings = {
  enabled: true,
  options: [
    { digit: '1', label: 'دبیرخانه', targets: ['301', '302'] },
    { digit: '2', label: 'مالی', targets: ['303'] },
  ],
  directDial: true,
  waitSeconds: 6,
  ringSeconds: 30,
  workHours: { days: ['mon', 'sat', 'sun'], start: '08:00', end: '15:30' },
  afterHoursEnabled: true,
};

beforeAll(async () => {
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await seed();
  for (const u of ['it', 'expert', 'deputy', 'cmsexpert']) {
    const r = await request(app).post('/api/auth/login').send({ identifier: u, password: SEED_PASSWORD });
    tokens[u] = r.body.accessToken;
    me[u] = (await request(app).get('/api/auth/me').set(auth(u))).body;
  }
  for (const [u, n] of [
    ['deputy', '301'],
    ['expert', '302'],
    ['cmsexpert', '303'],
  ]) {
    const r = await request(app).post('/api/communications/extensions').set(auth('it')).send({ userId: me[u].id, extensionNumber: n, existsOnPbx: true });
    expect(r.status).toBe(201);
  }
  setPbxAdapter(fake);
});

afterAll(async () => {
  setPbxAdapter(null);
  await pool.end();
});

describe('auto-attendant dial plan', () => {
  it('off, or on without a greeting: city-line calls ring the inbound targets as before', () => {
    const plain = renderDialplan(exts, { targets: ['201'], ringSeconds: 30 });
    expect(renderDialplan(exts, { targets: ['201'], ringSeconds: 30 }, ivr(), [])).toBe(plain);
    expect(plain).toContain('exten => s,1,Dial(PJSIP/201,30)');
    expect(plain).not.toContain('*99');
  });

  it('greeting, options, direct dial to extensions, timeout to the operator, invalid key retried', () => {
    const d = renderDialplan(
      exts,
      { targets: ['201'], ringSeconds: 25 },
      ivr({
        options: [
          { digit: '1', label: 'دبیرخانه; [x]', targets: ['201', '202', '999'] },
          { digit: '2', label: 'nobody', targets: ['999'] },
        ],
      }),
      ['greeting'],
    );
    const inbound = d.slice(d.indexOf('[rasa-inbound]'));
    expect(inbound).toContain('exten => s,1(open),Answer()');
    expect(inbound).toContain(' same => n(menu),Background(/etc/asterisk/rasa/sounds/greeting)');
    expect(inbound).toContain(' same => n,WaitExten(5)');
    expect(inbound).toContain('; دبیرخانه x');
    expect(inbound).toContain('exten => 1,1,Dial(PJSIP/201&PJSIP/202,40)');
    expect(inbound).not.toMatch(/exten => 2,/); // no live target: not offered
    expect(inbound).not.toContain('999');
    expect(inbound).toContain('exten => 202,1,Dial(PJSIP/202,40)');
    expect(inbound).toContain('exten => t,1,Dial(PJSIP/201,25)');
    expect(inbound).toContain('GotoIf($[${RASA_TRIES} < 3]?s,menu)');
    expect(inbound).not.toContain('GotoIfTime');
    // Nothing reachable from the city line leads to the trunk.
    expect(inbound).not.toMatch(/rasa-trunk|rasa-outbound|rasa-external|Goto\(rasa-internal/);
    // Internal test number
    expect(d.slice(0, d.indexOf('[rasa-inbound]'))).toContain('exten => *99,1,Goto(rasa-inbound,s,1)');
  });

  it('without direct dial only the menu digits are dialable; no operator: polite message on timeout', () => {
    const d = renderDialplan(exts, { targets: [], ringSeconds: 40 }, ivr({ directDial: false, options: [{ digit: '1', label: '', targets: ['202'] }] }), [
      'greeting',
    ]);
    const inbound = d.slice(d.indexOf('[rasa-inbound]'));
    expect(inbound).not.toMatch(/exten => 20[12],/);
    expect(inbound).toContain('exten => t,1,Answer()\n same => n,Playback(ss-noservice)');
  });

  it('after hours: the closed message outside the work days and hours (Tehran time)', () => {
    const wh = { days: ['wed', 'sat', 'sun'] as any, start: '08:00', end: '16:30' };
    const d = renderDialplan(exts, { targets: ['201'], ringSeconds: 40 }, ivr({ afterHoursEnabled: true, workHours: wh }), ['greeting', 'closed']);
    expect(d).toContain('exten => s,1,GotoIfTime(08:00-16:30,sat&sun&wed,*,*,Asia/Tehran?open)');
    expect(d).toContain(' same => n,Playback(/etc/asterisk/rasa/sounds/closed)');
    expect(d).toContain(' same => n(open),Answer()');
    const noClosedSound = renderDialplan(exts, { targets: [], ringSeconds: 40 }, ivr({ afterHoursEnabled: true, workHours: wh }), ['greeting']);
    expect(noClosedSound).toContain(' same => n,Playback(ss-noservice)');
  });

  it('accepts only 8 kHz mono 16-bit PCM WAV', () => {
    expect(wavProblem(wav())).toBeNull();
    expect(wavProblem(wav({ rate: 44100 }))).not.toBeNull();
    expect(wavProblem(wav({ channels: 2 }))).not.toBeNull();
    expect(wavProblem(wav({ bits: 8 }))).not.toBeNull();
    expect(wavProblem(wav({ format: 3 }))).not.toBeNull();
    expect(wavProblem(wav({ seconds: 0.1 }))).not.toBeNull();
    expect(wavProblem(Buffer.from('ID3 not a wav at all, an mp3 maybe....................'))).not.toBeNull();
  });
});

describe('auto-attendant settings and prompts', () => {
  it('only settings managers; enabling needs a greeting; targets must be active extensions', async () => {
    expect((await request(app).get('/api/communications/settings/ivr').set(auth('expert'))).status).toBe(403);
    expect((await request(app).put('/api/communications/settings/ivr').set(auth('expert')).send(settings)).status).toBe(403);
    const g = await request(app).get('/api/communications/settings/ivr').set(auth('it'));
    expect(g.body.enabled).toBe(false);
    expect(g.body.sounds).toEqual({});
    expect(g.body.extensions.map((e: any) => e.number)).toEqual(['301', '302', '303']);
    const r = await request(app).put('/api/communications/settings/ivr').set(auth('it')).send(settings);
    expect(r.status).toBe(400);
    expect(r.body.error.message).toContain('پیام خوشامد');
    const bad = (o: object) =>
      request(app)
        .put('/api/communications/settings/ivr')
        .set(auth('it'))
        .send({ ...settings, enabled: false, ...o });
    expect((await bad({ options: [{ digit: '1', label: '', targets: ['999'] }] })).status).toBe(400);
    expect(
      (
        await bad({
          options: [
            { digit: '1', label: '', targets: ['301'] },
            { digit: '1', label: '', targets: ['302'] },
          ],
        })
      ).status,
    ).toBe(400);
    expect((await bad({ options: [{ digit: '*', label: '', targets: ['301'] }] })).status).toBe(400);
    expect((await bad({ workHours: { days: ['sat'], start: '16:00', end: '08:00' } })).status).toBe(400);
  });

  it('prompts: validated, stored, previewed, audited; then the auto-attendant turns on and its files are written', async () => {
    const put = (who: string, kind: string, data: Buffer) =>
      request(app).put(`/api/communications/ivr/sounds/${kind}`).set(auth(who)).set('content-type', 'audio/wav').send(data);
    expect((await put('expert', 'greeting', wav())).status).toBe(403);
    expect((await put('it', 'other', wav())).status).toBe(404);
    expect((await put('it', 'greeting', wav({ rate: 48000 }))).status).toBe(400);
    expect((await request(app).put('/api/communications/ivr/sounds/greeting').set(auth('it')).send({ a: 1 })).status).toBe(400);
    const ok = await put('it', 'greeting', wav({ seconds: 4 }));
    expect(ok.status).toBe(200);
    expect(ok.body.seconds).toBe(4);
    expect((await put('it', 'closed', wav({ seconds: 2 }))).status).toBe(200);
    const play = await request(app).get('/api/communications/ivr/sounds/greeting').set(auth('it'));
    expect(play.headers['content-type']).toBe('audio/wav');
    expect(Buffer.compare(play.body, wav({ seconds: 4 }))).toBe(0);

    const r = await request(app).put('/api/communications/settings/ivr').set(auth('it')).send(settings);
    expect(r.status).toBe(200);
    expect(r.body.workHours.days).toEqual(['sat', 'sun', 'mon']);
    const g = (await request(app).get('/api/communications/settings/ivr').set(auth('it'))).body;
    expect(g.enabled).toBe(true);
    expect(Object.keys(g.sounds).sort()).toEqual(['closed', 'greeting']);
    expect((await request(app).delete('/api/communications/ivr/sounds/greeting').set(auth('it'))).status).toBe(400);

    const dir = await mkdtemp(path.join(os.tmpdir(), 'rasa-pbx-'));
    await writePbxConfig(dir);
    const plan = await readFile(path.join(dir, 'extensions_rasa.conf'), 'utf8');
    expect(plan).toContain('exten => 1,1,Dial(PJSIP/301&PJSIP/302,30)');
    expect(plan).toContain('exten => 2,1,Dial(PJSIP/303,30)');
    expect(plan).toContain('GotoIfTime(08:00-15:30,sat&sun&mon,*,*,Asia/Tehran?open)');
    const greeting = await readFile(path.join(dir, 'sounds', 'greeting.wav'));
    expect(Buffer.compare(greeting, wav({ seconds: 4 }))).toBe(0);
    expect((await stat(path.join(dir, 'sounds', 'closed.wav'))).mode & 0o777).toBe(0o640);

    expect((await request(app).delete('/api/communications/ivr/sounds/closed').set(auth('it'))).status).toBe(204);
    await writePbxConfig(dir);
    await expect(stat(path.join(dir, 'sounds', 'closed.wav'))).rejects.toThrow();
    expect(await readFile(path.join(dir, 'extensions_rasa.conf'), 'utf8')).toContain(' same => n,Playback(ss-noservice)');

    const a = await pool.query(
      `SELECT action, after::text AS after FROM audit_logs WHERE entity IN ('communication_sounds', 'communication_settings') ORDER BY created_at, id`,
    );
    expect(a.rows.map((x) => x.action)).toEqual([
      'communications.sound_uploaded',
      'communications.sound_uploaded',
      'communications.settings_updated',
      'communications.sound_deleted',
    ]);
    for (const x of a.rows) expect((x.after ?? '').length).toBeLessThan(2000); // no audio in the audit trail
  });
});
