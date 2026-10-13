// Requirements from app.docx: Shahkar registration, doctor onboarding + admin review, doctor
// directory, patient documents to doctor with AI pre-read, paid services via ZarinPal.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, randomNationalId } from './helpers.js';
import { DEMO_ACCOUNTS } from '../src/seed.js';
import { readVerdict, readPerson, createIdentityService } from '../src/modules/identity.js';
import { reviewLabRows } from '../src/modules/ai/lab-review.js';

let t;
before(async () => { t = await startApp({ disableSweeper: true }); });
after(() => t.close());
// One admin session per file: the OTP rate limit is per phone number.
let adminToken;
const adminLogin = async () => (adminToken ??= await t.login(DEMO_ACCOUNTS.admin.phone));

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 1)]);
const upload = async (token, purpose, body = PNG, type = 'image/png') => {
  const r = await fetch(`${t.base}/v1/files?purpose=${purpose}`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': type }, body });
  return { status: r.status, body: await r.json() };
};

test('Shahkar verdict parsing never treats API success as a match', () => {
  assert.equal(readVerdict({ isSuccess: true, data: { isMatched: false } }), false);
  assert.equal(readVerdict({ data: { result: true } }), true);
  assert.equal(readVerdict({ status: true, message: 'ok' }), undefined);
  // Real s.api.ir sw1/Shahkar reply.
  assert.equal(readVerdict({ data: true, success: true, code: 0, message: 'استعلام انجام شد' }), true);
  assert.equal(readVerdict({ data: false, success: true, code: 0, message: 'استعلام انجام شد' }), false);
  assert.equal(readVerdict({ data: true, success: false, code: 5 }), undefined);
});

test('Shahkar adapter: mismatch is refused; production without token fails closed', async () => {
  let auth;
  const fake = async (url, init) => { auth = init.headers.Authorization; return { ok: true, status: 200, text: async () => JSON.stringify({ isSuccess: true, data: { isMatched: false } }) }; };
  const svc = createIdentityService({ sapiToken: ' "Bearer x"\n', sapiBase: 'https://s.api.ir/api/sw1', devMode: false }, fake);
  assert.equal((await svc.verifyMobileOwnership({ nationalId: '0499370899', mobile: '09121234567' })).matched, false);
  assert.equal(auth, 'Bearer x'); // pasted quotes / "Bearer " prefix are cleaned
  const denied = createIdentityService({ sapiToken: 'x', sapiBase: 'https://s.api.ir/api/sw1', devMode: false },
    async () => ({ ok: false, status: 401, text: async () => '{"message":"Unauthorized"}' }));
  await assert.rejects(denied.verifyMobileOwnership({ nationalId: '0499370899', mobile: '09121234567' }), /توکن/);
  const prod = createIdentityService({ sapiToken: '', devMode: false });
  await assert.rejects(prod.verifyMobileOwnership({ nationalId: '0499370899', mobile: '09121234567' }), /پیکربندی نشده/);
});

test('PersonInfo (civil registry): reply parsing and Jalali birth date sent to s.api.ir', async () => {
  assert.deepEqual(readPerson({ data: { firstName: 'علی', lastName: 'رضایی' }, success: true, code: 0 }).full_name, 'علی رضایی');
  assert.equal(readPerson({ data: null, success: false, code: 3, message: 'یافت نشد' }).found, false);
  assert.equal(readPerson({ data: { isDead: true, firstName: 'ا', lastName: 'ب' }, success: true, code: 0 }).deceased, true);
  assert.equal(readPerson({ data: { foo: 1 }, success: true, code: 0 }), undefined);
  let sent;
  const fake = async (url, init) => { sent = { url, body: JSON.parse(init.body) }; return { ok: true, status: 200, text: async () => '{"data":{"firstName":"علی","lastName":"رضایی"},"success":true,"code":0}' }; };
  const svc = createIdentityService({ sapiToken: 'x', sapiBase: 'https://s.api.ir/api/sw1', devMode: false }, fake);
  assert.equal((await svc.inquirePerson({ nationalId: '0499370899', dobIso: '1992-03-21' })).full_name, 'علی رضایی');
  assert.deepEqual(sent, { url: 'https://s.api.ir/api/sw1/PersonInfo', body: { nationalCode: '0499370899', birthDate: '1371/1/1' } });
});

test('patient onboarding takes the official name from the registry and locks it', async () => {
  const idsvc = t.app.domain.identity;
  const saved = { enabled: idsvc.personInfoEnabled, inquire: idsvc.inquirePerson };
  idsvc.personInfoEnabled = true;
  idsvc.inquirePerson = async ({ dobIso }) => (dobIso === '1992-03-21' ? { found: true, full_name: 'علی رضایی' } : { found: false, message: 'عدم تطابق' });
  try {
    const phone = `0935${String(Math.floor(1e6 + Math.random() * 8e6)).padStart(7, '0')}`;
    const token = await t.login(phone, { nationalId: randomNationalId() });
    assert.equal((await t.call('GET', '/v1/auth/me', { token })).body.person_info_enabled, true);
    const bad = await t.call('PUT', '/v1/patients/me', { token, body: { dob: '1990-01-01' } });
    assert.equal(bad.status, 422);
    assert.equal(bad.body.code, 'identity_mismatch');
    const ok = await t.call('PUT', '/v1/patients/me', { token, body: { full_name: 'نام دلخواه', dob: '1992-03-21' } });
    assert.equal(ok.status, 201);
    const me = (await t.call('GET', '/v1/auth/me', { token })).body;
    assert.equal(me.full_name, 'علی رضایی');
    assert.ok(me.registry_verified_at);
    assert.equal((await t.call('PUT', '/v1/patients/me', { token, body: { full_name: 'دیگری' } })).body.code, 'name_locked');
  } finally {
    Object.assign(idsvc, { personInfoEnabled: saved.enabled, inquirePerson: saved.inquire });
  }
});

test('doctor self-registration → documents → admin reject with reason → resubmit → approve → listed', async () => {
  const phone = '09351239999';
  const r1 = await t.call('POST', '/v1/auth/otp/request', { body: { phone, role: 'doctor', national_id: randomNationalId() } });
  const v = await t.call('POST', '/v1/auth/otp/verify', { body: { phone, code: r1.body.dev_code } });
  const doc = v.body.access_token;
  assert.ok(doc, 'first login right after Shahkar+OTP registration');
  assert.equal((await t.call('GET', '/v1/auth/me', { token: doc })).body.doctor_status, 'draft');

  // Not bookable / cannot publish yet.
  const start = new Date(Date.now() + 5 * 864e5).toISOString();
  const pub = await t.call('POST', '/v1/doctors/me/slots', { token: doc, body: { starts_at: start, ends_at: new Date(Date.parse(start) + 3600e3).toISOString() } });
  assert.equal(pub.body.code, 'doctor_not_approved');
  const early = await t.call('POST', '/v1/doctors/me/submit', { token: doc, body: {} });
  assert.equal(early.body.code, 'profile_incomplete');

  const photo = await upload(doc, 'doctor_photo');
  assert.equal(photo.status, 201);
  const card = await upload(doc, 'license_card', Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.alloc(40)]), 'application/pdf');
  assert.equal(card.body.mime, 'application/pdf');
  assert.equal((await upload(doc, 'doctor_photo', Buffer.from('<script>alert(1)</script>xxxxxxxx'), 'image/png')).body.code, 'unsupported_file_type');

  await t.call('PUT', '/v1/doctors/me/profile', { token: doc, body: {
    full_name: 'دکتر نسرین تهرانی', specialty: 'dermatology', license_no: 'N-778899', education: 'دکترای عمومی، تخصص پوست',
    experience_years: 9, bio: 'متخصص پوست و مو با تمرکز بر درمان آکنه، اگزما و بیماری‌های التهابی پوست.',
    photo_file_id: photo.body.id, license_card_file_id: card.body.id,
  } });
  assert.equal((await t.call('POST', '/v1/doctors/me/submit', { token: doc, body: {} })).body.status, 'pending_review');
  assert.equal((await t.call('PUT', '/v1/doctors/me/profile', { token: doc, body: { bio: 'x'.repeat(40) } })).body.code, 'under_review');

  const admin = await adminLogin();
  const apps = await t.call('GET', '/v1/admin/doctor-applications', { token: admin });
  const app = apps.body.items.find((d) => d.license_no === 'N-778899');
  assert.ok(app.license_card_url && app.photo_url);
  // The signed URL serves the decrypted file; tampering with it is refused.
  const f = await fetch(t.base + app.license_card_url);
  assert.equal(f.headers.get('content-type'), 'application/pdf');
  assert.equal((await fetch(t.base + app.license_card_url.replace(/sig=./, 'sig=A'))).status, 403);

  assert.equal((await t.call('POST', `/v1/admin/doctors/${app.id}/reject`, { token: admin, body: { reason: '' } })).body.code, 'reason_required');
  await t.call('POST', `/v1/admin/doctors/${app.id}/reject`, { token: admin, body: { reason: 'تصویر کارت نظام پزشکی خوانا نیست' } });
  const me = await t.call('GET', '/v1/doctors/me/profile', { token: doc });
  assert.equal(me.body.status, 'rejected');
  assert.match(me.body.review_reason, /خوانا/);
  const card2 = await upload(doc, 'license_card');
  await t.call('PUT', '/v1/doctors/me/profile', { token: doc, body: { license_card_file_id: card2.body.id } });
  await t.call('POST', '/v1/doctors/me/submit', { token: doc, body: {} });
  assert.equal((await t.call('POST', `/v1/admin/doctors/${app.id}/approve`, { token: admin, body: {} })).body.status, 'approved');

  const p = await t.newPatient({ nationalId: randomNationalId() });
  const list = await t.call('GET', '/v1/doctors?specialty=dermatology', { token: p.token });
  const card3 = list.body.items.find((d) => d.id === app.id);
  assert.equal(card3.experience_years, 9);
  assert.match(card3.bio, /آکنه/);
  assert.ok(card3.photo_url);
  // After approval only soft fields are editable.
  assert.equal((await t.call('PUT', '/v1/doctors/me/profile', { token: doc, body: { license_no: 'N-1' } })).body.code, 'locked_fields');
});

