import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { migrate } from '../src/db/migrate.js';
import { pool } from '../src/db/pool.js';
import { seed, SEED_PASSWORD } from '../src/db/seed.js';
import { remindCouncilDeadlines } from '../src/routes/council.js';

/**
 * شورای گفت‌وگو: a case referred by a commission resolution, reviewed by an expert meeting, decided by the provincial
 * council, approved for the national level by the chamber's president himself, decided nationally, closed, reopened.
 */
const app = createApp();
const tokens: Record<string, string> = {};
const ids: Record<string, string> = {};
let yazd: string;
let isf: string;
let iran: string;
const body: Record<string, string> = {};
let caseId: string;

const as = (who: string) => ({
  get: (url: string) => request(app).get(url).set('authorization', `Bearer ${tokens[who]}`),
  post: (url: string, b: object = {}) => request(app).post(url).set('authorization', `Bearer ${tokens[who]}`).send(b),
  patch: (url: string, b: object = {}) => request(app).patch(url).set('authorization', `Bearer ${tokens[who]}`).send(b),
});
const login = async (who: string, email: string) => {
  const r = await request(app).post('/api/auth/login').send({ identifier: email, password: SEED_PASSWORD });
  expect(r.status).toBe(200);
  tokens[who] = r.body.accessToken;
};
const uid = async (email: string) => (await pool.query('SELECT id FROM users WHERE email = $1', [email])).rows[0].id as string;
const act = (who: string, b: object, id = caseId) => as(who).post(`/api/council-cases/${id}/actions`, b);
const tomorrow = () => new Date(Date.now() + 86_400_000).toISOString();

/** A meeting of a body, already held, with a resolution on the case's agenda item. */
async function heldResolution(who: string, meetingId: string, commissionId: string, text: string, dueDate = '2030-01-01') {
  await pool.query(`UPDATE meetings SET status = 'minutes_draft' WHERE id = $1`, [meetingId]);
  const item = (await pool.query('SELECT id FROM agenda_items WHERE meeting_id = $1 AND council_case_id = $2', [meetingId, caseId])).rows[0].id;
  const r = await as(who).post('/api/resolutions', { commissionId, meetingId, agendaItemId: item, text, dueDate });
  expect(r.status).toBe(201);
  return r.body.id as string;
}

beforeAll(async () => {
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await migrate(false);
  await seed();
  for (const [who, email] of [
    ['root', 'root@kx.local'],
    ['admin', 'admin@kx.local'],
    ['sec', 'secretary@kx.local'],
    ['m1', 'member1@kx.local'],
    ['councilSec', 'member4@kx.local'],
    ['councilMember', 'member5@kx.local'],
    ['guest', 'guest@kx.local'],
    ['isf', 'admin.isf@kx.local'],
    ['auditor', 'auditor@kx.local'],
  ]) {
    await login(who, email);
    ids[who] = await uid(email);
  }
  yazd = (await pool.query(`SELECT chamber_id FROM users WHERE email = 'admin@kx.local'`)).rows[0].chamber_id;
  isf = (await pool.query(`SELECT chamber_id FROM users WHERE email = 'admin.isf@kx.local'`)).rows[0].chamber_id;
});

