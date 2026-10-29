// k6 load test for Darman Plus — run ONLY against a staging copy, never production.
// Synthetic data only: phones 0936xxxxxxx, random valid national ids, no real patients.
// Staging must run with NODE_ENV=development (OTP returned as dev_code, mock payment gateway).
//
//   k6 run -e BASE=https://staging.example.ir -e USERS=500 -e PROFILE=ramp loadtest/k6-darman.js
//   PROFILE: smoke | ramp (100→500→1000) | stress (to 5000 VUs) | spike | soak
//
// Rate limits are per IP (600/min) and per user (300/min) and hard-coded in src/app.js; run k6 from
// several machines, or the per-IP limit — not the server — will be what you measure.
import http from 'k6/http';
import { check, sleep, group } from 'k6';
import { Trend, Counter, Rate } from 'k6/metrics';
import { uuidv4 } from 'https://jslib.k6.io/k6-utils/1.4.0/index.js';

const BASE = __ENV.BASE || 'http://127.0.0.1:3000';
const USERS = Number(__ENV.USERS || 200);
const TERMS_V = __ENV.TERMS_V || '1405-07-23';
const PHONE_OFFSET = Number(__ENV.PHONE_OFFSET || 0);

const bookingConflict = new Counter('booking_conflict');
const bookingOk = new Counter('booking_ok');
const paymentOk = new Rate('payment_ok');
const aiLatency = new Trend('ai_chat_ms', true);

const PROFILES = {
  smoke: { executor: 'constant-vus', vus: 5, duration: '1m' },
  ramp: {
    executor: 'ramping-vus', startVUs: 0, gracefulRampDown: '30s',
    stages: [
      { duration: '2m', target: 100 }, { duration: '5m', target: 100 },
      { duration: '2m', target: 500 }, { duration: '5m', target: 500 },
      { duration: '2m', target: 1000 }, { duration: '5m', target: 1000 },
      { duration: '2m', target: 50 }, { duration: '3m', target: 50 }, // recovery after load drops
    ],
  },
  stress: {
    executor: 'ramping-vus', startVUs: 0,
    stages: [{ duration: '5m', target: 2000 }, { duration: '5m', target: 5000 }, { duration: '5m', target: 5000 }, { duration: '3m', target: 50 }, { duration: '5m', target: 50 }],
  },
  spike: { executor: 'ramping-vus', startVUs: 50, stages: [{ duration: '1m', target: 50 }, { duration: '20s', target: 2000 }, { duration: '2m', target: 2000 }, { duration: '20s', target: 50 }, { duration: '3m', target: 50 }] },
  soak: { executor: 'constant-vus', vus: 300, duration: '2h' },
};

export const options = {
  setupTimeout: '20m',
  scenarios: {
    patients: { ...(PROFILES[__ENV.PROFILE || 'smoke']), exec: 'patientJourney' },
    // Many patients racing for the same slots: exactly one booking per slot may succeed.
    booking_race: { executor: 'per-vu-iterations', vus: 100, iterations: 1, startTime: '30s', exec: 'bookingRace' },
  },
  thresholds: {
    http_req_failed: ['rate<0.01'],
    'http_req_duration{kind:read}': ['p(95)<300', 'p(99)<800'],
    'http_req_duration{kind:write}': ['p(95)<500'],
    payment_ok: ['rate>0.99'],
  },
};

function randomNationalId() {
  const d = Array.from({ length: 9 }, () => Math.floor(Math.random() * 10));
  if (d.every((x) => x === d[0])) d[0] = (d[0] + 1) % 10;
  const r = d.reduce((a, x, i) => a + x * (10 - i), 0) % 11;
  return d.join('') + (r < 2 ? r : 11 - r);
}
const json = (body, token, extra = {}) => ({ headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...extra } });
const auth = (token, kind = 'read') => ({ headers: { Authorization: `Bearer ${token}` }, tags: { kind } });

function registerPatient(i) {
  const phone = `0936${String(1000000 + PHONE_OFFSET + i).slice(-7)}`;
  const nid = randomNationalId();
  let r = http.post(`${BASE}/v1/auth/otp/request`, JSON.stringify({ phone, role: 'patient' }), json());
  let body = r.json();
  if (body.registration_required) {
    r = http.post(`${BASE}/v1/auth/otp/request`, JSON.stringify({ phone, role: 'patient', national_id: nid, terms_version: TERMS_V }), json());
    body = r.json();
  }
  if (!body.dev_code) return null; // staging must be in development mode
  r = http.post(`${BASE}/v1/auth/otp/verify`, JSON.stringify({ phone, code: body.dev_code }), json());
  let token = r.json('access_token');
  http.put(`${BASE}/v1/patients/me`, JSON.stringify({ full_name: 'بیمار آزمایشی', national_id: nid, dob: '1990-05-01' }), json(null, token));
  http.post(`${BASE}/v1/patients/me/consents`, JSON.stringify({ type: 'telehealth' }), json(null, token));
  token = http.post(`${BASE}/v1/auth/refresh`, null, json(null, token)).json('access_token');
  return token;
}

