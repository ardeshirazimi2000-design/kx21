import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, NATIONAL_IDS } from './helpers.js';
import { DEMO_ACCOUNTS } from '../src/seed.js';

let t;
before(async () => { t = await startApp(); });
after(() => t.close());

const firstFreeSlot = async (token, specialty = 'general') =>
  (await t.call('GET', `/v1/slots?specialty=${specialty}&limit=50`, { token })).body.items;

test('OTP login, profile with encrypted national id, standard error shape', async () => {
  const bad = await t.call('POST', '/v1/auth/otp/request', { body: { phone: '123' } });
  assert.equal(bad.status, 422);
  assert.deepEqual(Object.keys(bad.body).sort(), ['code', 'message', 'trace_id']);

  const r1 = await t.call('POST', '/v1/auth/otp/request', { body: { phone: '+989121112233' } });
  assert.equal(r1.status, 202);
  const wrong = await t.call('POST', '/v1/auth/otp/verify', { body: { phone: '09121112233', code: '000000' === r1.body.dev_code ? '111111' : '000000' } });
  assert.equal(wrong.status, 401);
  const ok = await t.call('POST', '/v1/auth/otp/verify', { body: { phone: '09121112233', code: r1.body.dev_code } });
  assert.equal(ok.status, 200);
  const token = ok.body.access_token;

  const noProfile = await t.call('GET', '/v1/patients/me', { token });
  assert.equal(noProfile.body.code, 'profile_incomplete');
  const invalidNid = await t.call('PUT', '/v1/patients/me', { token, body: { full_name: 'علی', national_id: '1234567890', dob: '1990-01-01' } });
  assert.equal(invalidNid.body.code, 'invalid_national_id');
  const created = await t.call('PUT', '/v1/patients/me', { token, body: { full_name: 'علی رضایی', national_id: NATIONAL_IDS[5], dob: '1990-01-01' } });
  assert.equal(created.status, 201);
  assert.equal(created.body.national_id, '******9645');

  const row = t.app.db.get('SELECT national_id_enc FROM patients WHERE id = ?', created.body.id);
  assert.ok(!Buffer.from(row.national_id_enc).toString().includes('0076229645'), 'national id must be encrypted at rest');
});

test('booking requires Idempotency-Key and consent; replays are safe; slot conflicts return 409', async () => {
  const a = await t.newPatient({ nationalId: NATIONAL_IDS[0] });
  const b = await t.newPatient({ nationalId: NATIONAL_IDS[1] });
  const noConsent = await t.newPatient({ nationalId: NATIONAL_IDS[2], consents: [] });
  const [slot] = await firstFreeSlot(a.token);
  const body = { doctor_id: slot.doctor_id, slot_id: slot.id, channel: 'video' };

  assert.equal((await t.call('POST', '/v1/appointments', { token: a.token, body })).body.code, 'idempotency_key_required');
  assert.equal((await t.call('POST', '/v1/appointments', { token: noConsent.token, body, headers: { 'Idempotency-Key': 'k0' } })).body.code, 'consent_required');

  const first = await t.call('POST', '/v1/appointments', { token: a.token, body, headers: { 'Idempotency-Key': 'k1' } });
  assert.equal(first.status, 201);
  assert.equal(first.body.status, 'confirmed');
  const replay = await t.call('POST', '/v1/appointments', { token: a.token, body, headers: { 'Idempotency-Key': 'k1' } });
  assert.equal(replay.status, 200);
  assert.equal(replay.body.id, first.body.id);
  const taken = await t.call('POST', '/v1/appointments', { token: b.token, body, headers: { 'Idempotency-Key': 'k1' } });
  assert.equal(taken.status, 409);
  assert.equal(taken.body.code, 'slot_taken');

  // Patient B cannot see A's appointment.
  assert.equal((await t.call('GET', `/v1/appointments/${first.body.id}`, { token: b.token })).status, 404);

  // Cancel frees the slot.
  const c = await t.call('POST', `/v1/appointments/${first.body.id}/cancel`, { token: a.token, body: {} });
  assert.equal(c.body.status, 'cancelled');
  const again = await t.call('POST', '/v1/appointments', { token: b.token, body, headers: { 'Idempotency-Key': 'k2' } });
  assert.equal(again.status, 201);
  await t.call('POST', `/v1/appointments/${again.body.id}/cancel`, { token: b.token, body: {} });
});

