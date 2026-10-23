// Cancellation rules for paid visits: refund when the patient cancels in time, no refund when late
// (the fee counts as earned), and a credit when the doctor cancels (new time without paying again,
// or a full refund). A paid visit moves with its fee when rescheduled in time.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, randomNationalId } from './helpers.js';
import { DEMO_ACCOUNTS } from '../src/seed.js';

let t;
let admin;
before(async () => { t = await startApp({ disableSweeper: true }); admin = await t.login(DEMO_ACCOUNTS.admin.phone); });
after(() => t.close());

const setHours = (h) => t.call('PUT', '/v1/admin/settings', { token: admin, body: { visit: { durations: [15, 20, 30, 45, 60], default: 30, cancel_refund_hours: h } } });
const slotsOf = async (p, spec) => (await t.call('GET', `/v1/slots?specialty=${spec}&limit=20`, { token: p.token })).body.items;
async function paidVisit(p, slot, key) {
  const a = (await t.call('POST', '/v1/appointments', { token: p.token, headers: { 'Idempotency-Key': key }, body: { doctor_id: slot.doctor_id, slot_id: slot.id, channel: 'video' } })).body;
  const st = await t.call('POST', `/v1/payments/${a.payment.id}/start`, { token: p.token, body: {} });
  await fetch(`${t.base}/v1/payments/callback?Authority=${st.body.authority}&Status=OK`);
  return a;
}
const payStatus = async (p, id) => (await t.call('GET', `/v1/payments/${id}`, { token: p.token })).body.status;

test('patient cancels in time → refund; late → no refund (earned); doctor cancels → credit: rebook or refund', async () => {
  await t.call('PUT', '/v1/admin/settings', { token: admin, body: { tariffs: { visit_video: 1_000_000, triage: 0 }, payments_enabled: true } });
  assert.equal((await setHours(200)).status, 422);
  const p = await t.newPatient({ nationalId: randomNationalId() });
  const slots = await slotsOf(p, 'dermatology');
  assert.ok(slots.length >= 5);

  // In time (rule: until the visit starts).
  assert.equal((await setHours(0)).body.visit.cancel_refund_hours, 0);
  const a1 = await paidVisit(p, slots[0], 'cr-1');
  const c1 = await t.call('POST', `/v1/appointments/${a1.id}/cancel`, { token: p.token, body: {} });
  assert.equal(c1.status, 200);
  assert.equal(await payStatus(p, a1.payment.id), 'refund_required');

  // Too late (rule: a week before) → the fee is kept and counts as earned.
  await setHours(168);
  const a2 = await paidVisit(p, slots[1], 'cr-2');
  const list0 = (await t.call('GET', '/v1/appointments?limit=50', { token: p.token })).body.items;
  assert.ok(Date.parse(list0.find((x) => x.id === a2.id).refund_until) < Date.now());
  // …and a late paid visit cannot be moved either.
  const late = await t.call('POST', `/v1/appointments/${a2.id}/reschedule`, { token: p.token, headers: { 'Idempotency-Key': 'cr-r0' }, body: { slot_id: slots[4].id } });
  assert.equal(late.body.code, 'reschedule_window_passed');
  await t.call('POST', `/v1/appointments/${a2.id}/cancel`, { token: p.token, body: {} });
  assert.equal(await payStatus(p, a2.payment.id), 'paid');
  const doctor = await t.login(DEMO_ACCOUNTS.doctors.find((d) => d.specialty === 'dermatology').phone);
  const acc = (await t.call('GET', '/v1/doctors/me/accounting', { token: doctor })).body;
  assert.equal(acc.items.find((r) => r.payment_id === a2.payment.id).state, 'earned');

  // Doctor cancels → credit; the patient takes another time with the same payment.
  await setHours(24);
  const a3 = await paidVisit(p, slots[2], 'cr-3');
  await t.call('POST', `/v1/appointments/${a3.id}/cancel`, { token: doctor, body: { reason: 'مرخصی اضطراری' } });
  const notes = (await t.call('GET', '/v1/notifications', { token: p.token })).body.items;
  assert.match(notes[0].body, /بدون پرداخت مجدد/);
  const rebook = await t.call('POST', `/v1/appointments/${a3.id}/credit`, { token: p.token, headers: { 'Idempotency-Key': 'cr-rb' }, body: { choice: 'rebook', slot_id: slots[3].id } });
  assert.equal(rebook.status, 201, JSON.stringify(rebook.body));
  assert.equal(rebook.body.status, 'confirmed');
  assert.equal(rebook.body.payment.id, a3.payment.id);
  assert.equal(await payStatus(p, a3.payment.id), 'paid');
  const again = await t.call('POST', `/v1/appointments/${a3.id}/credit`, { token: p.token, body: { choice: 'refund' } });
  assert.equal(again.body.code, 'no_credit');

  // Reschedule in time: the fee moves to the new time, nothing to pay or refund.
  await setHours(0);
  const moved = await t.call('POST', `/v1/appointments/${rebook.body.id}/reschedule`, { token: p.token, headers: { 'Idempotency-Key': 'cr-r1' }, body: { slot_id: slots[4].id } });
  assert.equal(moved.status, 201, JSON.stringify(moved.body));
  assert.equal(moved.body.status, 'confirmed');
  assert.equal(moved.body.payment.id, a3.payment.id);

  // Doctor cancels again → this time the patient asks for the money back.
  await t.call('POST', `/v1/appointments/${moved.body.id}/cancel`, { token: doctor, body: { reason: 'مرخصی اضطراری' } });
  const refund = await t.call('POST', `/v1/appointments/${moved.body.id}/credit`, { token: p.token, body: { choice: 'refund' } });
  assert.equal(refund.body.refund_policy, 'credit_refund');
  assert.equal(await payStatus(p, a3.payment.id), 'refund_required');
});

test('«add to calendar»: signed link to a calendar file with reminders; tampered link refused', async () => {
  const p = await t.newPatient({ nationalId: randomNationalId() });
  const [slot] = await slotsOf(p, 'cardiology');
  const a = (await t.call('POST', '/v1/appointments', { token: p.token, headers: { 'Idempotency-Key': 'cal-1' }, body: { doctor_id: slot.doctor_id, slot_id: slot.id, channel: 'video' } })).body;
  const link = await t.call('POST', `/v1/appointments/${a.id}/calendar-link`, { token: p.token, body: {} });
  assert.match(link.body.url, /calendar\.ics\?for=p&exp=\d+&sig=/);
  const res = await fetch(t.base + link.body.url);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /text\/calendar/);
  const ics = await res.text();
  assert.match(ics, /^BEGIN:VCALENDAR\r\n/);
  assert.match(ics, /TRIGGER:-PT60M/);
  assert.match(ics, /TRIGGER:-PT10M/);
  assert.ok(ics.split('\r\n').every((l) => Buffer.byteLength(l) <= 75));
  const start = new Date(slot.starts_at).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  assert.ok(ics.includes(`DTSTART:${start}`));
  assert.equal((await fetch(t.base + link.body.url.replace('for=p', 'for=d'))).status, 403);
  // Not someone else's visit.
  const other = await t.newPatient({ nationalId: randomNationalId() });
  assert.equal((await t.call('POST', `/v1/appointments/${a.id}/calendar-link`, { token: other.token, body: {} })).status, 404);
});