export function setup() {
  const tokens = [];
  for (let i = 0; i < USERS; i++) { const t = registerPatient(i); if (t) tokens.push(t); }
  const doctors = http.get(`${BASE}/v1/doctors`, auth(tokens[0])).json('items');
  return { tokens, doctors: doctors.map((d) => d.id) };
}

export function patientJourney(data) {
  const token = data.tokens[(__VU * 7919 + __ITER) % data.tokens.length];
  const doctorId = data.doctors[Math.floor(Math.random() * data.doctors.length)];
  group('browse', () => {
    check(http.get(`${BASE}/v1/doctors`, auth(token)), { doctors: (r) => r.status === 200 });
    sleep(1 + Math.random() * 2);
    check(http.get(`${BASE}/v1/doctors/${doctorId}/slots`, auth(token)), { slots: (r) => r.status === 200 });
    http.get(`${BASE}/v1/notifications`, auth(token));
  });
  sleep(2 + Math.random() * 3);
  group('records', () => {
    http.get(`${BASE}/v1/appointments`, auth(token));
    http.get(`${BASE}/v1/records`, auth(token));
    http.get(`${BASE}/v1/summaries`, auth(token));
  });
  if (Math.random() < 0.1) {
    group('assistant', () => {
      const r = http.post(`${BASE}/v1/ai/chat`, JSON.stringify({ session_id: uuidv4(), message: { type: 'text', content: 'سردرد دارم از دیروز' } }), { ...json(null, token), tags: { kind: 'write' }, timeout: '30s' });
      aiLatency.add(r.timings.duration);
    });
  }
  if (Math.random() < 0.05) bookAndPay(token, doctorId);
  sleep(3 + Math.random() * 5);
}

// Book a free slot, then pay through the staging mock gateway (enable tariffs in staging first).
function bookAndPay(token, doctorId) {
  const slots = http.get(`${BASE}/v1/doctors/${doctorId}/slots`, auth(token)).json('items') || [];
  if (!slots.length) return;
  const slot = slots[Math.floor(Math.random() * slots.length)];
  const r = http.post(`${BASE}/v1/appointments`, JSON.stringify({ doctor_id: doctorId, slot_id: slot.id, channel: 'video' }), { ...json(null, token, { 'Idempotency-Key': uuidv4() }), tags: { kind: 'write' } });
  if (r.status === 409) { bookingConflict.add(1); return; }
  if (r.status !== 201) return;
  bookingOk.add(1);
  const appt = r.json();
  if (appt.status !== 'pending') return; // free visit, nothing to pay
  const pay = (http.get(`${BASE}/v1/payments`, auth(token)).json('items') || []).find((p) => p.ref_id === appt.id && p.status === 'pending');
  if (!pay) return;
  const start = http.post(`${BASE}/v1/payments/${pay.id}/start`, null, { ...json(null, token), tags: { kind: 'write' } });
  const authority = start.json('authority');
  http.get(`${BASE}/v1/payments/callback?Authority=${authority}&Status=OK`, { tags: { kind: 'write' } });
  paymentOk.add(http.get(`${BASE}/v1/payments/${pay.id}`, auth(token)).json('status') === 'paid');
}

export function bookingRace(data) {
  const token = data.tokens[__VU % data.tokens.length];
  const doctorId = data.doctors[0];
  const slots = http.get(`${BASE}/v1/doctors/${doctorId}/slots`, auth(token)).json('items') || [];
  if (!slots.length) return;
  const r = http.post(`${BASE}/v1/appointments`, JSON.stringify({ doctor_id: doctorId, slot_id: slots.at(-1).id, channel: 'video' }), { ...json(null, token, { 'Idempotency-Key': uuidv4() }), tags: { kind: 'write' } });
  if (r.status === 201) bookingOk.add(1); else if (r.status === 409) bookingConflict.add(1);
  check(r, { 'race: 201 or 409': (x) => x.status === 201 || x.status === 409 });
}
