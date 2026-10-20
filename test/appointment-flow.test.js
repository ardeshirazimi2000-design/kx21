import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startApp } from './helpers.js';
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
    // Long after the end: closed.
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
