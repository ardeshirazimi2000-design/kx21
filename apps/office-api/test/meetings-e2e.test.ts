/**
 * End-to-end integration with the real commission meetings system (apps/api), started as a separate process
 * on its own database. Covers the three scenarios of the architecture document:
 *  1. ثبت مصوبه → signed webhook → internal letter + follow-up workflow in office automation
 *  2. ارجاع مکاتبه به جلسه → agenda issue (with attachment) in the meetings system, status changes come back
 *  3. پیگیری اجرای مصوبه → workflow completion reports progress 100% back to the meetings system
 */
import { spawn, type ChildProcess } from 'node:child_process';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import net from 'node:net';
import path from 'node:path';
import pg from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { pool } from '../src/db/pool.js';
import { seed, SEED_PASSWORD } from '../src/db/seed.js';
import '../src/integration/meetings.js';
import { drainJobs } from '../src/services/jobs.js';

const MEETINGS_DIR = path.resolve(__dirname, '../../api');
const meetingsDbUrl = process.env.MEETINGS_E2E_DATABASE_URL ?? 'postgres://kx:kx@localhost:5432/kx_meetings_e2e';

const app = createApp();
let office: http.Server;
let officeUrl: string;
let meetingsUrl: string;
let meetingsProc: ChildProcess;
let mdb: pg.Pool;
const tokens: Record<string, string> = {};
const me: Record<string, any> = {};

const as = (who: string) => ({
  get: (url: string) => request(app).get(url).set('authorization', `Bearer ${tokens[who]}`),
  post: (url: string, body: object = {}) => request(app).post(url).set('authorization', `Bearer ${tokens[who]}`).send(body),
  put: (url: string, body: object = {}) => request(app).put(url).set('authorization', `Bearer ${tokens[who]}`).send(body),
  upload: (url: string, file: Buffer, name: string) => request(app).post(url).set('authorization', `Bearer ${tokens[who]}`).attach('file', file, name),
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function until<T>(what: string, fn: () => Promise<T | null | undefined | false>, timeoutMs = 20_000): Promise<T> {
  const end = Date.now() + timeoutMs;
  for (;;) {
    await drainJobs();
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(250);
  }
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => {
      const p = (s.address() as AddressInfo).port;
      s.close(() => resolve(p));
    });
    s.on('error', reject);
  });
}

function run(args: string[], env: NodeJS.ProcessEnv, opts: { wait: boolean }) {
  const p = spawn(process.execPath, ['--import', 'tsx', ...args], { cwd: MEETINGS_DIR, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  p.stdout!.on('data', (d) => (out += d));
  p.stderr!.on('data', (d) => (out += d));
  if (!opts.wait) return { proc: p, done: Promise.resolve(), output: () => out };
  const done = new Promise<void>((resolve, reject) => p.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`${args.join(' ')} exited ${code}\n${out}`)))));
  return { proc: p, done, output: () => out };
}

async function ensureDb(url: string) {
  const u = new URL(url);
  const name = u.pathname.slice(1);
  const admin = new URL(url);
  admin.pathname = `/${process.env.OFFICE_TEST_ADMIN_DB ?? 'kx_test'}`;
  const c = new pg.Client({ connectionString: admin.toString() });
  await c.connect();
  try {
    if (!(await c.query('SELECT 1 FROM pg_database WHERE datname = $1', [name])).rowCount) await c.query(`CREATE DATABASE "${name}"`);
  } finally {
    await c.end();
  }
}