test('tariffs: visit is held pending until ZarinPal (mock) payment is verified; unpaid holds are released', async () => {
  const admin = await adminLogin();
  assert.equal((await t.call('PUT', '/v1/admin/settings', { token: admin, body: { tariffs: { visit_video: 5000 } } })).status, 422);
  await t.call('PUT', '/v1/admin/settings', { token: admin, body: { tariffs: { visit_video: 1_500_000, visit_chat: 0 } } });
  const p = await t.newPatient({ nationalId: randomNationalId() });
  const [s1, s2] = (await t.call('GET', '/v1/slots?specialty=general&limit=10', { token: p.token })).body.items;

  const a = await t.call('POST', '/v1/appointments', { token: p.token, headers: { 'Idempotency-Key': 'pay-1' }, body: { doctor_id: s1.doctor_id, slot_id: s1.id, channel: 'video' } });
  assert.equal(a.body.status, 'pending');
  assert.equal(a.body.payment.amount, 1_500_000);
  assert.equal(a.body.payment.amount_toman, 150_000);
  // The held slot is not offered to others and the room is closed until payment.
  assert.ok(!(await t.call('GET', '/v1/slots?specialty=general&limit=50', { token: p.token })).body.items.some((x) => x.id === s1.id));
  assert.equal((await t.call('POST', `/v1/consultations/${a.body.consultation.id}/join`, { token: p.token, body: {} })).body.code, 'appointment_not_active');

  const st = await t.call('POST', `/v1/payments/${a.body.payment.id}/start`, { token: p.token, body: {} });
  assert.match(st.body.pay_url, /\/v1\/payments\/mock\/MOCK/);
  const cancelled = await fetch(`${t.base}/v1/payments/callback?Authority=${st.body.authority}&Status=NOK`);
  assert.match(await cancelled.text(), /انجام نشد/);
  assert.equal((await t.call('GET', `/v1/payments/${a.body.payment.id}`, { token: p.token })).body.status, 'failed');

  // New attempt: chat visit is free → confirmed immediately; video visit paid → confirmed after verify.
  const b = await t.call('POST', '/v1/appointments', { token: p.token, headers: { 'Idempotency-Key': 'pay-2' }, body: { doctor_id: s2.doctor_id, slot_id: s2.id, channel: 'video' } });
  const st2 = await t.call('POST', `/v1/payments/${b.body.payment.id}/start`, { token: p.token, body: {} });
  const okPage = await (await fetch(`${t.base}/v1/payments/callback?Authority=${st2.body.authority}&Status=OK`)).text();
  assert.match(okPage, /پرداخت موفق/);
  assert.equal((await t.call('GET', `/v1/appointments/${b.body.id}`, { token: p.token })).body.status, 'confirmed');
  // Replayed callback is idempotent.
  await fetch(`${t.base}/v1/payments/callback?Authority=${st2.body.authority}&Status=OK`);
  assert.equal((await t.call('GET', `/v1/payments/${b.body.payment.id}`, { token: p.token })).body.status, 'paid');

  // Hold expiry releases the first (failed) appointment.
  t.app.db.run(`UPDATE appointments SET payment_due_at = ? WHERE id = ?`, new Date(Date.now() - 1000).toISOString(), a.body.id);
  t.app.domain.payments.sweep();
  assert.equal((await t.call('GET', `/v1/appointments/${a.body.id}`, { token: p.token })).body.status, 'cancelled');
  await t.call('PUT', '/v1/admin/settings', { token: admin, body: { tariffs: { visit_video: 0 } } });
});