describe('council bodies', () => {
  it('Iran Chamber is the one national chamber, set by the IT administrator', async () => {
    const r = await as('root').post('/api/chambers', { name: 'اتاق ایران', province: 'تهران', kind: 'national' });
    expect(r.status).toBe(201);
    iran = r.body.id;
    expect((await as('root').post('/api/chambers', { name: 'اتاق ملی دوم', province: 'تهران', kind: 'national' })).body.error.code).toBe('national_exists');
    expect((await as('admin').patch(`/api/chambers/${yazd}`, { kind: 'national' })).status).toBe(403);
  });

  it('the chamber admin defines the provincial council, its expert group and its secretary (the president)', async () => {
    const term = (await pool.query('SELECT id FROM terms WHERE chamber_id = $1', [yazd])).rows[0].id;
    // The president signs in to approve himself: given a login by the IT administrator.
    const pres = await as('root').post('/api/people', { chamberId: yazd, fullName: 'رئیس اتاق یزد', email: 'president@kx.local', mobile: '09121112233', password: 'Pres!dent-1405' });
    expect(pres.status).toBe(201);
    ids.president = pres.body.id;
    tokens.president = (await request(app).post('/api/auth/login').send({ identifier: 'president@kx.local', password: 'Pres!dent-1405' })).body.accessToken;
    expect((await as('admin').post('/api/commissions', { chamberId: yazd, termId: term, name: 'شورای گفت‌وگوی یزد', code: 'SHG', bodyType: 'council', councilSecretaryId: ids.m1 })).status).toBe(201);
    // One council per chamber; the president is set on the council.
    body.council = (await pool.query(`SELECT id FROM commissions WHERE code = 'SHG'`)).rows[0].id;
    expect((await as('admin').post('/api/commissions', { chamberId: yazd, termId: term, name: 'شورای دوم', code: 'SHG2', bodyType: 'council' })).body.error.code).toBe('council_exists');
    expect((await as('admin').patch(`/api/commissions/${body.council}`, { councilSecretaryId: ids.president })).status).toBe(200);
    const ex = await as('admin').post('/api/commissions', { chamberId: yazd, termId: term, name: 'کارگروه کارشناسی یزد', code: 'KRG', bodyType: 'expert_group', councilSecretaryId: ids.president });
    expect(ex.status).toBe(400);
    body.expert = (await as('admin').post('/api/commissions', { chamberId: yazd, termId: term, name: 'کارگروه کارشناسی یزد', code: 'KRG', bodyType: 'expert_group' })).body.id;
    // The council is a section of its own: not among the chamber's commissions or their statistics.
    const codes = async (q = '') => (await as('admin').get(`/api/commissions?pageSize=100${q}`)).body.items.map((k: any) => k.code).sort();
    expect(await codes()).not.toContain('SHG');
    expect(await codes('&bodyType=council')).toEqual(['KRG', 'SHG']);
    const dash = (await as('admin').get(`/api/dashboard/chamber?chamberId=${yazd}`)).body;
    expect(dash.commissions.map((k: any) => k.code)).not.toContain('SHG');
    for (const [b, who, position] of [
      [body.council, 'councilSec', 'secretary'],
      [body.expert, 'councilSec', 'secretary'],
      [body.council, 'councilMember', 'member'],
    ]) {
      expect((await as('admin').post(`/api/commissions/${b}/members`, { userId: ids[who], position, startDate: '2023-04-21' })).status).toBe(201);
    }

    // Iran Chamber's council, expert group and secretariat (prepared directly).
    const t = (await pool.query(`INSERT INTO terms (chamber_id, number, title, start_date, status) VALUES ($1, 1, 'دورهٔ اول', '2025-03-21', 'active') RETURNING id`, [iran])).rows[0].id;
    const people = await pool.query(
      `INSERT INTO users (chamber_id, full_name, email, mobile, password_hash)
         SELECT $1, n, e, m, (SELECT password_hash FROM users WHERE email = 'admin@kx.local')
           FROM (VALUES ('رئیس اتاق ایران', 'iran.president@kx.local', '09120009001'), ('دبیرخانهٔ ملی', 'iran.sec@kx.local', '09120009002')) v(n, e, m)
       RETURNING id, email`,
      [iran],
    );
    const pid = (e: string) => people.rows.find((r: any) => r.email === e).id;
    body.nCouncil = (
      await pool.query(
        `INSERT INTO commissions (chamber_id, term_id, name, code, body_type, council_secretary_id) VALUES ($1,$2,'شورای ملی گفت‌وگو','NSHG','council',$3) RETURNING id`,
        [iran, t, pid('iran.president@kx.local')],
      )
    ).rows[0].id;
    body.nExpert = (await pool.query(`INSERT INTO commissions (chamber_id, term_id, name, code, body_type) VALUES ($1,$2,'کارگروه کارشناسی ملی','NKRG','expert_group') RETURNING id`, [iran, t])).rows[0].id;
    for (const b of [body.nCouncil, body.nExpert]) {
      await pool.query(`INSERT INTO commission_memberships (chamber_id, commission_id, user_id, position, has_vote, start_date) VALUES ($1,$2,$3,'secretary',false,'2025-03-21')`, [iran, b, pid('iran.sec@kx.local')]);
    }
    await login('nSec', 'iran.sec@kx.local');
    await login('nPres', 'iran.president@kx.local');
  });
});