test('assistant: symptom → triage → slot choice → explicit confirmation → booking', async () => {
  const p = await t.newPatient({ nationalId: NATIONAL_IDS[3] });
  const sid = t.uuid();

  const g = await t.chat(p.token, sid, 'سلام');
  assert.equal(g.mode, 'INFO_MODE');

  const s1 = await t.chat(p.token, sid, 'سه روزه سرفه و گلودرد دارم');
  assert.equal(s1.mode, 'TRIAGE_MODE');
  assert.ok(s1.events.some((e) => e.event === 'mode_change' && e.data.to === 'TRIAGE_MODE'));
  assert.match(s1.text, /شدت/);

  const s2 = await t.chat(p.token, sid, '۵');
  assert.equal(s2.mode, 'BOOKING_MODE');
  assert.ok(s2.events.some((e) => e.event === 'tool_call' && e.data.name === 'check_availability' && e.data.status === 'ok'));
  const opts = s2.events.find((e) => e.event === 'options').data.items;
  assert.ok(opts.length >= 1);

  const s3 = await t.chat(p.token, sid, '۱');
  assert.match(s3.text, /تأیید/);
  assert.ok(!s3.events.some((e) => e.event === 'tool_call' && e.data.name === 'book_appointment'), 'must not book before confirmation');

  const s4 = await t.chat(p.token, sid, 'بله');
  assert.equal(s4.mode, 'INFO_MODE');
  assert.ok(s4.done.booked_appointment_id);
  const appt = await t.call('GET', `/v1/appointments/${s4.done.booked_appointment_id}`, { token: p.token });
  assert.equal(appt.body.booked_via, 'ai_assistant');
  assert.equal(appt.body.slot_id, opts[0].slot_id);
  assert.ok(appt.body.triage_result_id);

  // Each tool call is in the audit log with the request trace id.
  const audits = t.app.db.all(`SELECT action, trace_id FROM audit_logs WHERE action LIKE 'ai.tool.%'`);
  assert.ok(audits.some((a) => a.action === 'ai.tool.book_appointment' && a.trace_id));
  await t.call('POST', `/v1/appointments/${appt.body.id}/cancel`, { token: p.token, body: {} });
});

test('assistant: emergency rule fires before any model and only a human can exit', async () => {
  const p = await t.newPatient({ nationalId: NATIONAL_IDS[4] });
  const sid = t.uuid();
  const r = await t.chat(p.token, sid, 'از نیم ساعت پیش درد قفسه‌ی سینه دارم و عرق سرد کردم');
  assert.equal(r.mode, 'EMERGENCY_MODE');
  assert.match(r.text, /۱۱۵/);
  const esc = r.events.find((e) => e.event === 'escalation');
  assert.equal(esc.data.kind, 'emergency');

  const hold = await t.chat(p.token, sid, 'میخوام نوبت بگیرم');
  assert.equal(hold.mode, 'EMERGENCY_MODE');
  assert.ok(!hold.events.some((e) => e.event === 'tool_call'));

  const op = await t.login(DEMO_ACCOUNTS.operator.phone);
  const list = await t.call('GET', '/v1/escalations', { token: op });
  assert.equal(list.body.items[0].kind, 'emergency');
  assert.equal((await t.call('POST', `/v1/escalations/${esc.data.escalation_id}/messages`, { token: op, body: { content: 'با شما تماس می‌گیریم' } })).status, 201);
  await t.call('POST', `/v1/escalations/${esc.data.escalation_id}/resolve`, { token: op, body: {} });
  const msgs = await t.call('GET', `/v1/ai/sessions/${sid}/messages`, { token: p.token });
  assert.equal(msgs.body.mode, 'INFO_MODE');
  assert.ok(msgs.body.items.some((m) => m.sender_role === 'operator'));

  // Patients cannot use the operator console.
  assert.equal((await t.call('GET', '/v1/escalations', { token: p.token })).status, 403);
});

