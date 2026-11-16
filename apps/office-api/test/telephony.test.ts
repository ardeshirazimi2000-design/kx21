import { mkdtemp, readFile, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { pool } from '../src/db/pool.js';
import { seed, SEED_PASSWORD } from '../src/db/seed.js';
import { endpointOf, handleAmiEvent } from '../src/services/pbxAsterisk.js';
import { renderDialplan, renderPjsip, writePbxConfig } from '../src/services/pbxConfig.js';
import { setPbxAdapter, type PbxAdapter } from '../src/services/pbx.js';

const app = createApp();
const tokens: Record<string, string> = {};
const me: Record<string, any> = {};
const as = (who: string) => ({
  get: (url: string) => request(app).get(url).set('authorization', `Bearer ${tokens[who]}`),
  post: (url: string, body: object = {}) => request(app).post(url).set('authorization', `Bearer ${tokens[who]}`).send(body),
  put: (url: string, body: object = {}) => request(app).put(url).set('authorization', `Bearer ${tokens[who]}`).send(body),
  patch: (url: string, body: object = {}) => request(app).patch(url).set('authorization', `Bearer ${tokens[who]}`).send(body),
});

const originated: any[] = [];
let syncs = 0;
let up = true;
const fake: PbxAdapter = {
  kind: 'asterisk-ami',
  configured: true,
  connected: () => up,
  async provisionExtension() {},
  async disableExtension() {},
  async sync() {
    syncs++;
  },
  async originate(o) {
    originated.push(o);
  },
};

const ext: Record<string, string> = {};

beforeAll(async () => {
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await seed();
  for (const u of ['admin', 'it', 'reshead', 'expert', 'cmsexpert', 'deputy']) {
    const r = await request(app).post('/api/auth/login').send({ identifier: u, password: SEED_PASSWORD });
    tokens[u] = r.body.accessToken;
    me[u] = (await as(u).get('/api/auth/me')).body;
  }
  // deputy (manager role) may call the city line; expert may not
  for (const [u, n] of [
    ['deputy', '301'],
    ['expert', '302'],
    ['cmsexpert', '303'],
  ]) {
    const r = await as('it').post('/api/communications/extensions', { userId: me[u].id, extensionNumber: n, existsOnPbx: true });
    expect(r.status).toBe(201);
    ext[u] = r.body.id;
  }
  setPbxAdapter(fake);
});

afterAll(async () => {
  setPbxAdapter(null);
  await pool.end();
});

describe('generated PBX configuration', () => {
  it('one endpoint per live extension, with its own dial plan context; text is sanitised', () => {
    const conf = renderPjsip([
      { number: '301', name: 'مهندس "x"; [y]\nexten => 1,1,System(rm)', secret: 'A'.repeat(24), external: true },
      { number: '302', name: 'کارشناس', secret: 'B'.repeat(24), external: false },
      { number: '30a', name: 'bad number', secret: 'C'.repeat(24), external: false },
      { number: '304', name: 'weak secret', secret: 'short', external: false },
    ]);
    expect(conf).toContain('[301](rasa-endpoint)');
    expect(conf).toMatch(/\[301\]\(rasa-endpoint\)\ntype=endpoint\ncontext=rasa-external/);
    expect(conf).toMatch(/\[302\]\(rasa-endpoint\)\ntype=endpoint\ncontext=rasa-internal/);
    expect(conf).not.toContain('30a');
    expect(conf).not.toContain('[304]');
    // The name cannot break out of its line or the quoted value.
    const callerid = conf.split('\n').find((l) => l.startsWith('callerid=') && l.endsWith('<301>'))!;
    expect(callerid).not.toMatch(/[;[\]\n]/);
    expect(callerid.match(/"/g)).toHaveLength(2);
    expect(conf.split('\n').filter((l) => l.startsWith('exten'))).toHaveLength(0);
  });

  it('inbound rings only live targets, otherwise answers with a message', () => {
    const exts = [{ number: '301', name: 'a', secret: 'A'.repeat(24), external: false }];
    expect(renderDialplan(exts, { targets: ['301', '999'], ringSeconds: 500 })).toContain('exten => s,1,Dial(PJSIP/301,120)');
    const none = renderDialplan(exts, { targets: ['999'], ringSeconds: 40 });
    expect(none).toContain('Playback(ss-noservice)');
    expect(none).toContain('exten => 301,1,Dial(PJSIP/301,30)');
  });

  it('files hold live extensions only, secrets are generated once and stored encrypted', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'rasa-pbx-'));
    expect(await writePbxConfig(dir)).toEqual(['301', '302', '303']);
    const first = await readFile(path.join(dir, 'pjsip_extensions.conf'), 'utf8');
    expect((await stat(path.join(dir, 'pjsip_extensions.conf'))).mode & 0o777).toBe(0o640);
    expect(first).toMatch(/\[301\]\(rasa-endpoint\)\ntype=endpoint\ncontext=rasa-external/); // deputy: manager
    expect(first).toMatch(/\[302\]\(rasa-endpoint\)\ntype=endpoint\ncontext=rasa-internal/); // expert
    const { rows } = await pool.query(`SELECT sip_secret_enc FROM communication_extensions WHERE extension_number = '301'`);
    const pw = first.match(/\[301-auth\][^[]*password=([A-Za-z0-9]+)/)![1];
    expect(pw).toHaveLength(24);
    expect(rows[0].sip_secret_enc).not.toContain(pw);
    // Same secret next time; a suspended extension disappears.
    await as('it').patch(`/api/communications/extensions/${ext.cmsexpert}`, { status: 'suspended', reason: 'مرخصی' });
    expect(await writePbxConfig(dir)).toEqual(['301', '302']);
    const second = await readFile(path.join(dir, 'pjsip_extensions.conf'), 'utf8');
    expect(second).toContain(`password=${pw}`);
    expect(second).not.toContain('[303]');
    await as('it').patch(`/api/communications/extensions/${ext.cmsexpert}`, { status: 'active' });
  });
});

describe('extension credentials and settings', () => {
  it('a new SIP password is shown once to an extensions manager, never in other responses or the audit trail', async () => {
    expect((await as('expert').post(`/api/communications/extensions/${ext.expert}/credentials`)).status).toBe(403);
    const r = await as('it').post(`/api/communications/extensions/${ext.expert}/credentials`);
    expect(r.status).toBe(200);
    expect(r.headers['cache-control']).toBe('no-store');
    expect(r.body.username).toBe('302');
    expect(r.body.password).toMatch(/^[A-Za-z0-9]{24}$/);
    const list = await as('it').get('/api/communications/extensions');
    expect(JSON.stringify(list.body)).not.toContain('sip_secret');
    expect(JSON.stringify(list.body)).not.toContain(r.body.password);
    expect(JSON.stringify((await as('expert').get('/api/communications/extensions/mine')).body)).not.toContain('sip_secret');
    const audits = await pool.query(
      `SELECT coalesce(before::text, '') || coalesce(after::text, '') AS d FROM audit_logs WHERE entity = 'communication_extension'`,
    );
    for (const a of audits.rows) expect(a.d ?? '').not.toContain('sip_secret');
    expect(syncs).toBeGreaterThan(0);
  });

  it('inbound targets must be active extensions; only settings managers change them', async () => {
    expect((await as('expert').put('/api/communications/settings/inbound', { targets: ['301'] })).status).toBe(403);
    expect((await as('it').put('/api/communications/settings/inbound', { targets: ['999'] })).status).toBe(400);
    const r = await as('it').put('/api/communications/settings/inbound', { targets: ['301', '302', '301'], ringSeconds: 30 });
    expect(r.body).toEqual({ targets: ['301', '302'], ringSeconds: 30 });
    expect((await as('it').get('/api/communications/settings/inbound')).body).toEqual({ targets: ['301', '302'], ringSeconds: 30 });
    const a = await pool.query(`SELECT action FROM audit_logs WHERE entity = 'communication_settings'`);
    expect(a.rows.map((x) => x.action)).toEqual(['communications.settings_updated']);
  });
});

describe('click-to-call', () => {
  it('checks the destination and the right to use the city line', async () => {
    const call = (who: string, to: string) => as(who).post('/api/communications/calls/originate', { to });
    expect((await call('reshead', '301')).body.error.code).toBe('no_extension');
    expect((await call('expert', '302')).status).toBe(400); // own extension
    expect((await call('expert', '399')).status).toBe(400); // not an extension, no 9 prefix
    expect((await call('expert', '900123456789')).status).toBe(400); // international: never
    expect((await call('expert', '9118')).status).toBe(400); // premium short number
    expect((await call('expert', '922334455')).status).toBe(403); // no communications.call.external
    expect((await call('expert', '9115')).status).toBe(202); // emergency: always
    expect((await call('deputy', '909121234567')).status).toBe(202);
    const r = await call('expert', '301');
    expect(r.status).toBe(202);
    expect(originated.map((o) => [o.fromExtension, o.to])).toEqual([
      ['302', '9115'],
      ['301', '909121234567'],
      ['302', '301'],
    ]);
    // The row exists before any PBX event, with the number as dialled on the line.
    const rows = (
      await pool.query(`SELECT direction, caller_number, callee_number, callee_user_id, unique_call_id FROM communication_calls ORDER BY started_at`)
    ).rows;
    expect(rows.map((x) => [x.direction, x.caller_number, x.callee_number])).toEqual([
      ['outbound', '302', '115'],
      ['outbound', '301', '09121234567'],
      ['internal', '302', '301'],
    ]);
    expect(rows[2].callee_user_id).toBe(me.deputy.id);
    expect(rows[2].unique_call_id).toBe(originated[2].callId);
  });

  it('PBX down: a clear error, nothing dialled', async () => {
    up = false;
    try {
      const r = await as('expert').post('/api/communications/calls/originate', { to: '301' });
      expect(r.status).toBe(503);
      expect(originated).toHaveLength(3);
    } finally {
      up = true;
    }
  });
});

describe('call events from Asterisk', () => {
  const ev = (Event: string, f: Record<string, string>) => handleAmiEvent({ Event, ...f });

  it('reads endpoints from channel names', () => {
    expect(endpointOf('PJSIP/301-0000002a')).toBe('301');
    expect(endpointOf('PJSIP/rasa-trunk-000000ff')).toBe('rasa-trunk');
    expect(endpointOf('Local/301@x-00000001;1')).toBeNull();
  });

  it('an internal call: ringing, answered, ended — each event once even if replayed', async () => {
    const L = '1700000000.10';
    const events: [string, Record<string, string>][] = [
      ['Newchannel', { Channel: 'PJSIP/302-00000001', Uniqueid: L, Linkedid: L, CallerIDNum: '302', CallerIDName: 'کارشناس', Exten: '301' }],
      ['DialBegin', { Linkedid: L, DestChannel: 'PJSIP/301-00000002', DestUniqueid: '1700000000.11', DialString: '301' }],
      ['DialEnd', { Linkedid: L, DestChannel: 'PJSIP/301-00000002', DestUniqueid: '1700000000.11', DialStatus: 'ANSWER' }],
      ['Hangup', { Uniqueid: L, Linkedid: L, Cause: '16' }],
    ];
    for (const e of [...events, ...events]) await ev(...e);
    const c = (await pool.query('SELECT * FROM communication_calls WHERE unique_call_id = $1', [L])).rows[0];
    expect(c).toMatchObject({
      direction: 'internal',
      caller_number: '302',
      callee_number: '301',
      caller_user_id: me.expert.id,
      callee_user_id: me.deputy.id,
      disposition: 'answered',
    });
    expect(c.answered_at).not.toBeNull();
    const n = (await pool.query('SELECT event_type FROM communication_call_events WHERE call_id = $1 ORDER BY id', [c.id])).rows.map((r) => r.event_type);
    expect(n).toEqual(['started', 'ringing', 'answered', 'ended']);
  });

  it('a city-line call nobody answers is missed; it is visible to the extensions it rang', async () => {
    const L = '1700000001.20';
    await ev('Newchannel', {
      Channel: 'PJSIP/rasa-trunk-00000003',
      Uniqueid: L,
      Linkedid: L,
      CallerIDNum: '02188776655',
      CallerIDName: '<unknown>',
      Exten: 's',
    });
    await ev('DialBegin', { Linkedid: L, DestChannel: 'PJSIP/301-00000004', DestUniqueid: '1700000001.21' });
    await ev('DialBegin', { Linkedid: L, DestChannel: 'PJSIP/302-00000005', DestUniqueid: '1700000001.22' });
    await ev('Hangup', { Uniqueid: L, Linkedid: L, Cause: '16' });
    const c = (await pool.query('SELECT * FROM communication_calls WHERE unique_call_id = $1', [L])).rows[0];
    expect(c).toMatchObject({ direction: 'inbound', caller_number: '02188776655', caller_name: null, disposition: 'missed', duration_seconds: 0 });
    const mine = await as('deputy').get('/api/communications/calls');
    expect(mine.body.items.some((x: any) => x.id === c.id)).toBe(true);
    // Not part of the call: not in the list; everyone's calls need communications.report.view.
    expect((await as('cmsexpert').get('/api/communications/calls')).body.items.some((x: any) => x.id === c.id)).toBe(false);
    expect((await as('cmsexpert').get('/api/communications/calls?scope=all')).status).toBe(403);
    const all = await as('it').get('/api/communications/calls?scope=all&direction=inbound&disposition=missed');
    expect(all.body.items.map((x: any) => x.id)).toEqual([c.id]);
  });

  it('a phone registering updates the extension', async () => {
    await ev('ContactStatus', { EndpointName: '303', ContactStatus: 'Reachable', AOR: '303' });
    const r = (await pool.query(`SELECT last_registered_at FROM communication_extensions WHERE extension_number = '303'`)).rows[0];
    expect(r.last_registered_at).not.toBeNull();
  });
});
