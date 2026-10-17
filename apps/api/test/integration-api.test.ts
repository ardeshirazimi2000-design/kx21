import crypto from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { migrate } from '../src/db/migrate.js';
import { pool } from '../src/db/pool.js';
import { seed, SEED_PASSWORD } from '../src/db/seed.js';
import { deliverIntegrationEvents } from '../src/services/integrations.js';

const app = createApp();
const tokens: Record<string, string> = {};
const me: Record<string, any> = {};

/** Local webhook receiver standing in for the office automation system. */
const received: { headers: http.IncomingHttpHeaders; body: string }[] = [];
let receiver: http.Server;
let webhookUrl: string;
let failNext = 0;

const as = (who: string) => ({
  get: (url: string) => request(app).get(url).set('authorization', `Bearer ${tokens[who]}`),
  post: (url: string, body: object = {}) => request(app).post(url).set('authorization', `Bearer ${tokens[who]}`).send(body),
  patch: (url: string, body: object = {}) => request(app).patch(url).set('authorization', `Bearer ${tokens[who]}`).send(body),
});

let client: { id: string; apiKey: string; webhookSecret: string };
const ext = {
  get: (url: string) => request(app).get(`/api/integration/v1${url}`).set('x-api-key', client.apiKey),
  post: (url: string, body: object = {}) => request(app).post(`/api/integration/v1${url}`).set('x-api-key', client.apiKey).send(body),
};

async function login(who: string, email: string) {
  const r = await request(app).post('/api/auth/login').send({ identifier: email, password: SEED_PASSWORD });
  expect(r.status).toBe(200);
  tokens[who] = r.body.accessToken;
  me[who] = (await as(who).get('/api/auth/me')).body;
}

function verifySignature(secret: string, header: string, body: string) {
  const m = /^t=(\d+),v1=([0-9a-f]+)$/.exec(header);
  if (!m) return false;
  const expected = crypto.createHmac('sha256', secret).update(`${m[1]}.${body}`).digest('hex');
  return expected === m[2];
}

beforeAll(async () => {
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await migrate(false);
  await seed();
  receiver = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      if (failNext > 0) {
        failNext--;
        res.writeHead(503).end();
        return;
      }
      received.push({ headers: req.headers, body });
      res.writeHead(202).end();
    });
  });
  await new Promise<void>((r) => receiver.listen(0, '127.0.0.1', r));
  webhookUrl = `http://127.0.0.1:${(receiver.address() as AddressInfo).port}/hook`;
  await login('admin', 'admin@kx.local');
  await login('isf', 'admin.isf@kx.local');
  await login('chair', 'chair@kx.local');
  await login('secretary', 'secretary@kx.local');
});

afterAll(async () => {
  await new Promise((r) => receiver.close(r));
  await pool.end();
});

describe('integration clients (admin)', () => {
  it('chamber admin registers the office automation system; secrets are returned once', async () => {
    const r = await as('admin').post('/api/integrations', { chamberId: me.admin.chamber_id, name: 'اتوماسیون اداری', webhookUrl });
    expect(r.status).toBe(201);
    expect(r.body.apiKey).toMatch(/^kxi_/);
    expect(r.body.webhookSecret).toBeTruthy();
    client = { id: r.body.id, apiKey: r.body.apiKey, webhookSecret: r.body.webhookSecret };
    const list = await as('admin').get(`/api/integrations?chamberId=${me.admin.chamber_id}`);
    expect(list.body.items).toHaveLength(1);
    expect(list.body.items[0].apiKey).toBeUndefined();
    expect(JSON.stringify(list.body)).not.toContain(client.apiKey);
  });

  it('other chambers and non-admins cannot manage it', async () => {
    expect((await as('isf').get(`/api/integrations?chamberId=${me.admin.chamber_id}`)).status).toBe(403);
    expect((await as('chair').post('/api/integrations', { chamberId: me.admin.chamber_id, name: 'سامانه دیگر' })).status).toBe(403);
    expect((await as('isf').patch(`/api/integrations/${client.id}`, { isActive: false })).status).toBe(403);
  });
});

