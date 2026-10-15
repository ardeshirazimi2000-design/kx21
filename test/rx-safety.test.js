// Prescribing aids (phase 1): safety checks, ICD-10 coding, personal templates.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, randomNationalId } from './helpers.js';
import { DEMO_ACCOUNTS } from '../src/seed.js';
import { checkPrescription, identifyDrug } from '../src/modules/rx/drug-kb.js';
import { searchIcd } from '../src/modules/rx/icd10.js';

const kinds = (drugs, ctx) => checkPrescription(drugs.map((name) => ({ name })), ctx).map((w) => `${w.severity}:${w.type}`);

test('drug KB: recognition, allergy (direct + cross), duplicates, key interactions', () => {
  assert.equal(identifyDrug('کوآموکسی کلاو ۶۲۵ قرص')?.generic, 'Co-amoxiclav');
  assert.equal(identifyDrug('Amoxicillin 500 mg cap')?.generic, 'Amoxicillin');
  assert.equal(identifyDrug('Vitamin C'), null);
  assert.deepEqual(kinds(['Amoxicillin 500', 'Cefixime 400'], { allergies: ['پنی‌سیلین'] }), ['high:allergy', 'moderate:allergy_cross']);
  assert.deepEqual(kinds(['Ibuprofen 400'], { allergies: ['آسپرین'] }), ['high:allergy']);
  assert.deepEqual(kinds(['Cetirizine'], { allergies: ['گرده گل', 'بادام زمینی'] }), []);
  assert.deepEqual(kinds(['Ibuprofen 400', 'Diclofenac 50']), ['moderate:duplicate_class']);
  assert.deepEqual(kinds(['Amoxicillin 500', 'آموکسی سیلین ۲۵۰']).includes('high:duplicate'), true);
  assert.deepEqual(kinds(['Warfarin 5', 'Ibuprofen 400']), ['high:interaction']);
  assert.deepEqual(kinds(['Sildenafil 50'], { activeDrugs: [{ name: 'Nitroglycerin' }] }), ['high:interaction']);
  assert.deepEqual(kinds(['Pantoprazole 40'], { activeDrugs: [{ name: 'Omeprazole 20' }] }), ['moderate:duplicate_recent']);
  assert.deepEqual(kinds(['Aspirin 80', 'Clopidogrel 75']), []); // dual antiplatelet is a normal regimen
});

test('ICD-10 search by Persian, English and code', () => {
  assert.equal(searchIcd('گلودرد')[0].code.startsWith('J0'), true);
  assert.equal(searchIcd('k21')[0].code, 'K21.9');
  assert.equal(searchIcd('migraine')[0].code, 'G43.9');
});

let t;
before(async () => { t = await startApp({ disableSweeper: true }); });
after(() => t.close());