/** Meetings API as a chamber admin. */
let meetingsToken = '';
async function m(method: string, url: string, body?: unknown) {
  const r = await fetch(`${meetingsUrl}/api${url}`, {
    method,
    headers: { 'content-type': 'application/json', ...(meetingsToken ? { authorization: `Bearer ${meetingsToken}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await r.text();
  return { status: r.status, body: text ? JSON.parse(text) : null };
}

beforeAll(async () => {
  // Meetings system: fresh database, migrated by its server on start, then seeded.
  await ensureDb(meetingsDbUrl);
  mdb = new pg.Pool({ connectionString: meetingsDbUrl });
  await mdb.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  const port = await freePort();
  meetingsUrl = `http://127.0.0.1:${port}`;
  const env = {
    NODE_ENV: 'development',
    VITEST: '',
    DATABASE_URL: meetingsDbUrl,
    PORT: String(port),
    UPLOAD_DIR: path.resolve(MEETINGS_DIR, '.test-uploads-e2e'),
    SCHEDULER_ENABLED: 'false',
    INTEGRATION_WORKER_INTERVAL_SECONDS: '1',
    LOG_LEVEL: 'warn',
  };
  const server = run(['src/server.ts'], env, { wait: false });
  meetingsProc = server.proc;
  const end = Date.now() + 40_000;
  for (;;) {
    try {
      if ((await fetch(`${meetingsUrl}/health`)).ok) break;
    } catch {
      /* not up yet */
    }
    if (Date.now() > end || meetingsProc.exitCode !== null) throw new Error(`meetings API did not start\n${server.output()}`);
    await sleep(300);
  }
  await run(['src/db/seed.ts'], env, { wait: true }).done;

  // Office automation: fresh database and an HTTP listener for the webhook.
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await seed();
  office = http.createServer(app);
  await new Promise<void>((r) => office.listen(0, '127.0.0.1', r));
  officeUrl = `http://127.0.0.1:${(office.address() as AddressInfo).port}`;
  for (const who of ['admin', 'clerk', 'expert', 'reshead', 'cmshead']) {
    const r = await request(app).post('/api/auth/login').send({ identifier: who, password: SEED_PASSWORD });
    tokens[who] = r.body.accessToken;
    me[who] = (await as(who).get('/api/auth/me')).body;
  }
}, 90_000);

afterAll(async () => {
  meetingsProc?.kill('SIGTERM');
  await new Promise((r) => office?.close(r));
  await mdb?.end();
  await pool.end();
});

describe('office automation ⇄ commission meetings (end to end)', () => {
  let client: { apiKey: string; webhookSecret: string };
  let chamberId: string;
  let commission: { id: string; name: string };

  it('connects the two systems (API key + signed webhooks)', async () => {
    const login = await m('POST', '/auth/login', { identifier: 'admin@kx.local', password: 'Passw0rd!' });
    expect(login.status).toBe(200);
    meetingsToken = login.body.accessToken;
    chamberId = (await m('GET', '/auth/me')).body.chamber_id;
    const c = await m('POST', '/integrations', { chamberId, name: 'اتوماسیون اداری', webhookUrl: `${officeUrl}/api/integrations/meetings/webhook` });
    expect(c.status).toBe(201);
    client = c.body;
    const put = await as('admin').put('/api/integrations/meetings', {
      baseUrl: meetingsUrl,
      apiKey: client.apiKey,
      webhookSecret: client.webhookSecret,
      settings: { auth: 'oauth2' },
      clientId: c.body.clientId,
    });
    expect(put.status).toBe(204);
    const t = await as('admin').post('/api/integrations/meetings/test');
    expect(t.status).toBe(200);
    expect(t.body.ok).toBe(true);
    const cs = await as('clerk').get('/api/commissions');
    expect(cs.status).toBe(200);
    commission = cs.body.find((x: any) => x.code === 'EXP') ?? cs.body[0];
    expect(commission).toBeTruthy();
  });

  it('scenario 1 + 3: a new resolution becomes a letter and workflow; completing it reports back', async () => {
    const owner = (await mdb.query(`SELECT id FROM users WHERE email = 'expert@kx.local'`)).rows[0];
    const meeting = (await mdb.query(`SELECT id, commission_id FROM meetings WHERE status = 'approved' LIMIT 1`)).rows[0];
    const res = (
      await mdb.query(
        `INSERT INTO resolutions (chamber_id, commission_id, meeting_id, number, text, owner_id, addressee, due_date, priority, created_by)
         VALUES ($1,$2,$3,'EXP-099','تهیه گزارش آسیب‌شناسی صادرات خدمات فنی و مهندسی',$4,'مرکز پژوهش‌ها',current_date + 14,'high',$4) RETURNING id`,
        [chamberId, meeting.commission_id, meeting.id, owner.id],
      )
    ).rows[0];

    // Delivered by the meetings outbox worker, verified and queued by office automation.
    const cached = await until('resolution letter', async () => (await pool.query('SELECT * FROM resolutions_cache WHERE external_id = $1 AND letter_id IS NOT NULL', [res.id])).rows[0]);
    expect(cached.owner_user_id).toBe(me.expert.id);
    const inbox = (await pool.query(`SELECT * FROM integration_inbox WHERE event_type = 'resolution.created'`)).rows;
    expect(inbox.some((e) => e.status === 'processed')).toBe(true);

    // The responsible person sees the letter and the execute step in their cartable.
    const notes = (await as('expert').get('/api/notifications')).body.items;
    expect(notes.some((n: any) => n.event === 'resolution.assigned')).toBe(true);
    let letter = (await as('expert').get(`/api/letters/${cached.letter_id}`)).body;
    expect(letter.source).toBe('meeting');
    expect(letter.subject).toContain('EXP-099');
    expect(letter.my.steps).toHaveLength(1);

    // Intermediate progress is sent while the work is ongoing.
    const fb = await as('expert').post(`/api/resolutions/${res.id}/feedback`, { progress: 50, note: 'پیش‌نویس گزارش آماده شد' });
    expect(fb.status).toBe(202);
    await until('progress 50 in meetings', async () => (await mdb.query('SELECT progress FROM resolutions WHERE id = $1', [res.id])).rows[0].progress === 50);

    expect((await as('expert').post(`/api/workflow-steps/${letter.my.steps[0]}/act`, { decision: 'approve', comment: 'گزارش تهیه و ارسال شد' })).status).toBe(200);
    letter = (await as('reshead').get(`/api/letters/${cached.letter_id}`)).body;
    expect(letter.my.steps).toHaveLength(1);
    expect((await as('reshead').post(`/api/workflow-steps/${letter.my.steps[0]}/act`, { decision: 'approve' })).status).toBe(200);

    // Completion → progress 100 + submitted for the commission secretary's review in the meetings system.
    const r = await until('submitted in meetings', async () => (await mdb.query(`SELECT * FROM resolutions WHERE id = $1 AND status = 'submitted'`, [res.id])).rows[0]);
    expect(r.progress).toBe(100);
    const upd = (await mdb.query(`SELECT * FROM resolution_updates WHERE resolution_id = $1 ORDER BY created_at`, [res.id])).rows;
    expect(upd.every((u) => u.source === 'integration' && u.user_id === null)).toBe(true);
    expect(upd.at(-1).note).toContain('اتوماسیون اداری');
    const local = (await as('expert').get(`/api/resolutions/${res.id}`)).body;
    expect(local.status).toBe('submitted');

    // The secretary approves it in the meetings system; the update flows back to the cache.
    await mdb.query(`UPDATE resolutions SET status = 'done', updated_at = now() WHERE id = $1`, [res.id]);
    await until('done in office', async () => (await pool.query(`SELECT 1 FROM resolutions_cache WHERE external_id = $1 AND status = 'done'`, [res.id])).rowCount);
  }, 60_000);

  it('scenario 2: a letter is referred to a commission with its attachment and tracked', async () => {
    const l = await as('clerk').post('/api/letters', { kind: 'incoming', subject: 'پیشنهاد اصلاح آیین‌نامه صادرات موقت', externalOrg: 'انجمن صادرکنندگان', register: true });
    expect(l.status).toBe(201);
    const pdf = Buffer.from('%PDF-1.4\n%%EOF');
    expect((await as('clerk').upload(`/api/letters/${l.body.id}/attachments`, pdf, 'پیشنهاد.pdf')).status).toBe(201);
    const ref = await as('clerk').post(`/api/letters/${l.body.id}/meeting-referrals`, { commissionId: commission.id, note: 'جهت طرح در جلسه آتی' });
    expect(ref.status).toBe(201);
    const issue = (await mdb.query(`SELECT * FROM issues WHERE external_ref = $1`, [`letter:${l.body.id}`])).rows[0];
    expect(issue.source).toBe('integration');
    expect(issue.external_number).toBe(l.body.number);
    const docs = (await mdb.query(`SELECT file_name FROM documents WHERE issue_id = $1`, [issue.id])).rows;
    expect(docs.map((d) => d.file_name)).toContain('پیشنهاد.pdf');
    // Idempotent: referring again returns the same issue.
    const again = await as('clerk').post(`/api/letters/${l.body.id}/meeting-referrals`, { commissionId: commission.id, includeAttachments: false });
    expect(again.body.external_issue_id).toBe(issue.id);

    await mdb.query(`UPDATE issues SET status = 'under_review' WHERE id = $1`, [issue.id]);
    await until('referral status', async () => (await pool.query(`SELECT 1 FROM letter_meeting_refs WHERE external_issue_id = $1 AND status = 'under_review'`, [issue.id])).rowCount);
    const n = (await as('clerk').get('/api/notifications')).body.items;
    expect(n.some((x: any) => x.event === 'meeting.referral_updated')).toBe(true);
    const detail = (await as('clerk').get(`/api/letters/${l.body.id}`)).body;
    expect(detail.meetingRefs[0].status).toBe('under_review');
  }, 60_000);

  it('rejects unsigned or replayed webhooks', async () => {
    const body = JSON.stringify({ id: 'x1', type: 'resolution.created', data: { id: '00000000-0000-0000-0000-000000000000' } });
    const r = await request(app).post('/api/integrations/meetings/webhook').set('content-type', 'application/json').set('x-kx-signature', `t=${Math.floor(Date.now() / 1000)},v1=${'0'.repeat(64)}`).send(body);
    expect(r.status).toBe(401);
    const crypto = await import('node:crypto');
    const t = Math.floor(Date.now() / 1000) - 3600;
    const sig = crypto.createHmac('sha256', client.webhookSecret).update(`${t}.${body}`).digest('hex');
    expect((await request(app).post('/api/integrations/meetings/webhook').set('content-type', 'application/json').set('x-kx-signature', `t=${t},v1=${sig}`).send(body)).status).toBe(401);
  });
});