describe('authentication', () => {
  it('accepts the API key and rejects bad keys', async () => {
    expect((await ext.get('/me')).body.name).toBe('اتوماسیون اداری');
    expect((await request(app).get('/api/integration/v1/me').set('x-api-key', 'kxi_000000000000_nope-nope-nope-nope-nope')).status).toBe(401);
    expect((await request(app).get('/api/integration/v1/me')).status).toBe(401);
    // A user token is not an integration token.
    expect((await request(app).get('/api/integration/v1/me').set('authorization', `Bearer ${tokens.admin}`)).status).toBe(401);
  });

  it('issues OAuth2 client-credentials tokens', async () => {
    const bad = await request(app).post('/api/integration/v1/oauth/token').type('form').send({ grant_type: 'client_credentials', client_id: client.id, client_secret: 'x' });
    expect(bad.status).toBe(401);
    const r = await request(app)
      .post('/api/integration/v1/oauth/token')
      .type('form')
      .send({ grant_type: 'client_credentials', client_id: client.id, client_secret: client.apiKey });
    expect(r.status).toBe(200);
    expect(r.body.token_type).toBe('Bearer');
    const m = await request(app).get('/api/integration/v1/me').set('authorization', `Bearer ${r.body.access_token}`);
    expect(m.status).toBe(200);
  });
});

describe('meetings → office automation', () => {
  let pastMeetingId: string;
  let commissionId: string;
  let upcomingMeetingId: string;

  it('lists commissions and meetings of its own chamber only, with participants', async () => {
    const cms = await ext.get('/commissions');
    expect(cms.status).toBe(200);
    expect(cms.body.length).toBeGreaterThan(0);
    const meetings = await ext.get('/meetings');
    expect(meetings.body.total).toBeGreaterThanOrEqual(2);
    const past = meetings.body.items.find((m: any) => m.status === 'approved');
    const upcoming = meetings.body.items.find((m: any) => m.status === 'invitation_sent');
    pastMeetingId = past.id;
    upcomingMeetingId = upcoming.id;
    commissionId = upcoming.commission_id;
    const d = await ext.get(`/meetings/${upcoming.id}`);
    expect(d.status).toBe(200);
    expect(d.body.participants.length).toBeGreaterThan(3);
    expect(d.body.participants[0]).toHaveProperty('national_id');
    const pd = await ext.get(`/meetings/${pastMeetingId}`);
    expect(pd.body.minutes?.minutes_number).toBeTruthy();
    expect(pd.body.resolutions.length).toBeGreaterThan(0);

    const isfMeeting = await pool.query(`SELECT m.id FROM meetings m JOIN chambers c ON c.id = m.chamber_id WHERE c.province = 'اصفهان' LIMIT 1`);
    if (isfMeeting.rows[0]) expect((await ext.get(`/meetings/${isfMeeting.rows[0].id}`)).status).toBe(404);
  });

  it('a new resolution produces a signed resolution.created webhook (retried on failure)', async () => {
    const r = await as('chair').post('/api/resolutions', {
      commissionId,
      meetingId: pastMeetingId,
      text: 'تهیه گزارش موانع صادرات و ارسال به وزارت صمت',
      ownerId: me.secretary.id,
      dueDate: '2030-01-01',
    });
    expect(r.status).toBe(201);
    failNext = 1;
    await deliverIntegrationEvents();
    const failed = await pool.query(`SELECT status, attempts, last_error FROM integration_events WHERE entity_id = $1`, [r.body.id]);
    expect(failed.rows[0]).toMatchObject({ status: 'pending', attempts: 1 });
    await pool.query(`UPDATE integration_events SET next_attempt_at = now()`);
    await deliverIntegrationEvents();
    const hook = received.find((h) => JSON.parse(h.body).data.id === r.body.id)!;
    expect(hook).toBeTruthy();
    expect(hook.headers['x-kx-event']).toBe('resolution.created');
    expect(verifySignature(client.webhookSecret, String(hook.headers['x-kx-signature']), hook.body)).toBe(true);
    expect(verifySignature('wrong', String(hook.headers['x-kx-signature']), hook.body)).toBe(false);
    const delivered = await pool.query(`SELECT status FROM integration_events WHERE entity_id = $1`, [r.body.id]);
    expect(delivered.rows[0].status).toBe('delivered');

    const detail = await ext.get(`/resolutions/${r.body.id}`);
    expect(detail.body.owner_name).toBe(me.secretary.full_name);
    expect(detail.body.commission_name).toBeTruthy();
  });

  it('accepts execution feedback and shows it in the resolution history', async () => {
    const list = await ext.get('/resolutions?status=open');
    const res = list.body.items.find((x: any) => x.text.startsWith('تهیه گزارش'));
    const fb = await ext.post(`/resolutions/${res.id}/feedback`, { progress: 40, note: 'نامه به وزارت صمت ارسال شد', externalRef: 'letter-1' });
    expect(fb.status).toBe(200);
    expect(fb.body).toMatchObject({ status: 'in_progress', progress: 40 });
    const d = await as('secretary').get(`/api/resolutions/${res.id}`);
    expect(d.body.updates[0].full_name).toBe('اتوماسیون اداری');
    expect(d.body.updates[0].source).toBe('integration');
    // 100% sends it for the secretary's review; it is not closed by the external system.
    const done = await ext.post(`/resolutions/${res.id}/feedback`, { progress: 100, note: 'انجام شد' });
    expect(done.body.status).toBe('submitted');
    const ev = await ext.get('/events?after=0');
    expect(ev.body.items.some((e: any) => e.type === 'resolution.updated' && e.data.status === 'submitted')).toBe(true);
  });
});