test('triage is paid when a tariff is set, but emergencies are never behind the paywall', async () => {
  const admin = await adminLogin();
  await t.call('PUT', '/v1/admin/settings', { token: admin, body: { tariffs: { triage: 200_000 } } });
  const p = await t.newPatient({ nationalId: randomNationalId() });

  const blocked = await t.chat(p.token, t.uuid(), 'سه روزه سرفه و گلودرد دارم');
  assert.ok(blocked.events.some((e) => e.event === 'payment' && e.data.purpose === 'triage'));
  assert.equal(blocked.mode, 'INFO_MODE');
  const emergency = await t.chat(p.token, t.uuid(), 'درد قفسه سینه دارم و نفسم بالا نمیاد');
  assert.equal(emergency.mode, 'EMERGENCY_MODE');
  assert.equal((await t.call('POST', '/v1/ai/triage', { token: p.token, body: { symptoms: [{ name: 'سرفه' }] } })).status, 402);

  const pay = await t.call('POST', '/v1/payments/triage', { token: p.token, body: {} });
  await fetch(`${t.base}/v1/payments/callback?Authority=${pay.body.authority}&Status=OK`);
  assert.equal((await t.call('GET', '/v1/payments/entitlements', { token: p.token })).body.triage.available, true);
  const ok = await t.call('POST', '/v1/ai/triage', { token: p.token, body: { symptoms: [{ name: 'سرفه', severity: 3 }] } });
  assert.equal(ok.status, 200);
  // One payment = one assessment.
  assert.equal((await t.call('GET', '/v1/payments/entitlements', { token: p.token })).body.triage.available, false);
  await t.call('PUT', '/v1/admin/settings', { token: admin, body: { tariffs: { triage: 0 } } });
});

