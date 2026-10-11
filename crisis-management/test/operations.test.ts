import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { pool } from '../src/db/pool.js';
import { api, appLogin, bearer, consoleLogin, mobile, nationalCode, resetDb, staff } from './helpers.js';

beforeEach(resetDb);
afterAll(() => pool.end());

async function incident(t: string, districtId: number, extra: Record<string, unknown> = {}) {
  const r = await api().post('/api/console/incidents').set(bearer(t)).send({ title: `حادثه منطقه ${districtId}`, type: 'fire', districtId, ...extra });
  expect(r.status).toBe(201);
  return r.body.id as string;
}

describe('operations access by role and scope', () => {
  it('limits district coordinators to their own district', async () => {
    const op = await staff(['operator']);
    const coord = await staff(['district_coordinator'], { districtId: 3 });
    const top = await consoleLogin(op.username!);
    const tc = await consoleLogin(coord.username!);
    const inD3 = await incident(top, 3);
    const inD4 = await incident(top, 4);
    const list = await api().get('/api/console/incidents').set(bearer(tc));
    expect(list.body.map((i: { id: string }) => i.id)).toEqual([inD3]);
    expect((await api().get(`/api/console/incidents/${inD4}`).set(bearer(tc))).status).toBe(404);
    expect((await api().patch(`/api/console/incidents/${inD4}`).set(bearer(tc)).send({ title: 'تغییر' })).status).toBe(404);
    // Coordinator-created incidents are pinned to their district.
    const own = await api().post('/api/console/incidents').set(bearer(tc)).send({ title: 'آبگرفتگی معبر', type: 'flood', districtId: 4 });
    expect(own.status).toBe(403);
  });

  it('reserves crisis declaration and danger alerts for the crisis director', async () => {
    const op = await staff(['operator']);
    const dir = await staff(['crisis_director']);
    const top = await consoleLogin(op.username!);
    const td = await consoleLogin(dir.username!);
    const id = await incident(top, 1);
    expect((await api().post(`/api/console/incidents/${id}/declare`).set(bearer(top)).send({ severity: 4 })).status).toBe(403);
    expect((await api().patch(`/api/console/incidents/${id}`).set(bearer(top)).send({ severity: 3 })).status).toBe(403);
    const declared = await api().post(`/api/console/incidents/${id}/declare`).set(bearer(td)).send({ severity: 4 });
    expect(declared.body).toMatchObject({ status: 'active', severity: 4 });
    expect((await api().post('/api/console/alerts').set(bearer(td)).send({ title: 'هشدار زلزله', body: 'از ساختمان‌ها خارج شوید', level: 'danger' })).status).toBe(201);
  });

  it('lets responders see and progress only their own tasks from the app', async () => {
    const chief = await staff(['operations_chief']);
    const r1 = await staff(['responder'], { console: false, districtId: 1 });
    const r2 = await staff(['responder'], { console: false, districtId: 1 });
    const tc = await consoleLogin(chief.username!);
    const id = await incident(tc, 1);
    const task = await api().post(`/api/console/incidents/${id}/tasks`).set(bearer(tc)).send({ title: 'اطفای حریق', assigneeId: r1.id });
    expect(task.status).toBe(201);

    const a1 = (await appLogin(r1.nationalCode, r1.mobile)).verify!.body.accessToken;
    const a2 = (await appLogin(r2.nationalCode, r2.mobile, 'device-0002')).verify!.body.accessToken;
    expect((await api().get('/api/app/tasks').set(bearer(a1))).body).toHaveLength(1);
    expect((await api().get('/api/app/tasks').set(bearer(a2))).body).toHaveLength(0);
    expect((await api().get(`/api/app/incidents/${id}`).set(bearer(a2))).status).toBe(404);
    expect((await api().patch(`/api/app/tasks/${task.body.id}/status`).set(bearer(a2)).send({ status: 'accepted' })).status).toBe(404);
    expect((await api().patch(`/api/app/tasks/${task.body.id}/status`).set(bearer(a1)).send({ status: 'on_site' })).status).toBe(409);
    expect((await api().patch(`/api/app/tasks/${task.body.id}/status`).set(bearer(a1)).send({ status: 'accepted' })).status).toBe(200);
  });

  it('records citizen reports as unverified with capped severity', async () => {
    const nc = nationalCode();
    const m = mobile();
    const t = (await appLogin(nc, m, 'device-0001', { firstName: 'کاوه', lastName: 'شریفی' })).verify!.body.accessToken;
    const r = await api().post('/api/app/incidents').set(bearer(t)).send({ title: 'نشت گاز در ساختمان', type: 'gas_leak', severity: 4, districtId: 2 });
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ status: 'reported', severity: 2, source: 'citizen' });
    expect((await api().get('/api/app/tasks').set(bearer(t))).status).toBe(403);
    expect((await api().get('/api/app/incidents').set(bearer(t))).body).toHaveLength(1);
  });
});
