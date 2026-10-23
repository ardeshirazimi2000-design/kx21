import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startApp } from './helpers.js';
import { DEMO_ACCOUNTS } from '../src/seed.js';

test('admin sets the allowed visit durations; doctors can only publish those', async () => {
  const t = await startApp();
  try {
    const admin = await t.login(DEMO_ACCOUNTS.admin.phone, { role: 'doctor' });
    const doctor = await t.login(DEMO_ACCOUNTS.doctors[0].phone, { role: 'doctor' });

    const s0 = await t.call('GET', '/v1/admin/settings', { token: admin });
    assert.deepEqual(s0.body.visit, { durations: [15, 20, 30, 45, 60], default: 30, join_early_min: 10, cancel_refund_hours: 24 });

    assert.equal((await t.call('PUT', '/v1/admin/settings', { token: admin, body: { visit: { durations: [] } } })).status, 422);
    assert.equal((await t.call('PUT', '/v1/admin/settings', { token: admin, body: { visit: { durations: [15, 7] } } })).status, 422);
    assert.equal((await t.call('PUT', '/v1/admin/settings', { token: admin, body: { visit: { durations: [15, 30], default: 20 } } })).status, 422);
    const tariffsBefore = s0.body.tariffs;
    const put = await t.call('PUT', '/v1/admin/settings', { token: admin, body: { visit: { durations: [30, 15], default: 15 } } });
    assert.equal(put.status, 200);
    assert.deepEqual(put.body.visit, { durations: [15, 30], default: 15, join_early_min: 10, cancel_refund_hours: 24 });
    assert.deepEqual(put.body.tariffs, tariffsBefore); // saving the visit settings leaves the tariffs alone

    const mine = await t.call('GET', '/v1/doctors/me/slots', { token: doctor });
    assert.deepEqual(mine.body.visit, { durations: [15, 30], default: 15, join_early_min: 10, cancel_refund_hours: 24 });

    const day = new Date(Date.now() + 60 * 864e5);
    day.setUTCHours(1, 0, 0, 0);
    const iso = (h) => new Date(day.getTime() + h * 3600e3).toISOString();
    const bad = await t.call('POST', '/v1/doctors/me/slots', { token: doctor, body: { starts_at: iso(0), ends_at: iso(1), duration_min: 20 } });
    assert.equal(bad.body.code, 'duration_not_allowed');
    const ok = await t.call('POST', '/v1/doctors/me/slots', { token: doctor, body: { starts_at: iso(0), ends_at: iso(1), duration_min: 30 } });
    assert.equal(ok.status, 201);
    assert.equal(ok.body.created, 2);
    const def = await t.call('POST', '/v1/doctors/me/slots', { token: doctor, body: { starts_at: iso(2), ends_at: iso(3) } });
    assert.equal(def.body.created, 4); // default 15 minutes

    // Only staff with tariffs.manage may change it.
    assert.equal((await t.call('PUT', '/v1/admin/settings', { token: doctor, body: { visit: { durations: [60] } } })).status, 403);
  } finally {
    t.close();
  }
});
