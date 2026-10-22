// Visit summary: SOAP draft at the end of the visit → physician edits/finalizes → patient sees it.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, randomNationalId } from './helpers.js';
import { DEMO_ACCOUNTS } from '../src/seed.js';
import { buildVisitSummary, buildPatientSummary, ageFrom } from '../src/modules/ai/visit-summary.js';

let t;
before(async () => { t = await startApp({ disableSweeper: true }); });
after(() => t.close());

test('summary builder: facts only, abnormal labs called out, assessment never generated', () => {
  const s = buildVisitSummary({
    visit: { channel: 'chat', doctor_name: 'دکتر حمید نوری', date_fa: 'شنبه ۱۹ مهر' },
    patient: { age: 41, gender: 'male', allergies: ['پنی‌سیلین'], chronic_conditions: [] },
    triage: { urgency_level: 'routine', rule_version: 'r1', red_flags: [], symptoms: [{ name: 'محل: شکم\nمدت: ۴ تا ۷ روز', form: { vitals: { temp_c: 37.9, hr: 96 }, vitals_source: null } }] },
    messages: [{ sender_role: 'patient', content: 'بعد از غذا درد بیشتر می‌شود' }, { sender_role: 'doctor', content: 'غذای چرب نخورید و آزمایش H. pylori بدهید' }],
    records: [{ title: 'آزمایش خون', category_label: 'نتیجه آزمایش', lab_rows: [{ name: 'ALT', value: '88', ocr: true }, { name: 'Hb', value: '14.1' }], file_count: 1 }],
    prescriptions: [{ status: 'issued', drugs: [{ name: 'Pantoprazole', dose: '40mg', frequency: 'روزی یک بار', duration: '۴ هفته' }] }, { status: 'draft', drugs: [{ name: 'X' }] }],
  });
  assert.match(s.subjective, /بعد از غذا درد بیشتر/);
  assert.match(s.subjective, /پنی‌سیلین/);
  assert.match(s.objective, /دما 37.9/);
  assert.match(s.objective, /ALT: 88 .*بالا/);
  assert.match(s.objective, /1 مقدار دیگر در محدوده/);
  assert.match(s.objective, /از عکس برگه/);
  assert.match(s.plan, /Pantoprazole — 40mg/);
  assert.match(s.plan, /پیش‌نویس نسخه \(هنوز امضا نشده\)/);
  assert.match(s.advice, /غذای چرب نخورید/);
  assert.equal(s.assessment, undefined);
  // Patient text lists only issued drugs, the doctor's advice and the emergency safety net.
  assert.match(s.patient_summary, /Pantoprazole/);
  assert.doesNotMatch(s.patient_summary, /• X/);
  assert.match(s.patient_summary, /۱۱۵/);
  assert.match(buildPatientSummary({ assessmentForPatient: 'گاستریت خفیف' }), /توضیح پزشک:\nگاستریت خفیف/);
  assert.equal(ageFrom('1990-10-20', new Date('2026-10-19T00:00:00Z')), 35);
});

