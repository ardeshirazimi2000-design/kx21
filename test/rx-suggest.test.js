// "From my formulary": suggestions only from the physician's own templates/prescriptions for the
// physician's chosen diagnosis, checked against the current patient.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, randomNationalId } from './helpers.js';
import { DEMO_ACCOUNTS } from '../src/seed.js';
import { codesFromAssessment } from '../src/modules/rx/suggest.js';

test('codes are matched in the physician\'s own assessment text (for confirmation)', () => {
  assert.deepEqual(codesFromAssessment('فارنژیت حاد، نامشخص؛ تب').map((x) => x.code), ['J02.9', 'R50.9']);
  assert.deepEqual(codesFromAssessment('فارنژیت حاد، نامشخص').map((x) => x.code), ['J02.9']); // qualifier alone is not a diagnosis
  assert.deepEqual(codesFromAssessment(''), []);
});

let t;
before(async () => { t = await startApp({ disableSweeper: true }); });
after(() => t.close());

async function visit(p, key) {
  const [slot] = (await t.call('GET', '/v1/slots?specialty=ent&limit=5', { token: p.token })).body.items;
  return (await t.call('POST', '/v1/appointments', { token: p.token, headers: { 'Idempotency-Key': key }, body: { doctor_id: slot.doctor_id, slot_id: slot.id, channel: 'chat' } })).body.consultation.id;
}

test('suggestions come from the doctor\'s own practice, ranked, safety-checked per patient; other doctors see nothing', async () => {
  const doc = await t.login(DEMO_ACCOUNTS.doctors[6].phone); // ENT
  const other = await t.login(DEMO_ACCOUNTS.doctors[0].phone);
  // Earlier practice: two issued prescriptions for J02.9 + one template.
  const p1 = await t.newPatient({ nationalId: randomNationalId() });
  for (const [i, drugs] of [[1, [{ name: 'Amoxicillin 500', frequency: 'هر ۸ ساعت', duration: '۱۰ روز' }]], [2, [{ name: 'Amoxicillin 500', frequency: 'هر ۸ ساعت', duration: '۱۰ روز' }]]]) {
    const cid = await visit(p1, `sg-${i}`);
    const rx = await t.call('POST', '/v1/prescriptions', { token: doc, headers: { 'Idempotency-Key': `sg-rx-${i}` }, body: { consultation_id: cid, diagnoses: ['J02.9'], drugs } });
    await t.call('POST', `/v1/prescriptions/${rx.body.id}/sign`, { token: doc, body: {} });
    await t.call('POST', `/v1/consultations/${cid}/end`, { token: doc, body: {} });
  }
  await t.call('POST', '/v1/doctors/me/rx-templates', { token: doc, body: { name: 'فارنژیت - حساسیت به پنی‌سیلین', diagnosis_code: 'J02.9', drugs: [{ name: 'Azithromycin 500', frequency: 'روزی یک بار', duration: '۳ روز' }] } });

  // New patient allergic to penicillin.
  const p2 = await t.newPatient({ nationalId: randomNationalId() });
  await t.call('PUT', '/v1/patients/me', { token: p2.token, body: { allergies: ['پنی‌سیلین'] } });
  const cid = await visit(p2, 'sg-now');

  // No diagnosis yet → codes from the doctor's own assessment are offered, nothing suggested.
  await t.call('PUT', `/v1/consultations/${cid}/summary`, { token: doc, body: { assessment: 'فارنژیت حاد، نامشخص' } });
  let r = (await t.call('POST', '/v1/prescriptions/suggest', { token: doc, body: { consultation_id: cid } })).body;
  assert.deepEqual(r.items, []);
  assert.equal(r.from_assessment[0].code, 'J02.9');

  r = (await t.call('POST', '/v1/prescriptions/suggest', { token: doc, body: { consultation_id: cid, diagnoses: ['J02.9'] } })).body;
  assert.equal(r.items.length, 2);
  // The amoxicillin regimen (used twice) is ranked below the safe template for this allergic patient.
  assert.equal(r.items[0].label, 'فارنژیت - حساسیت به پنی‌سیلین');
  assert.equal(r.items[0].blocked, false);
  assert.equal(r.items[1].times_used, 2);
  assert.equal(r.items[1].blocked, true);
  assert.equal(r.items[1].warnings[0].type, 'allergy');

  // Another doctor: not their visit; and their own formulary is empty.
  assert.equal((await t.call('POST', '/v1/prescriptions/suggest', { token: other, body: { consultation_id: cid, diagnoses: ['J02.9'] } })).status, 422);
  assert.equal((await t.call('POST', '/v1/prescriptions/suggest/applied', { token: doc, body: { consultation_id: cid, sources: ['template'], diagnosis_code: 'J02.9' } })).status, 204);
});