test('admin can switch patient payments off (testing): visits confirm at once, triage is free', async () => {
  const admin = await adminLogin();
  await t.call('PUT', '/v1/admin/settings', { token: admin, body: { tariffs: { visit_video: 1_500_000, triage: 200_000 }, payments_enabled: false } });
  const s = (await t.call('GET', '/v1/admin/settings', { token: admin })).body;
  assert.equal(s.payments_enabled, false);
  assert.equal(s.tariffs.visit_video, 1_500_000); // stored tariffs are kept
  assert.equal((await t.call('PUT', '/v1/admin/settings', { token: admin, body: { payments_enabled: 'no' } })).status, 422);

  const p = await t.newPatient({ nationalId: randomNationalId() });
  assert.ok((await t.call('GET', '/v1/tariffs', { token: p.token })).body.items.every((i) => i.amount === 0));
  const [slot] = (await t.call('GET', '/v1/slots?specialty=general&limit=10', { token: p.token })).body.items;
  const a = await t.call('POST', '/v1/appointments', { token: p.token, headers: { 'Idempotency-Key': 'free-1' }, body: { doctor_id: slot.doctor_id, slot_id: slot.id, channel: 'video' } });
  assert.equal(a.body.status, 'confirmed');
  assert.equal(a.body.payment, null);
  assert.equal((await t.call('POST', '/v1/ai/triage', { token: p.token, body: { symptoms: [{ name: 'سرفه', severity: 3 }] } })).status, 200);

  await t.call('PUT', '/v1/admin/settings', { token: admin, body: { payments_enabled: true } });
  assert.equal((await t.call('POST', '/v1/ai/triage', { token: p.token, body: { symptoms: [{ name: 'سرفه' }] } })).status, 402);
  await t.call('PUT', '/v1/admin/settings', { token: admin, body: { tariffs: { visit_video: 0, triage: 0 } } });
});