test('assistant: grounded answers cite the KB; low retrieval confidence escalates instead of guessing', async () => {
  const p = await t.newPatient({ nationalId: '0010532129' });
  const sid = t.uuid();
  const a = await t.chat(p.token, sid, 'نسخه الکترونیک چطور صادر میشه؟');
  const cite = a.events.find((e) => e.event === 'citation');
  assert.equal(cite.data.id, 'kb-prescription');

  const b = await t.chat(p.token, sid, 'قیمت بیت کوین فردا چند میشه؟');
  assert.ok(b.events.some((e) => e.event === 'escalation' && e.data.kind === 'low_confidence'));

  const other = await t.newPatient({ nationalId: '0016533135' });
  const hijack = await t.call('POST', '/v1/ai/chat', { token: other.token, body: { session_id: sid, message: { type: 'text', content: 'سلام' } } });
  assert.equal(hijack.status, 403);
});

test('doctor: MFA login, ABAC on patient record, visit room, end → follow-up, signed prescription', async () => {
  const p = await t.newPatient({ nationalId: '0010350829' });
  const [slot] = await firstFreeSlot(p.token, 'cardiology');
  const appt = await t.call('POST', '/v1/appointments', {
    token: p.token, body: { doctor_id: slot.doctor_id, slot_id: slot.id, channel: 'chat' }, headers: { 'Idempotency-Key': 'doc-flow' },
  });
  assert.equal(appt.status, 201);

  // MFA is mandatory for doctors.
  const r1 = await t.call('POST', '/v1/auth/otp/request', { body: { phone: DEMO_ACCOUNTS.doctors[1].phone } });
  const r2 = await t.call('POST', '/v1/auth/otp/verify', { body: { phone: DEMO_ACCOUNTS.doctors[1].phone, code: r1.body.dev_code } });
  assert.equal(r2.body.mfa_required, true);
  assert.equal(r2.body.access_token, undefined);
  const doc = (await t.call('POST', '/v1/auth/mfa/verify', { body: { mfa_token: r2.body.mfa_token, code: r2.body.dev_code } })).body.access_token;
  const otherDoc = await t.login(DEMO_ACCOUNTS.doctors[2].phone);

  const rec = await t.call('GET', `/v1/patients/${appt.body.patient_id}`, { token: doc });
  assert.equal(rec.status, 200);
  const denied = await t.call('GET', `/v1/patients/${appt.body.patient_id}`, { token: otherDoc });
  assert.equal(denied.status, 403);
  assert.equal(denied.body.code, 'no_care_relationship');

  const cid = appt.body.consultation.id;
  const join = await t.call('POST', `/v1/consultations/${cid}/join`, { token: p.token, body: {} });
  assert.equal(join.status, 200);
  assert.ok(join.body.token && join.body.room_id);
  assert.equal((await t.call('POST', `/v1/consultations/${cid}/join`, { token: otherDoc, body: {} })).status, 404);
  await t.call('POST', `/v1/consultations/${cid}/messages`, { token: p.token, body: { content: 'سلام دکتر' } });
  const msgs = await t.call('GET', `/v1/consultations/${cid}/messages`, { token: doc });
  assert.equal(msgs.body.items[0].content, 'سلام دکتر');

  const draft = await t.call('POST', '/v1/prescriptions', {
    token: doc, headers: { 'Idempotency-Key': 'rx1' },
    body: { consultation_id: cid, drugs: [{ name: 'Atorvastatin', dose: '20mg', frequency: 'شبی یک عدد', duration: '30 روز' }] },
  });
  assert.equal(draft.status, 201);
  assert.equal(draft.body.status, 'draft');
  assert.equal((await t.call('GET', `/v1/prescriptions/${draft.body.id}/verify`)).body.valid, false);
  assert.equal((await t.call('GET', '/v1/prescriptions', { token: p.token })).body.items.length, 0, 'drafts are invisible to the patient');

  const signed = await t.call('POST', `/v1/prescriptions/${draft.body.id}/sign`, { token: doc, body: {} });
  assert.equal(signed.body.status, 'issued');
  assert.equal((await t.call('GET', `/v1/prescriptions/${draft.body.id}/verify`)).body.valid, true);
  // Tampering breaks the signature.
  t.app.db.run('UPDATE prescriptions SET drugs = ? WHERE id = ?', JSON.stringify([{ name: 'Morphine' }]), draft.body.id);
  assert.equal((await t.call('GET', `/v1/prescriptions/${draft.body.id}/verify`)).body.valid, false);

  const end = await t.call('POST', `/v1/consultations/${cid}/end`, { token: doc, body: {} });
  assert.ok(end.body.ended_at);
  await new Promise((r) => setTimeout(r, 30)); // event consumers run asynchronously
  const sessions = await t.call('GET', '/v1/ai/sessions', { token: p.token });
  assert.equal(sessions.body.items[0].mode, 'FOLLOWUP_MODE');
  assert.equal((await t.call('GET', `/v1/appointments/${appt.body.id}`, { token: p.token })).body.status, 'completed');
});

