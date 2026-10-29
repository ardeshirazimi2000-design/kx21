import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, randomNationalId } from './helpers.js';
import { DEMO_ACCOUNTS } from '../src/seed.js';

async function bookOne(t, startInMin) {
  const doctor = await t.login(DEMO_ACCOUNTS.doctors[0].phone, { role: 'doctor' });
  const { token: patient } = await t.newPatient();
  const start = new Date(Date.now() + startInMin * 60000);
  start.setUTCSeconds(0, 0);
  const end = new Date(start.getTime() + 30 * 60000);
  // Free the time: remove this doctor's unbooked demo slots.
  t.app.db.run(`DELETE FROM slots WHERE doctor_id = (SELECT d.id FROM doctors d JOIN users u ON u.id = d.user_id WHERE u.phone = ?)
    AND id NOT IN (SELECT slot_id FROM appointments)`, DEMO_ACCOUNTS.doctors[0].phone);
  const pub = await t.call('POST', '/v1/doctors/me/slots', { token: doctor, body: { starts_at: start.toISOString(), ends_at: end.toISOString(), duration_min: 30 } });
  assert.equal(pub.status, 201, pub.text);
  const slot = pub.body.items[0];
  const did = t.app.db.get('SELECT doctor_id FROM slots WHERE id = ?', slot.id).doctor_id;
  const a = await t.call('POST', '/v1/appointments', { token: patient, body: { doctor_id: did, slot_id: slot.id, channel: 'video' }, headers: { 'Idempotency-Key': t.uuid() } });
  assert.equal(a.status, 201, a.text);
  assert.equal(a.body.status, 'confirmed');
  return { doctor, patient, appt: a.body, slotId: slot.id };
}

test('visit room opens only around the appointment time', async () => {
  const t = await startApp({ enforceJoinWindow: true, disableSweeper: true });
  try {
    const { doctor, patient, appt, slotId } = await bookOne(t, 120);
    assert.equal(appt.join.enforced, true);
    assert.equal(Date.parse(appt.starts_at) - Date.parse(appt.join.opens_at), 10 * 60000); // default: 10 minutes early
    const early = await t.call('POST', `/v1/consultations/${appt.consultation.id}/join`, { token: patient, body: {} });
    assert.equal(early.body.code, 'too_early');
    // Move the visit to "starting in 5 minutes": both may enter, and the other side is told.
    const s = new Date(Date.now() + 5 * 60000);
    t.app.db.run('UPDATE slots SET starts_at = ?, ends_at = ? WHERE id = ?', s.toISOString(), new Date(s.getTime() + 30 * 60000).toISOString(), slotId);
    assert.equal((await t.call('POST', `/v1/consultations/${appt.consultation.id}/join`, { token: doctor, body: {} })).status, 200);
    const inbox = await t.call('GET', '/v1/notifications', { token: patient });
    assert.ok(inbox.body.items.some((n) => n.body.includes('پزشک وارد اتاق ویزیت شد')));
    // Long after the end, the doctor never in the room: closed. (A visit the doctor is in stays open.)
    t.app.db.run('UPDATE consultations SET doctor_joined_at = NULL WHERE id = ?', appt.consultation.id);
    const old = new Date(Date.now() - 3 * 3600e3);
    t.app.db.run('UPDATE slots SET starts_at = ?, ends_at = ? WHERE id = ?', old.toISOString(), new Date(old.getTime() + 30 * 60000).toISOString(), slotId);
    assert.equal((await t.call('POST', `/v1/consultations/${appt.consultation.id}/join`, { token: patient, body: {} })).body.code, 'too_late');
  } finally {
    t.close();
  }
});

test('reminders: one an hour before, one when the room opens', async () => {
  const t = await startApp({ disableSweeper: true });
  try {
    const { patient, doctor } = await bookOne(t, 45);
    t.app.domain.appointment.remind();
    t.app.domain.appointment.remind(); // idempotent
    const p1 = (await t.call('GET', '/v1/notifications', { token: patient })).body.items.filter((n) => n.body.startsWith('یادآوری'));
    const d1 = (await t.call('GET', '/v1/notifications', { token: doctor })).body.items.filter((n) => n.body.startsWith('یادآوری'));
    assert.equal(p1.length, 1);
    assert.equal(d1.length, 1);
    t.app.db.run(`UPDATE slots SET starts_at = ? WHERE id = (SELECT slot_id FROM appointments ORDER BY created_at DESC LIMIT 1)`, new Date(Date.now() + 5 * 60000).toISOString());
    t.app.domain.appointment.remind();
    const p2 = (await t.call('GET', '/v1/notifications', { token: patient })).body.items.filter((n) => n.body.includes('اتاق ویزیت شما'));
    assert.equal(p2.length, 1);
  } finally {
    t.close();
  }
});