test('patient documents by category reach only the appointment doctor; AI pre-read is doctor-only; opinion goes back', async () => {
  const p = await t.newPatient({ nationalId: randomNationalId() });
  t.app.db.run(`UPDATE patients SET gender = 'female' WHERE user_id = (SELECT id FROM users WHERE phone = ?)`, p.phone);
  const [slot] = (await t.call('GET', '/v1/slots?specialty=cardiology&limit=5', { token: p.token })).body.items;
  const appt = await t.call('POST', '/v1/appointments', { token: p.token, headers: { 'Idempotency-Key': 'rec-1' }, body: { doctor_id: slot.doctor_id, slot_id: slot.id, channel: 'chat' } });
  const img = await upload(p.token, 'medical_record');
  const rec = await t.call('POST', '/v1/records', { token: p.token, body: {
    category: 'lab', title: 'آزمایش خون مهر', note: 'ناشتا بودم', appointment_id: appt.body.id, file_ids: [img.body.id],
    lab_rows: [{ name: 'FBS', value: '132', unit: 'mg/dL' }, { name: 'Hb', value: '11.2' }, { name: 'LDL', value: '90', ref: '0-129' }, { name: 'K', value: '6.8' }],
  } });
  assert.equal(rec.status, 201);
  assert.equal(rec.body.ai_review, undefined);

  const doc = await t.login(DEMO_ACCOUNTS.doctors[1].phone); // cardiology
  const other = await t.login(DEMO_ACCOUNTS.doctors[0].phone);
  assert.equal((await t.call('GET', `/v1/records?appointment_id=${appt.body.id}`, { token: other })).status, 404);
  const list = await t.call('GET', `/v1/records?appointment_id=${appt.body.id}`, { token: doc });
  assert.equal(list.body.items[0].category_label, 'نتیجه آزمایش');
  assert.ok(list.body.items[0].files[0].url);

  const ai = await t.call('POST', `/v1/records/${rec.body.id}/ai-review`, { token: doc, body: {} });
  const byName = Object.fromEntries(ai.body.ai_review.findings.map((f) => [f.name, f]));
  assert.equal(byName.FBS.status, 'high');
  assert.equal(byName.Hb.status, 'low'); // female range
  assert.equal(byName.LDL.range_source, 'lab');
  assert.equal(byName.K.status, 'critical');
  assert.match(ai.body.ai_review.text, /تصویر/);

  await t.call('POST', `/v1/records/${rec.body.id}/opinion`, { token: doc, body: { opinion: 'قند ناشتا بالاست؛ آزمایش HbA1c و ویزیت حضوری لازم است.' } });
  const mine = await t.call('GET', '/v1/records', { token: p.token });
  assert.match(mine.body.items[0].doctor_opinion, /HbA1c/);
  assert.equal(mine.body.items[0].ai_review, undefined);
  assert.equal((await t.call('DELETE', `/v1/records/${rec.body.id}`, { token: p.token })).body.code, 'has_opinion');
});

test('lab ranges: lab-provided range beats the default one', () => {
  const f = reviewLabRows([{ name: 'TSH', value: '4.5', ref: '0.3-5.0' }, { name: 'TSH', value: '4.5' }]);
  assert.equal(f[0].status, 'normal');
  assert.equal(f[1].status, 'high');
});