test('prescription: coded diagnosis, safety warnings, signing needs a reason for high-severity ones', async () => {
  const p = await t.newPatient({ nationalId: randomNationalId() });
  await t.call('PUT', '/v1/patients/me', { token: p.token, body: { allergies: ['پنی سیلین'] } });
  const book = async (key) => {
    const [slot] = (await t.call('GET', '/v1/slots?specialty=ent&limit=5', { token: p.token })).body.items;
    return (await t.call('POST', '/v1/appointments', { token: p.token, headers: { 'Idempotency-Key': key }, body: { doctor_id: slot.doctor_id, slot_id: slot.id, channel: 'chat' } })).body;
  };
  const a1 = await book('rx-s1');
  const doc = await t.login(DEMO_ACCOUNTS.doctors[6].phone);
  const cid = a1.consultation.id;

  assert.equal((await t.call('POST', '/v1/prescriptions', { token: doc, headers: { 'Idempotency-Key': 'x0' }, body: { consultation_id: cid, drugs: [{ name: 'Azithromycin' }], diagnoses: ['Q99.9'] } })).body.code, 'unknown_icd_code');
  const live = await t.call('POST', '/v1/prescriptions/check', { token: doc, body: { consultation_id: cid, drugs: [{ name: 'Amoxicillin 500' }, { name: 'Gelofen' }] } });
  assert.equal(live.body.warnings[0].type, 'allergy');
  assert.deepEqual(live.body.unrecognised, ['Gelofen']);

  const draft = await t.call('POST', '/v1/prescriptions', { token: doc, headers: { 'Idempotency-Key': 'x1' }, body: {
    consultation_id: cid, diagnoses: ['J02.9'], drugs: [{ name: 'Amoxicillin 500', dose: '500mg', frequency: 'هر ۸ ساعت' }],
  } });
  assert.equal(draft.status, 201);
  assert.deepEqual(draft.body.diagnoses, [{ code: 'J02.9', label_fa: 'فارنژیت حاد، نامشخص' }]);
  assert.equal(draft.body.safety.warnings[0].severity, 'high');

  const refused = await t.call('POST', `/v1/prescriptions/${draft.body.id}/sign`, { token: doc, body: {} });
  assert.equal(refused.status, 409);
  assert.equal(refused.body.code, 'safety_override_required');
  assert.equal(refused.body.warnings[0].type, 'allergy');
  const signed = await t.call('POST', `/v1/prescriptions/${draft.body.id}/sign`, { token: doc, body: { override_reason: 'شرح حال: فقط کهیر خفیف در کودکی؛ تست پوستی منفی' } });
  assert.equal(signed.body.status, 'issued');
  assert.match(signed.body.safety.override_reason, /تست پوستی/);
  const v = await t.call('GET', `/v1/prescriptions/${draft.body.id}/verify`);
  assert.equal(v.body.valid, true);
  assert.equal(v.body.diagnoses[0].code, 'J02.9');
  // The patient sees the prescription and its diagnosis but not the prescriber's safety notes.
  const pr = (await t.call('GET', '/v1/prescriptions', { token: p.token })).body.items[0];
  assert.equal(pr.diagnoses[0].code, 'J02.9');
  assert.equal(pr.safety, undefined);

  // A later visit sees the recent prescription.
  await t.call('POST', `/v1/consultations/${cid}/end`, { token: doc, body: {} });
  const a2 = await book('rx-s2');
  const again = await t.call('POST', '/v1/prescriptions/check', { token: doc, body: { consultation_id: a2.consultation.id, drugs: [{ name: 'Co-amoxiclav 625' }] } });
  assert.deepEqual(again.body.warnings.map((w) => w.type).sort(), ['allergy', 'duplicate_recent']);
  // Moderate warnings alone do not block signing.
  const d2 = await t.call('POST', '/v1/prescriptions', { token: doc, headers: { 'Idempotency-Key': 'x2' }, body: { consultation_id: a2.consultation.id, drugs: [{ name: 'Cetirizine 10' }] } });
  assert.equal((await t.call('POST', `/v1/prescriptions/${d2.body.id}/sign`, { token: doc, body: {} })).body.status, 'issued');
});

test('personal prescription templates: own only, diagnosis-matched first, usage counted', async () => {
  const doc = await t.login(DEMO_ACCOUNTS.doctors[2].phone);
  const other = await t.login(DEMO_ACCOUNTS.doctors[4].phone);
  const mk = (body) => t.call('POST', '/v1/doctors/me/rx-templates', { token: doc, body });
  assert.equal((await mk({ name: 'x', drugs: [] })).status, 422);
  const acne = await mk({ name: 'آکنه خفیف', diagnosis_code: 'L70.0', drugs: [{ name: 'Doxycycline 100', frequency: 'روزی یک بار', duration: '۸ هفته' }] });
  const ecz = await mk({ name: 'اگزما', diagnosis_code: 'L20.9', drugs: [{ name: 'Cetirizine 10' }], notes: 'مرطوب‌کننده' });
  assert.equal(acne.status, 201);
  assert.equal(acne.body.diagnosis_label, 'آکنه ولگاریس');
  await t.call('POST', `/v1/doctors/me/rx-templates/${ecz.body.id}/use`, { token: doc, body: {} });
  let list = (await t.call('GET', '/v1/doctors/me/rx-templates', { token: doc })).body.items;
  assert.equal(list[0].name, 'اگزما'); // most used
  list = (await t.call('GET', '/v1/doctors/me/rx-templates?diagnosis_code=L70.0', { token: doc })).body.items;
  assert.equal(list[0].name, 'آکنه خفیف'); // matching diagnosis first
  assert.equal((await t.call('GET', '/v1/doctors/me/rx-templates', { token: other })).body.items.length, 0);
  assert.equal((await t.call('DELETE', `/v1/doctors/me/rx-templates/${acne.body.id}`, { token: other })).status, 404);
  assert.equal((await t.call('PUT', `/v1/doctors/me/rx-templates/${acne.body.id}`, { token: doc, body: { name: 'آکنه متوسط' } })).body.name, 'آکنه متوسط');
  assert.equal((await t.call('DELETE', `/v1/doctors/me/rx-templates/${acne.body.id}`, { token: doc })).status, 204);
  assert.equal((await t.call('GET', '/v1/icd10?q=آکنه', { token: doc })).body.items[0].code, 'L70.0');
});