test('visit → draft on end → doctor edits (kept on regenerate) → finalize → patient reads', async () => {
  const p = await t.newPatient({ nationalId: randomNationalId() });
  assert.equal((await t.call('POST', '/v1/ai/triage', { token: p.token, body: { symptoms: [{ name: 'درد شکم و نفخ', severity: 4 }] } })).status, 200);
  const [slot] = (await t.call('GET', '/v1/slots?specialty=gastroenterology&limit=5', { token: p.token })).body.items;
  const appt = (await t.call('POST', '/v1/appointments', { token: p.token, headers: { 'Idempotency-Key': 'sum-1' }, body: { doctor_id: slot.doctor_id, slot_id: slot.id, channel: 'chat' } })).body;
  const cid = appt.consultation.id;
  await t.call('POST', '/v1/records', { token: p.token, body: { category: 'lab', title: 'آزمایش خون', appointment_id: appt.id, lab_rows: [{ name: 'ALT', value: '88' }, { name: 'Hb', value: '14' }] } });

  const doc = await t.login(DEMO_ACCOUNTS.doctors[5].phone);
  const other = await t.login(DEMO_ACCOUNTS.doctors[6].phone);
  await t.call('POST', `/v1/consultations/${cid}/messages`, { token: p.token, body: { content: 'از یک هفته پیش بعد از غذا درد دارم' } });
  await t.call('POST', `/v1/consultations/${cid}/messages`, { token: doc, body: { content: 'غذای چرب و نوشابه نخورید' } });
  // Doctor writes the assessment as notes during the visit.
  assert.equal((await t.call('GET', `/v1/consultations/${cid}/summary`, { token: doc })).body.status, 'none');
  await t.call('PUT', `/v1/consultations/${cid}/summary`, { token: doc, body: { assessment: 'سوءهاضمه؛ افزایش خفیف ALT' } });
  const rx = await t.call('POST', '/v1/prescriptions', { token: doc, headers: { 'Idempotency-Key': 'sum-rx' }, body: { consultation_id: cid, drugs: [{ name: 'Pantoprazole', dose: '40mg', frequency: 'روزی یک بار' }] } });

  // Finalizing before the visit ends is refused.
  assert.equal((await t.call('POST', `/v1/consultations/${cid}/summary/finalize`, { token: doc, body: {} })).body.code, 'consultation_active');
  await t.call('POST', `/v1/consultations/${cid}/end`, { token: doc, body: {} });

  let s = (await t.call('GET', `/v1/consultations/${cid}/summary`, { token: doc })).body;
  assert.equal(s.status, 'draft');
  assert.match(s.subjective, /درد شکم و نفخ/);
  assert.match(s.subjective, /بعد از غذا درد دارم/);
  assert.match(s.objective, /ALT: 88/);
  assert.match(s.plan, /پیش‌نویس نسخه/);
  assert.match(s.advice, /غذای چرب/);
  assert.equal(s.assessment, 'سوءهاضمه؛ افزایش خفیف ALT'); // the doctor's notes survived generation

  // Only the treating doctor; patient cannot see the draft.
  assert.equal((await t.call('GET', `/v1/consultations/${cid}/summary`, { token: other })).status, 404);
  assert.equal((await t.call('GET', `/v1/consultations/${cid}/summary`, { token: p.token })).status, 404);

  // Edited fields are kept on regenerate.
  await t.call('PUT', `/v1/consultations/${cid}/summary`, { token: doc, body: { advice: 'رژیم کم‌چرب؛ آزمایش H. pylori', follow_up: 'دو هفته بعد' } });
  s = (await t.call('POST', `/v1/consultations/${cid}/summary/regenerate`, { token: doc, body: {} })).body;
  assert.equal(s.advice, 'رژیم کم‌چرب؛ آزمایش H. pylori');
  assert.match(s.patient_summary, /پیگیری: دو هفته بعد/);
  assert.doesNotMatch(s.patient_summary, /سوءهاضمه/); // assessment is shared only on request

  // Unsigned prescription blocks finalizing until signed (or explicitly allowed).
  assert.equal((await t.call('POST', `/v1/consultations/${cid}/summary/finalize`, { token: doc, body: {} })).body.code, 'unsigned_prescription');
  await t.call('POST', `/v1/prescriptions/${rx.body.id}/sign`, { token: doc, body: {} });
  await t.call('PUT', `/v1/consultations/${cid}/summary`, { token: doc, body: { share_assessment: true } });
  s = (await t.call('POST', `/v1/consultations/${cid}/summary/finalize`, { token: doc, body: {} })).body;
  assert.equal(s.status, 'final');
  assert.match(s.patient_summary, /Pantoprazole — 40mg/); // signed after the draft → included
  assert.match(s.patient_summary, /توضیح پزشک:\nسوءهاضمه/);
  assert.equal((await t.call('PUT', `/v1/consultations/${cid}/summary`, { token: doc, body: { advice: 'x' } })).body.code, 'summary_final');

  const mine = await t.call('GET', `/v1/consultations/${cid}/summary`, { token: p.token });
  assert.equal(mine.status, 200);
  assert.equal(mine.body.subjective, undefined); // the clinical note stays with the doctor
  assert.match(mine.body.patient_summary, /رژیم کم‌چرب/);
  assert.equal((await t.call('GET', '/v1/summaries', { token: p.token })).body.items.length, 1);
  // History for a treating doctor; refused for a doctor without a care relationship.
  const pid = t.app.db.get('SELECT patient_id FROM appointments WHERE id = ?', appt.id).patient_id;
  assert.equal((await t.call('GET', `/v1/summaries?patient_id=${pid}`, { token: doc })).body.items[0].own, true);
  assert.equal((await t.call('GET', `/v1/summaries?patient_id=${pid}`, { token: other })).body.code, 'no_care_relationship');
});

