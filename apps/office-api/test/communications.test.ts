import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { io as ioClient, type Socket } from 'socket.io-client';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { pool } from '../src/db/pool.js';
import { seed, SEED_PASSWORD } from '../src/db/seed.js';
import { drainJobs } from '../src/services/jobs.js';
import { setPbxAdapter, type PbxAdapter } from '../src/services/pbx.js';
import { closeRealtime, initRealtime, REALTIME_PATH } from '../src/services/realtime.js';

const app = createApp();
const tokens: Record<string, string> = {};
const me: Record<string, any> = {};
const as = (who: string) => ({
  get: (url: string) => request(app).get(url).set('authorization', `Bearer ${tokens[who]}`),
  post: (url: string, body: object = {}) => request(app).post(url).set('authorization', `Bearer ${tokens[who]}`).send(body),
  patch: (url: string, body: object = {}) => request(app).patch(url).set('authorization', `Bearer ${tokens[who]}`).send(body),
  delete: (url: string) => request(app).delete(url).set('authorization', `Bearer ${tokens[who]}`),
  upload: (url: string, fields: Record<string, string>, file: Buffer, name: string) => {
    const r = request(app).post(url).set('authorization', `Bearer ${tokens[who]}`);
    for (const [k, v] of Object.entries(fields)) r.field(k, v);
    return r.attach('file', file, name);
  },
});

let server: Server;
let base = '';
const sockets: Socket[] = [];
const connect = (token: string) =>
  new Promise<Socket>((resolve, reject) => {
    const s = ioClient(base, { path: REALTIME_PATH, auth: { token }, transports: ['websocket'], reconnection: false, forceNew: true });
    sockets.push(s);
    s.on('connect', () => resolve(s));
    s.on('connect_error', (e) => reject(e));
  });
const next = (s: Socket, event: string, ms = 3000) =>
  new Promise<any>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`no ${event}`)), ms);
    s.once(event, (p) => {
      clearTimeout(t);
      resolve(p);
    });
  });
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

beforeAll(async () => {
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await seed();
  for (const u of ['admin', 'clerk', 'cmshead', 'cmsexpert', 'reshead', 'expert', 'it']) {
    const r = await request(app).post('/api/auth/login').send({ identifier: u, password: SEED_PASSWORD });
    tokens[u] = r.body.accessToken;
    me[u] = (await as(u).get('/api/auth/me')).body;
  }
  server = createServer(app);
  initRealtime(server);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  sockets.forEach((s) => s.disconnect());
  setPbxAdapter(null);
  await closeRealtime();
  await pool.end();
});