test('audit log is append-only', () => {
  assert.throws(() => t.app.db.run('UPDATE audit_logs SET action = ?', 'x'), /append-only/);
  assert.throws(() => t.app.db.run('DELETE FROM audit_logs'), /append-only/);
});

test('rate limiting returns 429 with the standard error shape', async () => {
  const phone = '09129998877';
  for (let i = 0; i < 3; i++) await t.call('POST', '/v1/auth/otp/request', { body: { phone } });
  const r = await t.call('POST', '/v1/auth/otp/request', { body: { phone } });
  assert.equal(r.status, 429);
  assert.equal(r.body.code, 'rate_limited');
  assert.ok(r.body.trace_id);
});

test('CORS allows the native app origin only', async () => {
  const pre = await fetch(`${t.base}/v1/ai/chat`, {
    method: 'OPTIONS',
    headers: { Origin: 'https://localhost', 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'authorization,content-type' },
  });
  assert.equal(pre.status, 204);
  assert.equal(pre.headers.get('access-control-allow-origin'), 'https://localhost');
  assert.match(pre.headers.get('access-control-allow-headers'), /Idempotency-Key/);
  const evil = await fetch(`${t.base}/healthz`, { headers: { Origin: 'https://evil.example' } });
  assert.equal(evil.headers.get('access-control-allow-origin'), null);
});

test('PWA assets are served', async () => {
  const m = await fetch(`${t.base}/manifest.webmanifest`);
  assert.equal(m.headers.get('content-type'), 'application/manifest+json');
  assert.equal((await m.json()).display, 'standalone');
  assert.equal((await fetch(`${t.base}/sw.js`)).status, 200);
  assert.equal((await fetch(`${t.base}/icons/icon-512.png`)).headers.get('content-type'), 'image/png');
});

test('doctor calendar: literal /me routes are not shadowed by /:id routes', async () => {
  const doc = await t.login(DEMO_ACCOUNTS.doctors[0].phone);
  const mine = await t.call('GET', '/v1/doctors/me/slots', { token: doc });
  assert.equal(mine.status, 200);
  assert.ok(mine.body.items.length > 0);
  const start = new Date(Date.now() + 9 * 864e5);
  start.setUTCHours(5, 30, 0, 0);
  const pub = await t.call('POST', '/v1/doctors/me/slots', {
    token: doc, body: { starts_at: start.toISOString(), ends_at: new Date(start.getTime() + 3600e3).toISOString(), duration_min: 30 },
  });
  assert.equal(pub.status, 201);
  assert.equal(pub.body.created, 2);
});