describe('office automation → meetings', () => {
  let referral: any;

  it('refers a letter to a commission (idempotent by externalRef) and notifies the secretary', async () => {
    const cms = await ext.get('/commissions');
    const commission = cms.body[0];
    const meetings = await ext.get(`/meetings?commissionId=${commission.id}`);
    const upcoming = meetings.body.items.find((m: any) => m.status === 'invitation_sent');
    const payload = {
      commissionId: commission.id,
      title: 'درخواست بررسی تعرفه واردات مواد اولیه',
      description: 'متن نامه وارده از انجمن صنایع غذایی',
      externalRef: 'oa-letter-0001',
      externalNumber: 'و/۱۴۰۵/۱۲',
      requestedMeetingId: upcoming?.id,
    };
    const r = await ext.post('/referrals', payload);
    expect(r.status).toBe(201);
    referral = r.body;
    expect(referral.status).toBe('open');
    expect((await ext.post('/referrals', payload)).status).toBe(200);
    const notes = await as('secretary').get('/api/notifications');
    expect(JSON.stringify(notes.body)).toContain('ارجاع مکاتبه');
    const issues = await as('secretary').get(`/api/commissions/${commission.id}/issues`);
    expect(issues.body.some((i: any) => i.id === referral.id && i.source === 'integration')).toBe(true);

    // The secretary puts it on the agenda → referral.updated (on_agenda) for this client.
    if (upcoming) {
      const a = await as('secretary').post(`/api/meetings/${upcoming.id}/agenda`, { title: referral.title, issueId: referral.id });
      expect(a.status).toBe(201);
      const view = await ext.get(`/referrals/${referral.id}`);
      expect(view.body.status).toBe('on_agenda');
      expect(view.body.agenda[0].meeting_id).toBe(upcoming.id);
      const ev = await ext.get('/events?after=0');
      expect(ev.body.items.some((e: any) => e.type === 'referral.updated' && e.data.externalRef === 'oa-letter-0001')).toBe(true);
    }
  });

  it('exchanges attachments both ways', async () => {
    const up = await request(app)
      .post('/api/integration/v1/documents')
      .set('x-api-key', client.apiKey)
      .field('issueId', referral.id)
      .attach('file', Buffer.from('%PDF-1.4 letter'), 'نامه.pdf');
    expect(up.status).toBe(201);
    const dl = await ext.get(`/documents/${up.body.id}/content`);
    expect(dl.status).toBe(200);
    expect(dl.headers['content-type']).toContain('application/pdf');
    const bad = await request(app)
      .post('/api/integration/v1/documents')
      .set('x-api-key', client.apiKey)
      .field('issueId', referral.id)
      .attach('file', Buffer.from('MZ binary'), 'x.exe');
    expect(bad.status).toBe(400);
  });

  it('enforces scopes and deactivation', async () => {
    const r = await as('admin').post('/api/integrations', { chamberId: me.admin.chamber_id, name: 'CRM', scopes: ['meetings:read'] });
    const limited = r.body.apiKey;
    expect((await request(app).get('/api/integration/v1/meetings').set('x-api-key', limited)).status).toBe(200);
    expect((await request(app).get('/api/integration/v1/resolutions').set('x-api-key', limited)).status).toBe(403);
    // Events go only to clients with events:read.
    const n = await pool.query(`SELECT count(*)::int AS n FROM integration_events WHERE client_id = $1`, [r.body.id]);
    expect(n.rows[0].n).toBe(0);
    await as('admin').patch(`/api/integrations/${r.body.id}`, { isActive: false });
    expect((await request(app).get('/api/integration/v1/meetings').set('x-api-key', limited)).status).toBe(401);
    const rot = await as('admin').post(`/api/integrations/${r.body.id}/rotate`);
    expect(rot.body.apiKey).not.toBe(limited);
  });
});