test('finalize requires the physician assessment', async () => {
  const p = await t.newPatient({ nationalId: randomNationalId() });
  const [slot] = (await t.call('GET', '/v1/slots?specialty=gastroenterology&limit=5', { token: p.token })).body.items;
  const appt = (await t.call('POST', '/v1/appointments', { token: p.token, headers: { 'Idempotency-Key': 'sum-2' }, body: { doctor_id: slot.doctor_id, slot_id: slot.id, channel: 'chat' } })).body;
  const doc = await t.login(DEMO_ACCOUNTS.doctors[5].phone);
  await t.call('POST', `/v1/consultations/${appt.consultation.id}/end`, { token: doc, body: {} });
  const r = await t.call('POST', `/v1/consultations/${appt.consultation.id}/summary/finalize`, { token: doc, body: {} });
  assert.equal(r.body.code, 'assessment_required');
});

test('assessment draft: rules from recorded data, inserted by the physician, must be completed before final', async () => {
  const { buildAssessmentDraft, icdForComplaints, DRAFT_HEADER } = await import('../src/modules/ai/assessment-draft.js');
  // Pure builder: findings, strict ICD matching (no «تبخال» for «تب»), never a diagnosis.
  assert.deepEqual(icdForComplaints(['برای: خودم | محل: قفسه سینه | علائم: تب، سرفه | مدت: ۱ تا ۳ روز']).map((x) => x.code), ['R07.4', 'R50.9', 'R05']);
  const d = buildAssessmentDraft({
    patient: { age: 70, gender: 'female', allergies: ['پنی‌سیلین'] },
    triage: { urgency_level: 'urgent', red_flags: [], symptoms: [{ name: 'علائم: تب، سرفه', form: { vitals: { temp_c: 38.6, spo2: 92 } } }] },
    records: [{ lab_rows: [{ name: 'Hb', value: '9.1' }] }],
    cxr: [{ key: 'Pneumonia', tier: 'moderate' }, { key: 'Mass', tier: 'none' }],
  });
  assert.ok(d.text.startsWith(`[${DRAFT_HEADER}]`));
  assert.match(d.text, /SpO₂ 92٪ \(پایین\)/);
  assert.match(d.text, /الگوی پنومونی/);
  assert.doesNotMatch(d.text, /توده/); // not flagged
  assert.deepEqual(d.icd.map((x) => x.code).sort(), ['D64.9', 'J18.9', 'R05', 'R06.0', 'R50.9'].sort());
  assert.match(d.text, /ارزیابی و تشخیص نهایی پزشک: …/);

  // Through the API.
  const p = await t.newPatient({ nationalId: randomNationalId() });
  const [slot] = (await t.call('GET', '/v1/slots?specialty=gastroenterology&limit=5', { token: p.token })).body.items;
  const appt = (await t.call('POST', '/v1/appointments', { token: p.token, headers: { 'Idempotency-Key': 'sum-draft' }, body: { doctor_id: slot.doctor_id, slot_id: slot.id, channel: 'chat' } })).body;
  const doc = await t.login(DEMO_ACCOUNTS.doctors[5].phone);
  const cid = appt.consultation.id;
  const draft = (await t.call('GET', `/v1/consultations/${cid}/summary/assessment-draft`, { token: doc })).body;
  assert.ok(draft.text.includes(DRAFT_HEADER));
  assert.equal((await t.call('GET', `/v1/consultations/${cid}/summary/assessment-draft`, { token: p.token })).status, 403); // patients never see it
  await t.call('POST', `/v1/consultations/${cid}/end`, { token: doc, body: {} });
  await t.call('PUT', `/v1/consultations/${cid}/summary`, { token: doc, body: { assessment: draft.text, share_assessment: true } });
  const unreviewed = await t.call('POST', `/v1/consultations/${cid}/summary/finalize`, { token: doc, body: { allow_unsigned: true } });
  assert.equal(unreviewed.body.code, 'assessment_incomplete');
  const done = draft.text.replace('ارزیابی و تشخیص نهایی پزشک: …', 'ارزیابی و تشخیص نهایی پزشک: سوءهاضمه عملکردی؛ پیگیری دو هفته بعد.');
  await t.call('PUT', `/v1/consultations/${cid}/summary`, { token: doc, body: { assessment: done } });
  const fin = (await t.call('POST', `/v1/consultations/${cid}/summary/finalize`, { token: doc, body: { allow_unsigned: true } })).body;
  assert.equal(fin.status, 'final');
  assert.ok(!fin.assessment.includes(DRAFT_HEADER)); // the label goes once the physician approved it
  assert.match(fin.assessment, /سوءهاضمه عملکردی/);
  assert.ok(!fin.patient_summary.includes(DRAFT_HEADER));
});