describe('extensions (شماره‌های داخلی)', () => {
  it('only holders of communications.extension.manage assign numbers; a live number is unique', async () => {
    expect((await as('expert').post('/api/communications/extensions', { userId: me.expert.id, extensionNumber: '201' })).status).toBe(403);
    expect((await as('expert').get('/api/communications/extensions')).status).toBe(403);
    const r = await as('it').post('/api/communications/extensions', { userId: me.expert.id, extensionNumber: '201', label: 'میز کار' });
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ status: 'draft', provision_source: null });
    const dup = await as('it').post('/api/communications/extensions', { userId: me.reshead.id, extensionNumber: '201' });
    expect(dup.status).toBe(409);
    expect(dup.body.error.code).toBe('extension_taken');
    expect((await as('it').post('/api/communications/extensions', { userId: me.reshead.id, extensionNumber: '2a1' })).status).toBe(400);
  });

  it('without a PBX, provisioning is refused and an administrator confirms by hand; disabled is final and frees the number', async () => {
    const [ext] = (await as('it').get('/api/communications/extensions?q=201')).body;
    const p = await as('it').post(`/api/communications/extensions/${ext.id}/provision`);
    expect(p.status).toBe(409);
    expect(p.body.error.code).toBe('pbx_not_configured');
    // draft → suspended is not a valid step
    expect((await as('it').patch(`/api/communications/extensions/${ext.id}`, { status: 'suspended' })).status).toBe(409);
    const a = await as('it').patch(`/api/communications/extensions/${ext.id}`, { status: 'active' });
    expect(a.body).toMatchObject({ status: 'active', provision_source: 'manual' });
    expect((await as('it').patch(`/api/communications/extensions/${ext.id}`, { status: 'disabled', reason: 'جابه‌جایی' })).body.status).toBe('disabled');
    expect((await as('it').patch(`/api/communications/extensions/${ext.id}`, { status: 'active' })).status).toBe(409);
    // the record stays (history); the number can go to someone else
    const again = await as('it').post('/api/communications/extensions', { userId: me.reshead.id, extensionNumber: '201', existsOnPbx: true });
    expect(again.status).toBe(201);
    expect(again.body.status).toBe('active');
    const audits = await pool.query(`SELECT action FROM audit_logs WHERE entity = 'communication_extension' ORDER BY id`);
    expect(audits.rows.map((r) => r.action)).toEqual([
      'communications.extension_created',
      'communications.extension_updated',
      'communications.extension_updated',
      'communications.extension_created',
    ]);
  });

  it('with a PBX adapter, provisioning is a retried, idempotent job that ends active', async () => {
    let calls = 0;
    const fake: PbxAdapter = {
      kind: 'asterisk-ami',
      configured: true,
      async provisionExtension() {
        calls++;
        if (calls === 1) throw new Error('AMI timeout');
      },
      async disableExtension() {},
    };
    setPbxAdapter(fake);
    try {
      const ext = (await as('it').post('/api/communications/extensions', { userId: me.cmsexpert.id, extensionNumber: '305' })).body;
      expect((await as('it').post(`/api/communications/extensions/${ext.id}/provision`)).status).toBe(202);
      expect((await as('it').post(`/api/communications/extensions/${ext.id}/provision`)).status).toBe(202); // already queued: no second job
      expect((await pool.query(`SELECT count(*)::int AS n FROM jobs WHERE kind = 'communications.provision'`)).rows[0].n).toBe(1);
      await drainJobs();
      let row = (await pool.query('SELECT status, last_error FROM communication_extensions WHERE id = $1', [ext.id])).rows[0];
      expect(row.status).toBe('failed');
      expect(row.last_error).not.toMatch(/AMI/); // no internal detail to the UI
      await pool.query(`UPDATE jobs SET run_at = now() WHERE kind = 'communications.provision'`);
      await drainJobs();
      row = (await pool.query('SELECT status, provision_source FROM communication_extensions WHERE id = $1', [ext.id])).rows[0];
      expect(row).toEqual({ status: 'active', provision_source: 'adapter' });
      expect(calls).toBe(2);
    } finally {
      setPbxAdapter(null);
    }
  });

  it('a person keeps the number when moved to another unit (it belongs to the user, not the position)', async () => {
    const mine = (await as('reshead').get('/api/communications/extensions/mine')).body;
    expect(mine.map((e: any) => e.extension_number)).toEqual(['201']);
  });
});

describe('directory (دفترچه تلفن)', () => {
  it('lists active people with unit, position and live extensions, without personal contact details', async () => {
    const all = (await as('expert').get('/api/communications/directory')).body as any[];
    const res = all.find((p) => p.id === me.reshead.id);
    expect(res).toMatchObject({ full_name: me.reshead.full_name, extensions: [{ number: '201', status: 'active' }] });
    expect(res.unit_name).toBeTruthy();
    expect(Object.keys(res)).not.toContain('email');
    expect(Object.keys(res)).not.toContain('mobile');
    expect(all.find((p) => p.id === me.expert.id).extensions).toEqual([]); // its 201 was disabled
    const byNumber = (await as('expert').get('/api/communications/directory?q=20')).body;
    expect(byNumber.map((p: any) => p.id)).toEqual([me.reshead.id]);
  });
});