test('doctor cancels a visit with a reason; the patient is told why', async () => {
  const t = await startApp({ disableSweeper: true });
  try {
    const { doctor, patient, appt } = await bookOne(t, 300);
    const no = await t.call('POST', `/v1/appointments/${appt.id}/cancel`, { token: doctor, body: {} });
    assert.equal(no.body.code, 'cancel_reason_required');
    const ok = await t.call('POST', `/v1/appointments/${appt.id}/cancel`, { token: doctor, body: { reason: 'جراحی اورژانسی دارم' } });
    assert.equal(ok.status, 200);
    assert.equal(ok.body.status, 'cancelled');
    assert.equal(ok.body.cancelled_by, 'doctor');
    const inbox = (await t.call('GET', '/v1/notifications', { token: patient })).body.items;
    assert.ok(inbox.some((n) => n.body.includes('توسط پزشک لغو شد') && n.body.includes('جراحی اورژانسی دارم')));
    // The slot is free again.
    assert.equal(t.app.db.get(`SELECT COUNT(*) AS n FROM appointments WHERE slot_id = ? AND status IN ('pending','confirmed')`, appt.slot_id).n, 0);
  } finally {
    t.close();
  }
});

test('live queue: position, people ahead, expected start, "you are next" and no-show', async () => {
  const t = await startApp({ disableSweeper: true });
  try {
    const doctor = await t.login(DEMO_ACCOUNTS.doctors[0].phone, { role: 'doctor' });
    t.app.db.run(`DELETE FROM slots WHERE doctor_id = (SELECT d.id FROM doctors d JOIN users u ON u.id = d.user_id WHERE u.phone = ?)
      AND id NOT IN (SELECT slot_id FROM appointments)`, DEMO_ACCOUNTS.doctors[0].phone);
    // Three 20-minute visits, the first starting in 2 minutes (kept inside today in Tehran).
    const start = new Date(Date.now() + 2 * 60000); start.setUTCSeconds(0, 0);
    const pub = await t.call('POST', '/v1/doctors/me/slots', { token: doctor, body: { starts_at: start.toISOString(), ends_at: new Date(start.getTime() + 60 * 60000).toISOString(), duration_min: 20 } });
    assert.equal(pub.body.created, 3);
    const did = t.app.db.get('SELECT doctor_id FROM slots WHERE id = ?', pub.body.items[0].id).doctor_id;
    const people = [];
    for (const s of pub.body.items) {
      const { token } = await t.newPatient({ nationalId: randomNationalId() });
      const a = await t.call('POST', '/v1/appointments', { token, body: { doctor_id: did, slot_id: s.id, channel: 'video' }, headers: { 'Idempotency-Key': t.uuid() } });
      people.push({ token, appt: a.body });
    }
    const { tehranDay } = t.app.domain.appointment;
    if (tehranDay(start.toISOString())[0] !== tehranDay(new Date(start.getTime() + 60 * 60000).toISOString())[0]) return; // too close to midnight to test

    const q3 = (await t.call('GET', `/v1/appointments/${people[2].appt.id}`, { token: people[2].token })).body.queue;
    assert.equal(q3.position, 3);
    assert.equal(q3.total, 3);
    assert.equal(q3.ahead_waiting, 2);
    assert.equal(q3.state, 'waiting');

    // The doctor starts the first visit 10 minutes late: the others are expected later.
    await t.call('POST', `/v1/consultations/${people[0].appt.consultation.id}/join`, { token: doctor, body: {} });
    t.app.db.run('UPDATE consultations SET doctor_joined_at = ? WHERE id = ?', new Date(start.getTime() + 10 * 60000).toISOString(), people[0].appt.consultation.id);
    const q2 = (await t.call('GET', `/v1/appointments/${people[1].appt.id}`, { token: people[1].token })).body.queue;
    assert.equal(q2.ahead_in_visit, 1);
    assert.equal(q2.ahead_waiting, 0);
    assert.equal(q2.delay_min, 10);
    assert.deepEqual(q2.states, ['in_visit', 'me', 'waiting']);

    // "You are next" goes to the second patient once (expected start within 15 minutes).
    t.app.domain.appointment.queueNotify(start.getTime() + 20 * 60000);
    t.app.domain.appointment.queueNotify(start.getTime() + 21 * 60000);
    const inbox2 = (await t.call('GET', '/v1/notifications', { token: people[1].token })).body.items.filter((n) => n.body.startsWith('نوبت شما بعدی است'));
    assert.equal(inbox2.length, 1);

    // Doctor's view of the day.
    const dq = (await t.call('GET', '/v1/doctors/me/queue', { token: doctor })).body.items;
    assert.deepEqual(dq.map((x) => x.state), ['in_visit', 'waiting', 'waiting']);
    assert.ok(dq[0].patient_name);

    // No-show only after the visit's time; the queue moves on.
    assert.equal((await t.call('POST', `/v1/appointments/${people[2].appt.id}/no-show`, { token: doctor, body: {} })).body.code, 'too_early');
    t.app.db.run('UPDATE slots SET starts_at = ? WHERE id = ?', new Date(Date.now() - 60000).toISOString(), people[1].appt.slot_id);
    const ns = await t.call('POST', `/v1/appointments/${people[1].appt.id}/no-show`, { token: doctor, body: {} });
    assert.equal(ns.body.status, 'no_show');
  } finally {
    t.close();
  }
});

