// Run against a local dev-mode server only:  node loadtest/local-capacity.mjs <serverPid> http://127.0.0.1:3999 3000 50,100,200,400,800 20
// Local load measurement against a dev-mode server (synthetic data only).
// usage: node run.mjs <serverPid> <base> <patients> <phases e.g. 25,50,100,200,400> <secondsPerPhase>
import { readFileSync } from 'node:fs';
import { TERMS } from '../test/helpers.js';
import { randomNationalId } from '../test/helpers.js';

const [pid, BASE, NPAT = '200', PHASES = '25,50,100,200,400', SECS = '20'] = process.argv.slice(2);
const TICK = 100; // clock ticks/s
const procCpu = () => { const f = readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ')[1].split(' '); return (Number(f[11]) + Number(f[12])) / TICK; };
const procRss = () => Number(/VmRSS:\s+(\d+)/.exec(readFileSync(`/proc/${pid}/status`, 'utf8'))[1]) / 1024;

let ipSeq = 0;
const newIp = () => { ipSeq++; return `10.${(ipSeq >> 16) & 255}.${(ipSeq >> 8) & 255}.${ipSeq & 255}`; };
async function call(method, path, { token, body, ip, headers = {} } = {}) {
  const t0 = performance.now();
  try {
    const res = await fetch(BASE + path, { method, headers: { 'X-Forwarded-For': ip ?? '10.255.255.1', ...(body ? { 'Content-Type': 'application/json' } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined });
    const text = await res.text();
    let json = null; try { json = JSON.parse(text); } catch {}
    return { status: res.status, body: json, ms: performance.now() - t0 };
  } catch (e) { return { status: 0, body: null, ms: performance.now() - t0, err: e.message }; }
}
const phone = (i) => `0936${String(1000000 + i + Number(process.env.OFF ?? 0)).slice(-7)}`;
async function newPatient(i) {
  const ip = newIp(); const p = phone(i); const nid = randomNationalId();
  let r = await call('POST', '/v1/auth/otp/request', { ip, body: { phone: p, role: 'patient', national_id: nid, terms_version: TERMS.patient.version } });
  r = await call('POST', '/v1/auth/otp/verify', { ip, body: { phone: p, code: r.body.dev_code } });
  let token = r.body.access_token;
  await call('PUT', '/v1/patients/me', { ip, token, body: { full_name: 'بیمار آزمایشی', national_id: nid, dob: '1990-05-01' } });
  await call('POST', '/v1/patients/me/consents', { ip, token, body: { type: 'telehealth' } });
  token = (await call('POST', '/v1/auth/refresh', { ip, token })).body.access_token;
  return { token, ip };
}
const pct = (a, p) => { if (!a.length) return 0; const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(p / 100 * s.length))]; };

const users = [];
const t0 = performance.now();
for (let i = 0; i < Number(NPAT); i += 20) users.push(...await Promise.all(Array.from({ length: Math.min(20, Number(NPAT) - i) }, (_, k) => newPatient(i + k))));
console.log(JSON.stringify({ setup: { patients: users.length, seconds: +((performance.now() - t0) / 1000).toFixed(1), valid: users.filter((u) => u.token).length } }));
for (let i = users.length - 1; i >= 0; i--) if (!users[i].token) users.splice(i, 1);
const doctors = (await call('GET', '/v1/doctors', users[0])).body.items;

// Mixed read workload of a patient using the app (weights ≈ browsing + badge polling).
const OPS = [
  [25, 'doctors', (u) => call('GET', '/v1/doctors', u)],
  [25, 'slots', (u) => call('GET', `/v1/doctors/${doctors[Math.floor(Math.random() * doctors.length)].id}/slots`, u)],
  [20, 'notifications', (u) => call('GET', '/v1/notifications', u)],
  [10, 'me', (u) => call('GET', '/v1/auth/me', u)],
  [10, 'appointments', (u) => call('GET', '/v1/appointments', u)],
  [10, 'records', (u) => call('GET', '/v1/records', u)],
];
const pick = () => { let r = Math.random() * 100; for (const o of OPS) { if ((r -= o[0]) < 0) return o; } return OPS[0]; };

async function phase(conc, secs) {
  const lat = []; const per = {}; const codes = {}; let n = 0;
  const end = performance.now() + secs * 1000;
  const c0 = procCpu(); const w0 = performance.now(); let rssMax = 0;
  const sampler = setInterval(() => { rssMax = Math.max(rssMax, procRss()); }, 500);
  await Promise.all(Array.from({ length: conc }, async (_, i) => {
    while (performance.now() < end) {
      const u = users[Math.floor(Math.random() * users.length)];
      const [, name, fn] = pick();
      const r = await fn(u);
      n++; lat.push(r.ms); (per[name] ??= []).push(r.ms); codes[r.status] = (codes[r.status] ?? 0) + 1;
    }
  }));
  clearInterval(sampler);
  const wall = (performance.now() - w0) / 1000; const cpu = (procCpu() - c0) / wall;
  const ok = Object.entries(codes).filter(([k]) => k.startsWith('2')).reduce((a, [, v]) => a + v, 0);
  console.log(JSON.stringify({ conc, rps_ok: +(ok / wall).toFixed(0), p50: +pct(lat, 50).toFixed(1), p95: +pct(lat, 95).toFixed(1), p99: +pct(lat, 99).toFixed(1), err_rate: +((n - ok) / n * 100).toFixed(2), codes, server_cpu_cores: +cpu.toFixed(2), server_rss_mb: +rssMax.toFixed(0),
    per_op_p95: Object.fromEntries(Object.entries(per).map(([k, v]) => [k, +pct(v, 95).toFixed(1)])) }));
}
for (const c of PHASES.split(',').map(Number)) await phase(c, Number(SECS));

// Booking race: many patients try the same free slot at once → exactly one may win.
const slots = (await call('GET', `/v1/doctors/${doctors[0].id}/slots`, users[0])).body.items.filter((s) => s.available !== false);
const target = slots.at(-1);
const race = await Promise.all(users.slice(0, 100).map((u, i) => call('POST', '/v1/appointments', { ...u, headers: { 'Idempotency-Key': `race-${i}-${Date.now()}` }, body: { doctor_id: doctors[0].id, slot_id: target.id, channel: 'video' } })));
const rc = {}; for (const r of race) rc[r.status] = (rc[r.status] ?? 0) + 1;
console.log(JSON.stringify({ booking_race: { contenders: race.length, slot: target.id, codes: rc, p95_ms: +pct(race.map((r) => r.ms), 95).toFixed(1) } }));

// Recovery: after the heaviest phase, light load latency should return to baseline.
await phase(25, 10);
