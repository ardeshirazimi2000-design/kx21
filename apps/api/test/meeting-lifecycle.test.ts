import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { io as ioClient, type Socket } from 'socket.io-client';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { migrate } from '../src/db/migrate.js';
import { pool } from '../src/db/pool.js';
import { seed, SEED_PASSWORD } from '../src/db/seed.js';
import { closeRealtime, initRealtime } from '../src/realtime.js';
import { runScheduledJobs } from '../src/services/scheduler.js';

const app = createApp();
let server: http.Server;
let baseUrl: string;
const tokens: Record<string, string> = {};
const ids: Record<string, string> = {};

const as = (who: string) => ({
  get: (url: string) => request(app).get(url).set('authorization', `Bearer ${tokens[who]}`),
  post: (url: string, body: object = {}) => request(app).post(url).set('authorization', `Bearer ${tokens[who]}`).send(body),
  patch: (url: string, body: object = {}) => request(app).patch(url).set('authorization', `Bearer ${tokens[who]}`).send(body),
});

async function login(who: string, email: string) {
  const r = await request(app).post('/api/auth/login').send({ identifier: email, password: SEED_PASSWORD });
  expect(r.status).toBe(200);
  tokens[who] = r.body.accessToken;
  const me = await as(who).get('/api/auth/me');
  ids[who] = me.body.id;
}

function connect(who: string): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const s = ioClient(baseUrl, { auth: { token: tokens[who] }, transports: ['websocket'], forceNew: true });
    s.on('connect', () => resolve(s));
    s.on('connect_error', reject);
  });
}