describe('a council case', () => {
  it('is opened from a commission resolution, whose deadline is the stage deadline', async () => {
    const exp = (await pool.query(`SELECT id FROM commissions WHERE code = 'EXP'`)).rows[0].id;
    const noDue = await as('sec').post('/api/resolutions', { commissionId: exp, text: 'ارجاع موانع صادرات به شورای گفت‌وگو' });
    expect((await as('sec').post('/api/council-cases', { resolutionId: noDue.body.id })).body.error.code).toBe('resolution_due_required');
    await as('sec').patch(`/api/resolutions/${noDue.body.id}`, { dueDate: '2030-06-01' });
    expect((await as('m1').post('/api/council-cases', { resolutionId: noDue.body.id })).status).toBe(403);
    const r = await as('sec').post('/api/council-cases', { resolutionId: noDue.body.id, priority: 'high' });
    expect(r.status).toBe(201);
    caseId = r.body.id;
    expect(r.body).toMatchObject({ level: 'provincial', status: 'expert_review', priority: 'high', due_date: expect.stringContaining('2030-06') });
    expect(r.body.code).toMatch(/^\d{4}-\d{4}$/);
    expect((await as('sec').post('/api/council-cases', { resolutionId: noDue.body.id })).body.error.code).toBe('already_referred');
    // The council's secretariat and president hear about it.
    const n = await pool.query(`SELECT user_id FROM notifications WHERE event = 'council.case_opened'`);
    expect(n.rows.map((x) => x.user_id).sort()).toEqual([ids.councilSec, ids.president].sort());
  });

  it('is seen by its commission and the province’s council, never by another province or the IT staff', async () => {
    for (const who of ['sec', 'm1', 'councilSec', 'councilMember', 'president', 'admin']) {
      expect((await as(who).get(`/api/council-cases/${caseId}`)).status).toBe(200);
    }
    for (const who of ['isf', 'guest', 'auditor', 'nSec']) expect((await as(who).get(`/api/council-cases/${caseId}`)).status).toBe(404);
    expect((await as('isf').get('/api/council-cases')).body.items).toEqual([]);
    const d = (await as('councilSec').get(`/api/council-cases/${caseId}`)).body;
    expect(d.roles).toEqual(['secretariat', 'origin']);
    expect(d.actions.map((a: any) => a.action)).toEqual(['schedule', 'resolve', 'return']);
    expect((await as('sec').get(`/api/council-cases/${caseId}`)).body.actions).toEqual([]);
  });

  it('goes to an expert meeting with the experts invited for this case', async () => {
    const m = await as('councilSec').post('/api/meetings', { commissionId: body.expert, title: 'جلسهٔ کارشناسی موانع صادرات', scheduledAt: tomorrow(), allowHoliday: true });
    expect(m.status).toBe(201);
    body.expertMeeting = m.body.id;
    // A government representative is invited to this meeting only.
    expect((await as('councilSec').post(`/api/meetings/${m.body.id}/invitees`, { userId: ids.guest, role: 'guest' })).status).toBe(204);
    expect((await as('councilSec').post(`/api/council-cases/${caseId}/expert-meeting`, { meetingId: m.body.id })).status).toBe(201);
    expect((await as('councilSec').post(`/api/council-cases/${caseId}/expert-meeting`, { meetingId: m.body.id })).status).toBe(409);
    expect((await as('guest').get(`/api/council-cases/${caseId}`)).status).toBe(200);
    // A commission meeting is not an expert meeting.
    const exp = (await pool.query(`SELECT id FROM commissions WHERE code = 'EXP'`)).rows[0].id;
    const other = await as('sec').post('/api/meetings', { commissionId: exp, title: 'جلسهٔ کمیسیون', scheduledAt: tomorrow(), allowHoliday: true });
    expect((await as('councilSec').post(`/api/council-cases/${caseId}/expert-meeting`, { meetingId: other.body.id })).status).toBe(403);
  });

  it('is put on the provincial council’s agenda and proposed for the national level', async () => {
    const m = await as('councilSec').post('/api/meetings', { commissionId: body.council, title: 'جلسهٔ شورای گفت‌وگوی یزد', scheduledAt: tomorrow(), allowHoliday: true });
    body.councilMeeting = m.body.id;
    expect((await act('councilSec', { action: 'schedule' })).status).toBe(400);
    expect((await act('councilSec', { action: 'schedule', meetingId: body.expertMeeting })).status).toBe(400);
    const s = await act('councilSec', { action: 'schedule', meetingId: m.body.id });
    expect(s.status).toBe(200);
    expect(s.body.status).toBe('on_agenda');
    expect(s.body.provincial_agenda_at).toBeTruthy();
    const agenda = (await as('councilSec').get(`/api/meetings/${m.body.id}`)).body.agenda;
    expect(agenda[0].title).toContain('پروندهٔ');

    // The decision is the council meeting's resolution; a resolution of the expert meeting does not do.
    const expertRes = await heldResolution('councilSec', body.expertMeeting, body.expert, 'نظر کارشناسی: ارجاع به ملی پیشنهاد می‌شود');
    expect((await act('councilSec', { action: 'propose_escalation', resolutionId: expertRes })).status).toBe(400);
    const res = await heldResolution('councilSec', m.body.id, body.council, 'پرونده به شورای ملی گفت‌وگو ارجاع شود', '2030-09-01');
    const p = await act('councilSec', { action: 'propose_escalation', resolutionId: res });
    expect(p.status).toBe(200);
    expect(p.body).toMatchObject({ status: 'pending_approval', level: 'provincial', due_date: expect.stringContaining('2030-09') });
    const n = await pool.query(`SELECT user_id FROM notifications WHERE event = 'council.approval_needed'`);
    expect(n.rows.map((x) => x.user_id)).toEqual([ids.president]);
  });

  it('reaches the national council only with the president’s own approval', async () => {
    const denied = await act('councilSec', { action: 'approve_escalation' });
    expect(denied.status).toBe(403);
    expect(denied.body.error.message).toContain('رئیس اتاق');
    expect((await act('president', { action: 'reject_escalation' })).status).toBe(400); // a reason is required
    expect((await act('president', { action: 'reject_escalation', reason: 'نظر کارشناسی کامل نیست' })).body.status).toBe('on_agenda');
    const res2 = (await pool.query(`SELECT r.id FROM resolutions r JOIN commissions k ON k.id = r.commission_id WHERE k.code = 'SHG'`)).rows[0].id;
    await act('councilSec', { action: 'propose_escalation', resolutionId: res2 });
    const ok = await act('president', { action: 'approve_escalation' });
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ level: 'national', status: 'expert_review' });
    expect(ok.body.national_reached_at).toBeTruthy();
    // Now the national secretariat acts; the province follows without acting.
    expect((await as('nSec').get(`/api/council-cases/${caseId}`)).body.roles).toEqual(['secretariat']);
    expect((await as('councilSec').get(`/api/council-cases/${caseId}`)).body.actions).toEqual([]);
    expect((await act('councilSec', { action: 'schedule', meetingId: body.councilMeeting })).status).toBe(403);
    expect((await as('isf').get(`/api/council-cases/${caseId}`)).status).toBe(404);
  });

  it('is decided nationally, closed with its outcome and reopened only by the national president', async () => {
    const m = await as('nSec').post('/api/meetings', { commissionId: body.nCouncil, title: 'جلسهٔ شورای ملی', scheduledAt: tomorrow(), allowHoliday: true });
    expect((await act('nSec', { action: 'schedule', meetingId: m.body.id })).body.status).toBe('on_agenda');
    const res = await heldResolution('nSec', m.body.id, body.nCouncil, 'تمدید مهلت رفع تعهد ارزی صادرکنندگان تصویب شد');
    expect((await act('nSec', { action: 'resolve', resolutionId: res })).body.status).toBe('resolved');
    expect((await act('nSec', { action: 'close' })).status).toBe(400); // the outcome is required
    const closed = await act('nSec', { action: 'close', outcome: 'مهلت رفع تعهد ارزی سه ماه تمدید شد و به اتاق یزد ابلاغ شد' });
    expect(closed.body).toMatchObject({ status: 'closed', outcome: expect.stringContaining('تمدید') });
    expect(closed.body.closed_at).toBeTruthy();
    expect((await act('nSec', { action: 'reopen', reason: 'درخواست بازنگری' })).status).toBe(403);
    expect((await act('nPres', { action: 'resolve' })).body.error.code).toBe('invalid_transition');
    const re = await act('nPres', { action: 'reopen', reason: 'درخواست بازنگری اتاق یزد' });
    expect(re.body).toMatchObject({ status: 'expert_review', level: 'national' });
    expect(re.body.closed_at).toBeNull();
    // The originating commission saw it to the end.
    const d = (await as('sec').get(`/api/council-cases/${caseId}`)).body;
    expect(d.events.map((e: any) => e.event)).toEqual([
      'opened', 'expert_meeting', 'schedule', 'propose_escalation', 'reject_escalation', 'propose_escalation', 'approve_escalation', 'schedule', 'resolve', 'close', 'reopen',
    ]);
    expect(d.events.find((e: any) => e.event === 'reject_escalation').reason).toBe('نظر کارشناسی کامل نیست');
    await expect(pool.query(`UPDATE council_case_events SET reason = 'x'`)).rejects.toThrow(/append-only/);
    await expect(pool.query(`DELETE FROM council_case_events`)).rejects.toThrow(/append-only/);
  });

  it('a confidential case from the chamber: hidden from members until it is on the agenda; returned and resubmitted', async () => {
    expect((await as('m1').post('/api/council-cases', { chamberId: yazd, title: 'پروندهٔ محرمانهٔ ارزی', dueDate: '2030-02-01' })).status).toBe(403);
    const r = await as('councilSec').post('/api/council-cases', { chamberId: yazd, title: 'پروندهٔ محرمانهٔ ارزی', dueDate: '2030-02-01', confidential: true });
    expect(r.status).toBe(201);
    const id = r.body.id;
    for (const who of ['councilMember', 'm1', 'sec']) expect((await as(who).get(`/api/council-cases/${id}`)).status).toBe(404);
    for (const who of ['councilSec', 'president', 'admin']) expect((await as(who).get(`/api/council-cases/${id}`)).status).toBe(200);
    expect((await act('councilSec', { action: 'return' }, id)).status).toBe(400);
    expect((await act('councilSec', { action: 'return', reason: 'مستندات ارزی پیوست نشده' }, id)).body.status).toBe('returned');
    expect((await act('councilSec', { action: 'resubmit' }, id)).body.status).toBe('expert_review');
    const second = await as('councilSec').post('/api/meetings', { commissionId: body.council, title: 'جلسهٔ دوم شورا', scheduledAt: tomorrow(), allowHoliday: true });
    expect((await act('councilSec', { action: 'schedule', meetingId: second.body.id }, id)).body.status).toBe('on_agenda');
    expect((await as('councilMember').get(`/api/council-cases/${id}`)).status).toBe(200);
    // Opening a confidential case is audited.
    const log = await as('auditor').get(`/api/audit?action=council.case_viewed&entityId=${id}`);
    expect(log.body.total).toBeGreaterThan(0);
  });

  it('reminds the secretariat when a stage deadline passes', async () => {
    await pool.query(`UPDATE council_cases SET due_date = current_date - 1 WHERE id = $1`, [caseId]);
    await remindCouncilDeadlines();
    const n = await pool.query(`SELECT user_id, title FROM notifications WHERE event = 'council.case_due'`);
    expect(n.rows.length).toBe(1);
    expect(n.rows[0].user_id).toBe((await uid('iran.sec@kx.local')));
    expect(n.rows[0].title).toContain('گذشته است');
    await remindCouncilDeadlines();
    expect((await pool.query(`SELECT count(*)::int AS n FROM notifications WHERE event = 'council.case_due'`)).rows[0].n).toBe(1);
    const late = await as('nSec').get('/api/council-cases?overdue=true');
    expect(late.body.items.map((c: any) => c.id)).toEqual([caseId]);
  });
});