describe('messenger (پیام‌رسان)', () => {
  let direct = '';
  let group = '';

  it('a direct conversation is one per pair, and only its two members can see it', async () => {
    const a = await as('expert').post('/api/communications/conversations', { type: 'direct', userId: me.reshead.id });
    expect(a.status).toBe(201);
    const b = await as('reshead').post('/api/communications/conversations', { type: 'direct', userId: me.expert.id });
    expect(b.status).toBe(200);
    expect(b.body.id).toBe(a.body.id);
    direct = a.body.id;
    expect((await as('expert').post('/api/communications/conversations', { type: 'direct', userId: me.expert.id })).status).toBe(400);
    // an outsider — the administrator too — gets 404 everywhere
    for (const who of ['cmsexpert', 'admin']) {
      expect((await as(who).get(`/api/communications/conversations/${direct}`)).status).toBe(404);
      expect((await as(who).get(`/api/communications/conversations/${direct}/messages`)).status).toBe(404);
      expect((await as(who).post(`/api/communications/conversations/${direct}/messages`, { body: 'سلام' })).status).toBe(404);
    }
  });

  it('sends, de-duplicates a retried send, counts unread, marks read and notifies an offline member once, without the text', async () => {
    const m1 = await as('expert').post(`/api/communications/conversations/${direct}/messages`, { body: 'گزارش تعرفه آماده است', clientId: 'c-0000001' });
    expect(m1.status).toBe(201);
    const retry = await as('expert').post(`/api/communications/conversations/${direct}/messages`, { body: 'گزارش تعرفه آماده است', clientId: 'c-0000001' });
    expect(retry.status).toBe(200);
    expect(retry.body.id).toBe(m1.body.id);
    await as('expert').post(`/api/communications/conversations/${direct}/messages`, { body: 'لطفاً بررسی کنید' });
    const list = (await as('reshead').get('/api/communications/conversations')).body;
    const c = list.find((x: any) => x.id === direct);
    expect(c).toMatchObject({ unread: 2, title: me.expert.full_name, conversation_type: 'direct' });
    expect(c.last_message.body).toBe('لطفاً بررسی کنید');
    // reshead is offline: one notification for the conversation, naming the sender only
    const n = await pool.query(`SELECT title, body, data FROM notifications WHERE user_id = $1 AND event = 'message.received'`, [me.reshead.id]);
    expect(n.rows).toHaveLength(1);
    expect(n.rows[0].title).toContain(me.expert.full_name);
    expect(n.rows[0].body).not.toContain('تعرفه');
    expect(n.rows[0].data.path).toBe(`/communications/messages?c=${direct}`);

    const msgs = (await as('reshead').get(`/api/communications/conversations/${direct}/messages`)).body;
    expect(msgs.items.map((m: any) => m.body)).toEqual(['لطفاً بررسی کنید', 'گزارش تعرفه آماده است']);
    expect((await as('reshead').post(`/api/communications/messages/${msgs.items[0].id}/read`)).status).toBe(200);
    expect((await as('reshead').get('/api/communications/conversations')).body.find((x: any) => x.id === direct).unread).toBe(0);
    const left = await pool.query(`SELECT count(*)::int AS n FROM notifications WHERE user_id = $1 AND event = 'message.received' AND read_at IS NULL`, [
      me.reshead.id,
    ]);
    expect(left.rows[0].n).toBe(0);
    // the sender sees how far the other has read
    const seen = (await as('expert').get(`/api/communications/conversations/${direct}/messages`)).body.reads;
    expect(seen).toHaveLength(1);
    expect(new Date(seen[0].last_read_at).getTime()).toBe(new Date(msgs.items[0].created_at).getTime());
  });

  it('only the sender edits or deletes; a deleted message keeps its place without the text', async () => {
    const m = (await as('expert').post(`/api/communications/conversations/${direct}/messages`, { body: 'متن اشتباه' })).body;
    expect((await as('reshead').patch(`/api/communications/messages/${m.id}`, { body: 'x' })).status).toBe(403);
    expect((await as('expert').patch(`/api/communications/messages/${m.id}`, { body: 'متن درست' })).body).toMatchObject({ body: 'متن درست' });
    expect((await as('expert').delete(`/api/communications/messages/${m.id}`)).status).toBe(204);
    const [top] = (await as('reshead').get(`/api/communications/conversations/${direct}/messages`)).body.items;
    expect(top.id).toBe(m.id);
    expect(top.body).toBe('');
    expect(top.deleted_at).toBeTruthy();
    expect((await as('expert').get('/api/communications/messages/search?q=متن')).body).toHaveLength(0);
  });

  it('organisational groups need the permission; owners manage members; a removed member loses access', async () => {
    expect((await as('expert').post('/api/communications/conversations', { type: 'group', title: 'گروه کارشناسان' })).status).toBe(403);
    const g = await as('cmshead').post('/api/communications/conversations', {
      type: 'group',
      title: 'هماهنگی جلسات',
      memberIds: [me.cmsexpert.id, me.expert.id],
    });
    expect(g.status).toBe(201);
    group = g.body.id;
    const detail = (await as('cmsexpert').get(`/api/communications/conversations/${group}`)).body;
    expect(detail).toMatchObject({ conversation_type: 'group', title: 'هماهنگی جلسات', can_manage: false });
    expect(detail.members.map((m: any) => [m.full_name, m.member_role])[0]).toEqual([me.cmshead.full_name, 'owner']);
    // a plain member cannot add or remove others
    expect((await as('cmsexpert').post(`/api/communications/conversations/${group}/members`, { userIds: [me.clerk.id] })).status).toBe(403);
    expect((await as('cmsexpert').delete(`/api/communications/conversations/${group}/members/${me.expert.id}`)).status).toBe(403);
    expect((await as('cmshead').post(`/api/communications/conversations/${group}/members`, { userIds: [me.clerk.id] })).body.added).toBe(1);
    await as('expert').post(`/api/communications/conversations/${group}/messages`, { body: 'دستور جلسه هفته بعد' });
    expect((await as('cmshead').delete(`/api/communications/conversations/${group}/members/${me.expert.id}`)).status).toBe(204);
    expect((await as('expert').get(`/api/communications/conversations/${group}/messages`)).status).toBe(404);
    expect((await as('expert').get('/api/communications/conversations')).body.map((c: any) => c.id)).not.toContain(group);
    // the history stays for the rest, with system lines
    const items = (await as('clerk').get(`/api/communications/conversations/${group}/messages`)).body.items;
    expect(items.map((m: any) => m.message_type)).toContain('system');
    expect(items.find((m: any) => m.body === 'دستور جلسه هفته بعد')).toBeTruthy();
    // leaving oneself is allowed
    expect((await as('clerk').delete(`/api/communications/conversations/${group}/members/${me.clerk.id}`)).status).toBe(204);
    const audits = await pool.query(`SELECT action FROM audit_logs WHERE entity = 'communication_conversation' AND entity_id = $1 ORDER BY id`, [group]);
    expect(audits.rows.map((r) => r.action)).toEqual([
      'communications.group_created',
      'communications.members_added',
      'communications.member_removed',
      'communications.member_left',
    ]);
  });

  it('an archived group takes no new messages', async () => {
    expect((await as('cmsexpert').patch(`/api/communications/conversations/${group}`, { isArchived: true })).status).toBe(403);
    expect((await as('cmshead').patch(`/api/communications/conversations/${group}`, { isArchived: true })).status).toBe(200);
    expect((await as('cmsexpert').post(`/api/communications/conversations/${group}/messages`, { body: 'سلام' })).status).toBe(409);
    await as('cmshead').patch(`/api/communications/conversations/${group}`, { isArchived: false });
  });

  it('files: allow-listed types, stored encrypted, downloadable by members only', async () => {
    const pdf = Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF');
    const up = await as('cmsexpert').upload(
      `/api/communications/conversations/${group}/attachments`,
      { body: 'صورت‌جلسه', clientId: 'file-0001' },
      pdf,
      'صورت‌جلسه.pdf',
    );
    expect(up.status).toBe(201);
    expect(up.body).toMatchObject({ message_type: 'file', body: 'صورت‌جلسه' });
    const att = up.body.attachments[0];
    expect(att).toMatchObject({ file_name: 'صورت‌جلسه.pdf', mime_type: 'application/pdf' });
    const stored = await pool.query('SELECT storage_key, checksum FROM communication_attachments WHERE id = $1', [att.id]);
    expect(stored.rows[0].checksum).toHaveLength(64);
    const dl = await as('cmshead').get(`/api/communications/attachments/${att.id}`);
    expect(dl.status).toBe(200);
    expect(Buffer.from(dl.body).subarray(0, 4).toString()).toBe('%PDF');
    expect(dl.headers['cache-control']).toBe('private, no-store');
    expect((await as('expert').get(`/api/communications/attachments/${att.id}`)).status).toBe(404); // removed earlier
    expect((await as('admin').get(`/api/communications/attachments/${att.id}`)).status).toBe(404);
    const bad = await as('cmsexpert').upload(`/api/communications/conversations/${group}/attachments`, {}, Buffer.from('MZ\x90\x00'), 'tool.exe');
    expect(bad.status).toBe(400);
    const fake = await as('cmsexpert').upload(`/api/communications/conversations/${group}/attachments`, {}, Buffer.from('not a pdf'), 'x.pdf');
    expect(fake.status).toBe(400);
    const found = (await as('cmshead').get(`/api/communications/messages/search?q=${encodeURIComponent('صورت')}`)).body;
    expect(found.map((m: any) => m.id)).toContain(up.body.id);
    expect((await as('expert').get(`/api/communications/messages/search?q=${encodeURIComponent('صورت')}`)).body).toHaveLength(0);
  });
});