test('doctor manages free slots in bulk: switch off / on and delete; booked slots are never touched', async () => {
  const t = await startApp({ disableSweeper: true });
  try {
    const doctor = await t.login(DEMO_ACCOUNTS.doctors[0].phone, { role: 'doctor' });
    t.app.db.run(`DELETE FROM slots WHERE doctor_id = (SELECT d.id FROM doctors d JOIN users u ON u.id = d.user_id WHERE u.phone = ?)
      AND id NOT IN (SELECT slot_id FROM appointments)`, DEMO_ACCOUNTS.doctors[0].phone);
    const start = new Date(Date.now() + 26 * 3600e3); start.setUTCMinutes(0, 0, 0);
    const pub = await t.call('POST', '/v1/doctors/me/slots', { token: doctor, body: { starts_at: start.toISOString(), ends_at: new Date(start.getTime() + 2 * 3600e3).toISOString(), duration_min: 30 } });
    assert.equal(pub.body.created, 4);
    const [s1, s2, s3, s4] = pub.body.items;
    const did = t.app.db.get('SELECT doctor_id FROM slots WHERE id = ?', s1.id).doctor_id;
    const { token: patient } = await t.newPatient({ nationalId: randomNationalId() });
    const booked = await t.call('POST', '/v1/appointments', { token: patient, body: { doctor_id: did, slot_id: s1.id, channel: 'video' }, headers: { 'Idempotency-Key': t.uuid() } });
    assert.equal(booked.status, 201);
    const offered = async () => (await t.call('GET', `/v1/doctors/${did}/slots`, { token: patient })).body.items.map((x) => x.id);

    // Switch off two free slots (and try the booked one): not offered, not bookable.
    const off = await t.call('POST', '/v1/doctors/me/slots/bulk', { token: doctor, body: { action: 'block', ids: [s1.id, s2.id, s3.id] } });
    assert.deepEqual(off.body, { done: 2, skipped: 1 });
    assert.deepEqual((await offered()).sort(), [s4.id].sort());
    const no = await t.call('POST', '/v1/appointments', { token: patient, body: { doctor_id: did, slot_id: s2.id, channel: 'video' }, headers: { 'Idempotency-Key': t.uuid() } });
    assert.equal(no.body.code, 'slot_blocked');
    const mine = (await t.call('GET', '/v1/doctors/me/slots', { token: doctor })).body.items;
    assert.deepEqual(mine.filter((x) => x.blocked).map((x) => x.id).sort(), [s2.id, s3.id].sort());

    // Back on.
    assert.equal((await t.call('POST', '/v1/doctors/me/slots/bulk', { token: doctor, body: { action: 'unblock', ids: [s2.id] } })).body.done, 1);
    assert.ok((await offered()).includes(s2.id));

    // Delete: the booked slot stays; a slot with only a cancelled visit is removed from the calendar but kept for history.
    const { token: p2 } = await t.newPatient({ nationalId: randomNationalId() });
    const c = await t.call('POST', '/v1/appointments', { token: p2, body: { doctor_id: did, slot_id: s4.id, channel: 'video' }, headers: { 'Idempotency-Key': t.uuid() } });
    await t.call('POST', `/v1/appointments/${c.body.id}/cancel`, { token: p2, body: {} });
    const del = await t.call('POST', '/v1/doctors/me/slots/bulk', { token: doctor, body: { action: 'delete', ids: [s1.id, s2.id, s3.id, s4.id] } });
    assert.deepEqual(del.body, { done: 3, skipped: 1 });
    const left = (await t.call('GET', '/v1/doctors/me/slots', { token: doctor })).body.items.map((x) => x.id);
    assert.deepEqual(left, [s1.id]);
    assert.ok(t.app.db.get('SELECT removed_at FROM slots WHERE id = ?', s4.id).removed_at); // history kept
    // Publishing the same times again works (the removed slot comes back).
    const again = await t.call('POST', '/v1/doctors/me/slots', { token: doctor, body: { starts_at: start.toISOString(), ends_at: new Date(start.getTime() + 2 * 3600e3).toISOString(), duration_min: 30 } });
    assert.equal(again.body.created, 3);
    assert.equal(again.body.skipped_overlapping, 1);
  } finally {
    t.close();
  }
});