function waitFor<T = any>(s: Socket, event: string, pred: (p: T) => boolean = () => true, ms = 3000): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timeout waiting for ${event}`)), ms);
    const h = (p: T) => {
      if (pred(p)) {
        clearTimeout(t);
        s.off(event, h);
        resolve(p);
      }
    };
    s.on(event, h);
  });
}

function collect(s: Socket, event: string) {
  const got: any[] = [];
  s.on(event, (p) => got.push(p));
  return got;
}

beforeAll(async () => {
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await migrate(false);
  await seed();
  server = http.createServer(app);
  initRealtime(server);
  await new Promise<void>((r) => server.listen(0, r));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  await login('admin', 'admin@kx.local');
  await login('root', 'root@kx.local');
  await login('chair', 'chair@kx.local');
  await login('secretary', 'secretary@kx.local');
  for (let i = 1; i <= 6; i++) await login(`m${i}`, `member${i}@kx.local`);
  await login('expert', 'expert@kx.local');
  await login('guest', 'guest@kx.local');
});

afterAll(async () => {
  await closeRealtime();
  await new Promise((r) => server.close(r));
  await pool.end();
});

describe('authentication', () => {
  it('rejects wrong passwords and anonymous calls', async () => {
    expect((await request(app).post('/api/auth/login').send({ identifier: 'chair@kx.local', password: 'nope' })).status).toBe(401);
    expect((await request(app).get('/api/meetings')).status).toBe(401);
  });

  it('rotates refresh tokens and detects reuse', async () => {
    const l = await request(app).post('/api/auth/login').send({ identifier: '09120000010', password: SEED_PASSWORD });
    const r1 = await request(app).post('/api/auth/refresh').send({ refreshToken: l.body.refreshToken });
    expect(r1.status).toBe(200);
    // reusing the old token is rejected and revokes the family
    expect((await request(app).post('/api/auth/refresh').send({ refreshToken: l.body.refreshToken })).status).toBe(401);
    expect((await request(app).post('/api/auth/refresh').send({ refreshToken: r1.body.refreshToken })).status).toBe(401);
  });
});

describe('meeting lifecycle', () => {
  let meetingId: string;
  let agenda: any[];
  let secSocket: Socket;
  let memberSocket: Socket;
  let memberAttendanceEvents: any[];

  it('lists the upcoming meeting for an invited member', async () => {
    const r = await as('m1').get('/api/meetings?mine=true');
    expect(r.status).toBe(200);
    const m = r.body.items.find((x: any) => x.number === 13);
    expect(m).toBeTruthy();
    meetingId = m.id;
    const d = await as('m1').get(`/api/meetings/${meetingId}`);
    agenda = d.body.agenda;
    expect(agenda).toHaveLength(3);
    expect(d.body.my.hasVote).toBe(true);
    // members do not see live attendance status of others
    expect(d.body.invitees[0].status).toBeUndefined();
  });

  it('keeps meetings of other commissions and uninvited experts out', async () => {
    expect((await as('expert').get(`/api/meetings/${meetingId}`)).status).toBe(404);
    const other = await as('secretary').get('/api/commissions');
    const enr = other.body.items.find((c: any) => c.code === 'ENR');
    // member5 is not in the energy commission
    expect((await as('m5').get(`/api/commissions/${enr.id}`)).status).toBe(404);
  });

  it('does not allow check-in before it is opened', async () => {
    const r = await as('m1').post(`/api/meetings/${meetingId}/check-in`);
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe('checkin_closed');
  });

  it('opens check-in and streams attendance in real time', async () => {
    secSocket = await connect('secretary');
    memberSocket = await connect('m2');
    await new Promise((r) => secSocket.emit('meeting:join', meetingId, r));
    await new Promise((r) => memberSocket.emit('meeting:join', meetingId, r));
    memberAttendanceEvents = collect(memberSocket, 'attendance.updated');

    expect((await as('m1').post(`/api/meetings/${meetingId}/checkin/open`)).status).toBe(403);
    expect((await as('secretary').post(`/api/meetings/${meetingId}/checkin/open`)).status).toBe(200);

    const officerEvent = waitFor(secSocket, 'attendance.updated', (p) => p.attendance.some((a: any) => a.user_id === ids.m1 && a.status === 'present'));
    const memberQuorum = waitFor(memberSocket, 'quorum.updated', (p) => p.quorum.present >= 1);
    const r = await as('m1').post(`/api/meetings/${meetingId}/check-in`, { method: 'app' });
    expect(r.status).toBe(201);
    expect(r.body.checked_in_at).toBeTruthy();
    const ev = await officerEvent;
    expect(ev.quorum.required).toBe(5); // 8 voting members → 5
    const q = await memberQuorum;
    expect(q.quorum).not.toHaveProperty('breakdown');

    // idempotent check-in: no duplicate and same timestamp
    const again = await as('m1').post(`/api/meetings/${meetingId}/check-in`, { method: 'app' });
    expect(again.status).toBe(200);
    expect(again.body.checked_in_at).toBe(r.body.checked_in_at);
    const { rows } = await pool.query('SELECT count(*)::int AS n FROM attendance WHERE meeting_id = $1 AND user_id = $2', [meetingId, ids.m1]);
    expect(rows[0].n).toBe(1);
  });

  it('gives members only the summary and officers the full list', async () => {
    const m = await as('m1').get(`/api/meetings/${meetingId}/attendance`);
    expect(m.body.attendance).toBeUndefined();
    expect(m.body.me.status).toBe('present');
    const s = await as('secretary').get(`/api/meetings/${meetingId}/attendance`);
    expect(s.body.attendance.length).toBeGreaterThan(8);
    expect(s.body.quorum.explanation).toContain('حد نصاب');
    expect(memberAttendanceEvents).toHaveLength(0);
  });

  it('lets the secretary correct attendance only with a reason, and audits it', async () => {
    const bad = await as('secretary').post(`/api/meetings/${meetingId}/attendance/${ids.m6}/confirm`, { status: 'excused' });
    expect(bad.status).toBe(400);
    const ok = await as('secretary').post(`/api/meetings/${meetingId}/attendance/${ids.m6}/confirm`, { status: 'excused', reason: 'مأموریت خارج از کشور' });
    expect(ok.status).toBe(200);
    expect(ok.body.status).toBe('excused');
    const audit = await as('admin').get(`/api/audit?entity=attendance&entityId=${meetingId}:${ids.m6}`);
    expect(audit.body.items[0].action).toBe('attendance.corrected');
    expect(audit.body.items[0].reason).toBe('مأموریت خارج از کشور');
  });

  it('only the chair/secretary can start the meeting', async () => {
    expect((await as('m1').post(`/api/meetings/${meetingId}/start`)).status).toBe(403);
    expect((await as('admin').post(`/api/meetings/${meetingId}/start`)).status).toBe(403);
    const r = await as('chair').post(`/api/meetings/${meetingId}/start`);
    expect(r.status).toBe(200);
    expect(r.body.status).toBe('in_progress');
    expect(r.body.started_at).toBeTruthy();
    // cannot start twice
    expect((await as('chair').post(`/api/meetings/${meetingId}/start`)).status).toBe(409);
  });

  it('runs the agenda and blocks voting without quorum', async () => {
    const item = agenda[1];
    expect((await as('chair').post(`/api/agenda-items/${item.id}/vote/start`)).status).toBe(409); // not active
    const act = await as('chair').post(`/api/meetings/${meetingId}/agenda/${item.id}/activate`);
    expect(act.status).toBe(204);
    const d = await as('m1').get(`/api/meetings/${meetingId}`);
    expect(d.body.status).toBe('agenda_processing');
    expect(d.body.agenda.filter((a: any) => a.status === 'active')).toHaveLength(1);

    const r = await as('chair').post(`/api/agenda-items/${item.id}/vote/start`);
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe('quorum_not_reached');
  });

  it('collects votes once per member after quorum is reached', async () => {
    const item = agenda[1];
    for (const w of ['chair', 'm2', 'm3', 'm4']) {
      expect((await as(w).post(`/api/meetings/${meetingId}/check-in`, { method: w === 'm4' ? 'online' : 'app' })).status).toBe(201);
    }
    await as('guest').post(`/api/meetings/${meetingId}/check-in`);
    const opened = waitFor(memberSocket, 'vote.opened');
    const start = await as('chair').post(`/api/agenda-items/${item.id}/vote/start`, { title: 'تصویب پیشنهاد مکاتبه با بانک مرکزی' });
    expect(start.status).toBe(201);
    expect((await opened).id).toBe(start.body.id);

    const progress = waitFor(memberSocket, 'vote.progress', (p) => p.castCount === 1);
    expect((await as('m1').post(`/api/agenda-items/${item.id}/vote`, { choice: 'yes' })).status).toBe(201);
    expect((await progress).eligible).toBe(5);
    const dup = await as('m1').post(`/api/agenda-items/${item.id}/vote`, { choice: 'no' });
    expect(dup.status).toBe(409);
    expect(dup.body.error.code).toBe('already_voted');
    expect((await as('guest').post(`/api/agenda-items/${item.id}/vote`, { choice: 'yes' })).status).toBe(403);
    expect((await as('m5').post(`/api/agenda-items/${item.id}/vote`, { choice: 'yes' })).status).toBe(403); // not checked in
    expect((await as('m2').post(`/api/agenda-items/${item.id}/vote`, { choice: 'invalid' })).status).toBe(400);

    // concurrent ballots
    const results = await Promise.all([
      as('m2').post(`/api/agenda-items/${item.id}/vote`, { choice: 'yes' }),
      as('m3').post(`/api/agenda-items/${item.id}/vote`, { choice: 'yes' }),
      as('m4').post(`/api/agenda-items/${item.id}/vote`, { choice: 'no' }),
      as('chair').post(`/api/agenda-items/${item.id}/vote`, { choice: 'yes' }),
      as('chair').post(`/api/agenda-items/${item.id}/vote`, { choice: 'yes' }),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([201, 201, 201, 201, 409]);

    expect((await as('m1').post(`/api/agenda-items/${item.id}/vote/close`)).status).toBe(403);
    const closed = waitFor(memberSocket, 'vote.closed');
    const close = await as('chair').post(`/api/agenda-items/${item.id}/vote/close`);
    expect(close.status).toBe(200);
    expect(close.body.result.counts).toEqual({ yes: 4, no: 1, abstain: 0 });
    expect(close.body.result.passed).toBe(true);
    expect((await closed).result.totalCast).toBe(5);
    ids.vote1 = close.body.id;

    // vote cannot change after close
    expect((await as('m3').post(`/api/agenda-items/${item.id}/vote`, { choice: 'no' })).status).toBe(409);
    const vs = await as('m1').get(`/api/vote-sessions/${ids.vote1}`);
    expect(vs.body.my_choice).toBe('yes');
    expect(vs.body.voters).toHaveLength(5);
  });

  it('hides voter identity for secret ballots', async () => {
    const item = agenda[2];
    await as('chair').post(`/api/meetings/${meetingId}/agenda/${item.id}/activate`);
    const s = await as('secretary').post(`/api/agenda-items/${item.id}/vote/start`, { secret: true });
    expect(s.status).toBe(201);
    await as('m1').post(`/api/agenda-items/${item.id}/vote`, { choice: 'no' });
    await as('m2').post(`/api/agenda-items/${item.id}/vote`, { choice: 'abstain' });
    const c = await as('secretary').post(`/api/vote-sessions/${s.body.id}/close`);
    expect(c.body.result.passed).toBe(false);
    const vs = await as('chair').get(`/api/vote-sessions/${s.body.id}`);
    expect(vs.body.voters).toBeNull();
    // admin sees masked ballots in the audit log, super admin sees them
    const a1 = await as('admin').get(`/api/audit?action=vote.cast&entityId=${s.body.id}`);
    expect(a1.body.items[0].after.choice).toBe('***');
    const a2 = await as('root').get(`/api/audit?action=vote.cast&entityId=${s.body.id}`);
    expect(['no', 'abstain']).toContain(a2.body.items[0].after.choice);
  });

  it('accepts comments from members but not observers/guests', async () => {
    const item = agenda[2];
    const c = await as('m3').post(`/api/agenda-items/${item.id}/comments`, { body: 'با این پیشنهاد موافقم به شرط تعیین زمان‌بندی.' });
    expect(c.status).toBe(201);
    expect((await as('guest').post(`/api/agenda-items/${item.id}/comments`, { body: 'نظر' })).status).toBe(403);
    const list = await as('m1').get(`/api/agenda-items/${item.id}/comments`);
    expect(list.body).toHaveLength(1);
  });

  it('ends the meeting and drafts the minutes automatically', async () => {
    const r = await as('chair').post(`/api/meetings/${meetingId}/end`);
    expect(r.status).toBe(200);
    expect(r.body.status).toBe('minutes_draft');
    // late check-in after the meeting is not possible
    expect((await as('m5').post(`/api/meetings/${meetingId}/check-in`)).status).toBe(409);
    const min = await as('secretary').get(`/api/meetings/${meetingId}/minutes`);
    expect(min.status).toBe(200);
    expect(min.body.body).toContain('دکتر علی رضایی');
    expect(min.body.body).toContain('موافق: ۴');
    expect(min.body.body).toContain('غیبت موجه');
    ids.minutes = min.body.id;
    // members cannot read the draft
    expect((await as('m1').get(`/api/meetings/${meetingId}/minutes`)).status).toBe(404);
  });

  it('runs the minutes approval workflow and locks the final version', async () => {
    const edit = await as('secretary').post(`/api/meetings/${meetingId}/minutes`, { body: '# صورتجلسه ویرایش‌شده\n\nمتن نهایی صورتجلسه.' });
    expect(edit.body.version).toBe(2);
    expect((await as('secretary').post(`/api/minutes/${ids.minutes}/approve`)).status).toBe(403);
    expect((await as('secretary').post(`/api/minutes/${ids.minutes}/submit`)).status).toBe(204);
    expect((await as('chair').post(`/api/minutes/${ids.minutes}/return`, { reason: 'اسامی غایبین اضافه شود' })).status).toBe(204);
    expect((await as('secretary').post(`/api/meetings/${meetingId}/minutes`, { regenerate: true })).body.version).toBe(3);
    expect((await as('secretary').post(`/api/minutes/${ids.minutes}/submit`)).status).toBe(204);
    const ap = await as('chair').post(`/api/minutes/${ids.minutes}/approve`);
    expect(ap.status).toBe(200);
    expect(ap.body.status).toBe('approved');
    expect(ap.body.minutes_number).toMatch(/^EXP\/14\d\d\/13$/);
    expect(ap.body.content_hash).toHaveLength(64);
    expect((await as('secretary').post(`/api/meetings/${meetingId}/minutes`, { body: 'تغییر غیرمجاز پس از تأیید' })).status).toBe(409);
    await expect(pool.query(`UPDATE minutes SET body = 'x' WHERE id = $1`, [ids.minutes])).rejects.toThrow(/locked/);
    expect((await as('m1').get(`/api/meetings/${meetingId}/minutes`)).status).toBe(200);
  });

  it('creates resolutions from passed votes and tracks follow-up', async () => {
    const commissionId = (await as('secretary').get(`/api/meetings/${meetingId}`)).body.commission.id;
    const r = await as('secretary').post('/api/resolutions', {
      commissionId,
      meetingId,
      agendaItemId: agenda[1].id,
      voteSessionId: ids.vote1,
      text: 'دبیرخانه مکلف است ظرف دو هفته مکاتبه لازم با بانک مرکزی را انجام دهد.',
      ownerId: ids.m1,
      addressee: 'بانک مرکزی',
      dueDate: '2099-01-01',
      priority: 'high',
    });
    expect(r.status).toBe(201);
    expect(r.body.number).toBe('EXP-003');
    const resId = r.body.id;
    expect((await as('m1').get('/api/tasks')).body.some((t: any) => t.resolution_id === resId)).toBe(true);
    expect((await as('m2').patch(`/api/resolutions/${resId}/progress`, { progress: 50 })).status).toBe(403);
    expect((await as('m1').patch(`/api/resolutions/${resId}/progress`, { progress: 60, note: 'نامه ارسال شد' })).body.status).toBe('in_progress');
    expect((await as('m1').patch(`/api/resolutions/${resId}/progress`, { progress: 100, note: 'پاسخ دریافت شد' })).body.status).toBe('submitted');
    expect((await as('m1').post(`/api/resolutions/${resId}/review`, { approve: true })).status).toBe(403);
    const rv = await as('secretary').post(`/api/resolutions/${resId}/review`, { approve: true, note: 'تأیید شد' });
    expect(rv.body.status).toBe('done');
    const notes = await as('m1').get('/api/notifications');
    expect(notes.body.items.some((n: any) => n.event === 'resolution.reviewed')).toBe(true);
  });

  it('refuses resolutions for rejected votes', async () => {
    const meeting = (await as('secretary').get(`/api/meetings/${meetingId}`)).body;
    const secret = meeting.votes.find((v: any) => v.secret);
    const r = await as('secretary').post('/api/resolutions', { commissionId: meeting.commission.id, voteSessionId: secret.id, text: 'مصوبه رد شده' });
    expect(r.status).toBe(409);
  });

  afterAll(() => {
    secSocket?.close();
    memberSocket?.close();
  });
});

describe('meeting creation and cancellation', () => {
  it('creates a meeting with invitees and agenda, notifies on change and cancels with reason', async () => {
    const commissions = await as('secretary').get('/api/commissions');
    const exp = commissions.body.items.find((c: any) => c.code === 'EXP');
    expect((await as('m1').post('/api/meetings', { commissionId: exp.id, title: 'جلسه غیرمجاز', scheduledAt: new Date().toISOString() })).status).toBe(403);
    const r = await as('secretary').post('/api/meetings', {
      commissionId: exp.id,
      title: 'جلسه فوق‌العاده',
      scheduledAt: new Date(Date.now() + 3 * 86400000).toISOString(),
      type: 'online',
      onlineLink: 'https://meet.example.org/exp',
      agenda: [{ title: 'بررسی بخشنامه جدید گمرک' }],
    });
    expect(r.status).toBe(201);
    expect(r.body.number).toBe(14);
    const id = r.body.id;
    expect((await as('secretary').post(`/api/meetings/${id}/invite`)).body.invited).toBe(9);
    const inv = await as('m1').get('/api/notifications?unread=true');
    expect(inv.body.items.some((n: any) => n.event === 'meeting.invited' && n.data.meetingId === id)).toBe(true);
    await as('secretary').patch(`/api/meetings/${id}`, { scheduledAt: new Date(Date.now() + 4 * 86400000).toISOString() });
    const ch = await as('m1').get('/api/notifications?unread=true');
    expect(ch.body.items.some((n: any) => n.event === 'meeting.changed' && n.data.meetingId === id)).toBe(true);
    expect((await as('secretary').post(`/api/meetings/${id}/cancel`, {})).status).toBe(400);
    expect((await as('secretary').post(`/api/meetings/${id}/cancel`, { reason: 'تداخل با جلسه هیئت نمایندگان' })).status).toBe(204);
    expect((await as('secretary').get(`/api/meetings/${id}`)).body.cancel_reason).toBe('تداخل با جلسه هیئت نمایندگان');
    expect((await as('chair').post(`/api/meetings/${id}/start`)).status).toBe(409);
  });
});

describe('structure', () => {
  it('keeps membership history when positions change', async () => {
    const commissions = await as('admin').get('/api/commissions');
    const exp = commissions.body.items.find((c: any) => c.code === 'EXP');
    const members = await as('admin').get(`/api/commissions/${exp.id}/members`);
    const m6 = members.body.find((m: any) => m.user_id === ids.m6);
    expect((await as('secretary').patch(`/api/memberships/${m6.id}`, { position: 'vice_chair' })).status).toBe(403);
    const taken = await as('admin').patch(`/api/memberships/${m6.id}`, { position: 'vice_chair' });
    expect(taken.status).toBe(409);
    const r = await as('admin').patch(`/api/memberships/${m6.id}`, { position: 'observer' });
    expect(r.body.position).toBe('observer');
    expect(r.body.has_vote).toBe(false);
    const all = await as('admin').get(`/api/commissions/${exp.id}/members?includeEnded=true`);
    expect(all.body.filter((m: any) => m.user_id === ids.m6)).toHaveLength(2);
  });

  it('creates a new term and ends memberships of the previous one', async () => {
    const me = await as('admin').get('/api/auth/me');
    const chamberId = me.body.adminChambers[0];
    const t = await as('admin').post('/api/terms', { chamberId, number: 11, title: 'دوره یازدهم', startDate: '2027-04-21', status: 'active' });
    expect(t.status).toBe(201);
    const terms = await as('admin').get(`/api/terms?chamberId=${chamberId}`);
    expect(terms.body.find((x: any) => x.number === 10).status).toBe('closed');
    const { rows } = await pool.query(`SELECT count(*)::int AS n FROM commission_memberships WHERE status = 'active' AND chamber_id = $1`, [chamberId]);
    expect(rows[0].n).toBe(0);
    const { rows: hist } = await pool.query(`SELECT count(*)::int AS n FROM commission_memberships`);
    expect(hist[0].n).toBeGreaterThan(10);
  });
});

describe('multi-chamber isolation', () => {
  it('lets each provincial admin manage only its own chamber', async () => {
    await login('isf', 'admin.isf@kx.local');
    const yazdChamber = (await as('admin').get('/api/auth/me')).body.adminChambers[0];
    const isfChamber = (await as('isf').get('/api/auth/me')).body.adminChambers[0];
    expect(isfChamber).not.toBe(yazdChamber);

    // each admin sees only its own chamber and commissions
    expect((await as('isf').get('/api/chambers')).body.map((c: any) => c.id)).toEqual([isfChamber]);
    const isfList = await as('isf').get('/api/commissions');
    expect(isfList.body.items.every((c: any) => c.chamber_id === isfChamber)).toBe(true);
    const yazdCommission = (await as('admin').get('/api/commissions')).body.items[0];
    expect(yazdCommission.chamber_id).toBe(yazdChamber);
    expect((await as('isf').get(`/api/commissions/${yazdCommission.id}`)).status).toBe(404);
    expect((await as('isf').get(`/api/people?chamberId=${yazdChamber}`)).status).toBe(403);

    // cannot define terms/commissions in another chamber
    const yazdTerm = (await as('admin').get(`/api/terms?chamberId=${yazdChamber}`)).body[0];
    expect((await as('isf').post('/api/terms', { chamberId: yazdChamber, number: 20, title: 'دوره غیرمجاز', startDate: '2027-01-01' })).status).toBe(403);
    expect((await as('isf').post('/api/commissions', { chamberId: yazdChamber, termId: yazdTerm.id, name: 'کمیسیون غیرمجاز', code: 'BAD' })).status).toBe(403);

    // defines its own commission and cannot add a person from another chamber to it
    const isfTerm = (await as('isf').get(`/api/terms?chamberId=${isfChamber}`)).body[0];
    const created = await as('isf').post('/api/commissions', { chamberId: isfChamber, termId: isfTerm.id, name: 'کمیسیون کشاورزی اصفهان', code: 'AGR' });
    expect(created.status).toBe(201);
    expect((await as('isf').post(`/api/commissions/${created.body.id}/members`, { userId: ids.m1, position: 'member' })).status).toBe(400);
    expect((await as('admin').get(`/api/commissions/${created.body.id}`)).status).toBe(404);
  });

  it('lets the super admin create a chamber and assign its provincial admin', async () => {
    const ch = await as('root').post('/api/chambers', { name: 'اتاق بازرگانی کرمان', province: 'کرمان' });
    expect(ch.status).toBe(201);
    expect((await as('admin').post(`/api/chambers/${ch.body.id}/admins`, { userId: ids.m1 })).status).toBe(403);
    expect((await as('root').post(`/api/chambers/${ch.body.id}/admins`, { userId: ids.m1 })).status).toBe(400); // person of another chamber
    const adm = await as('root').post(`/api/chambers/${ch.body.id}/admins`, {
      person: { fullName: 'مدیر اتاق کرمان', email: 'admin.krm@kx.local', password: 'Kerman#2026' },
    });
    expect(adm.status).toBe(201);
    const l = await request(app).post('/api/auth/login').send({ identifier: 'admin.krm@kx.local', password: 'Kerman#2026' });
    tokens.krm = l.body.accessToken;
    expect((await as('krm').get('/api/auth/me')).body.adminChambers).toEqual([ch.body.id]);
    const t = await as('krm').post('/api/terms', { chamberId: ch.body.id, number: 1, title: 'دوره اول', startDate: '2026-04-21', status: 'active' });
    expect(t.status).toBe(201);
    expect((await as('krm').post('/api/commissions', { chamberId: ch.body.id, termId: t.body.id, name: 'کمیسیون معدن کرمان', code: 'MIN' })).status).toBe(201);
    const list = await as('root').get('/api/chambers');
    expect(list.body.find((c: any) => c.id === ch.body.id).admins[0].full_name).toBe('مدیر اتاق کرمان');
  });
});

describe('documents', () => {
  it('validates file content against its declared type', async () => {
    const meetings = await as('secretary').get('/api/meetings?status=approved');
    const meetingId = meetings.body.items[0].id;
    const pdf = Buffer.from('%PDF-1.4\n%âãÏÓ\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF');
    const ok = await request(app)
      .post('/api/documents')
      .set('authorization', `Bearer ${tokens.root}`)
      .field('meetingId', meetingId)
      .attach('file', pdf, { filename: 'گزارش.pdf', contentType: 'application/pdf' });
    expect(ok.status).toBe(201);
    expect(ok.body.file_name).toBe('گزارش.pdf');
    const fake = await request(app)
      .post('/api/documents')
      .set('authorization', `Bearer ${tokens.root}`)
      .field('meetingId', meetingId)
      .attach('file', Buffer.from('MZ\x90\x00binary'), { filename: 'virus.pdf', contentType: 'application/pdf' });
    expect(fake.status).toBe(400);
    const dl = await as('root').get(`/api/documents/${ok.body.id}/download`);
    expect(dl.status).toBe(200);
    expect((await as('expert').get(`/api/documents/${ok.body.id}/download`)).status).toBe(404);
    // signed short-lived link for mobile viewers
    const link = await as('root').post(`/api/documents/${ok.body.id}/link`);
    const url = new URL(link.body.url);
    expect((await request(app).get(url.pathname + url.search)).status).toBe(200);
    expect((await request(app).get(url.pathname + '?token=forged')).status).toBe(404);
  });
});

describe('audit and scheduler', () => {
  it('keeps an intact, append-only audit chain', async () => {
    const v = await as('admin').get(`/api/audit/verify?chamberId=${(await as('admin').get('/api/auth/me')).body.adminChambers[0]}`);
    expect(v.body.intact).toBe(true);
    await expect(pool.query('UPDATE audit_logs SET action = $1', ['tampered'])).rejects.toThrow(/append-only/);
    await expect(pool.query('DELETE FROM audit_logs')).rejects.toThrow(/append-only/);
    expect((await as('m1').get('/api/audit')).status).toBe(403);
  });

  it('sends overdue reminders once', async () => {
    await runScheduledJobs();
    await runScheduledJobs();
    const { rows } = await pool.query(`SELECT count(*)::int AS n FROM notifications WHERE event = 'resolution.overdue' AND user_id = $1`, [ids.secretary]);
    expect(rows[0].n).toBe(1);
    const dash = await as('admin').get(`/api/dashboard/chamber?chamberId=${(await as('admin').get('/api/auth/me')).body.adminChambers[0]}`);
    expect(dash.body.overdueResolutions.length).toBeGreaterThan(0);
  });

  it('exports resolutions as CSV only for authorised users', async () => {
    const chamberId = (await as('admin').get('/api/auth/me')).body.adminChambers[0];
    const csv = await as('admin').get(`/api/reports/resolutions?chamberId=${chamberId}&format=csv`);
    expect(csv.status).toBe(200);
    expect(csv.text).toContain('متن مصوبه');
    expect((await as('m1').get(`/api/reports/resolutions?chamberId=${chamberId}&format=csv`)).status).toBe(403);
  });
});