describe('real-time channel', () => {
  it('rejects a socket without a valid token', async () => {
    await expect(connect('not-a-token')).rejects.toThrow(/unauthorized/);
  });

  it('pushes a new message to the members only, and an online member gets no notification', async () => {
    const reshead = await connect(tokens.reshead);
    const outsider = await connect(tokens.cmsexpert);
    let leaked = false;
    outsider.on('NewMessage', (p) => {
      if (p.conversationId) leaked = true;
    });
    const direct = (await as('expert').post('/api/communications/conversations', { type: 'direct', userId: me.reshead.id })).body.id;
    const before = (await pool.query(`SELECT count(*)::int AS n FROM notifications WHERE user_id = $1 AND event = 'message.received'`, [me.reshead.id])).rows[0]
      .n;
    const got = next(reshead, 'NewMessage');
    await as('expert').post(`/api/communications/conversations/${direct}/messages`, { body: 'پیام بلادرنگ' });
    const p = await got;
    expect(p).toMatchObject({ conversationId: direct, message: { body: 'پیام بلادرنگ', sender_name: me.expert.full_name } });
    await wait(200);
    expect(leaked).toBe(false);
    const after = (await pool.query(`SELECT count(*)::int AS n FROM notifications WHERE user_id = $1 AND event = 'message.received'`, [me.reshead.id])).rows[0]
      .n;
    expect(after).toBe(before);
    // presence shows in the directory
    expect((await as('expert').get('/api/communications/directory')).body.find((x: any) => x.id === me.reshead.id).online).toBe(true);
    reshead.disconnect();
    outsider.disconnect();
  });

  it('closes the sockets of a user whose sessions are revoked', async () => {
    const s = await connect(tokens.clerk);
    const closed = next(s, 'disconnect');
    expect((await as('admin').patch(`/api/users/${me.clerk.id}`, { isActive: false })).status).toBe(200);
    await closed;
    await expect(connect(tokens.clerk)).rejects.toThrow(/unauthorized/);
  });
});
