// Extra local measurements: write throughput, and event-loop stall while large encrypted files are served.
import { TERMS, randomNationalId } from '../test/helpers.js';
import { randomBytes } from 'node:crypto';
const B = 'http://127.0.0.1:3999';
let ipn = 0;
const call = async (m, p, { token, body, raw, ctype, ip = '10.250.0.1' } = {}) => {
  const t0 = performance.now();
  const r = await fetch(B + p, { method: m, headers: { 'X-Forwarded-For': ip, ...(body ? { 'Content-Type': 'application/json' } : {}), ...(ctype ? { 'Content-Type': ctype } : {}), ...(token ? { Authorization: 'Bearer ' + token } : {}) }, body: raw ?? (body ? JSON.stringify(body) : undefined) });
  const buf = Buffer.from(await r.arrayBuffer());
  let b = null; try { b = JSON.parse(buf); } catch {}
  return { s: r.status, b, ms: performance.now() - t0, bytes: buf.length };
};
const pct = (a, p) => { const s = [...a].sort((x, y) => x - y); return +s[Math.min(s.length - 1, Math.floor(p / 100 * s.length))].toFixed(1); };
async function patient(i) {
  const ip = `10.251.${(i >> 8) & 255}.${i & 255}`; const phone = `0937${String(1000000 + i).slice(-7)}`; const nid = randomNationalId();
  let r = await call('POST', '/v1/auth/otp/request', { ip, body: { phone, role: 'patient', national_id: nid, terms_version: TERMS.patient.version } });
  r = await call('POST', '/v1/auth/otp/verify', { ip, body: { phone, code: r.b.dev_code } });
  let token = r.b.access_token;
  await call('PUT', '/v1/patients/me', { ip, token, body: { full_name: 'بیمار آزمایشی', national_id: nid, dob: '1990-05-01' } });
  token = (await call('POST', '/v1/auth/refresh', { ip, token })).b.access_token;
  return { token, ip };
}
const users = [];
for (let i = 0; i < 400; i += 20) users.push(...await Promise.all(Array.from({ length: 20 }, (_, k) => patient(i + k))));

// 1) write workload: consent grant/revoke (one INSERT/UPDATE + audit INSERT per request).
for (const conc of [50, 200]) {
  const lat = []; let ok = 0; const end = performance.now() + 15000; const w0 = performance.now();
  await Promise.all(Array.from({ length: conc }, async () => {
    while (performance.now() < end) {
      const u = users[Math.floor(Math.random() * users.length)];
      const r = Math.random() < 0.5 ? await call('POST', '/v1/patients/me/consents', { ...u, body: { type: 'telehealth' } }) : await call('DELETE', '/v1/patients/me/consents/telehealth', u);
      lat.push(r.ms); if (r.s < 300) ok++;
    }
  }));
  console.log(JSON.stringify({ writes: { conc, rps_ok: Math.round(ok / ((performance.now() - w0) / 1000)), p95: pct(lat, 95), p99: pct(lat, 99), errors: lat.length - ok } }));
}

// 2) health-check latency while 8 MB encrypted medical files are downloaded concurrently.
const u = users[0];
const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), randomBytes(8 * 1024 * 1024 - 100)]);
const up = await call('POST', '/v1/files?purpose=medical_record', { ...u, raw: png, ctype: 'image/png' });
console.log(JSON.stringify({ upload_8mb: { status: up.s, ms: Math.round(up.ms) } }));
const idle = []; for (let i = 0; i < 50; i++) idle.push((await call('GET', '/healthz')).ms);
let stop = false; const hl = [];
const probe = (async () => { while (!stop) { hl.push((await call('GET', '/healthz')).ms); await new Promise((r) => setTimeout(r, 20)); } })();
const dl = []; const t0 = performance.now();
await Promise.all(Array.from({ length: 10 }, async () => { for (let k = 0; k < 3; k++) { const r = await call('GET', up.b.url); dl.push(r.ms); } }));
stop = true; await probe;
console.log(JSON.stringify({ file_download_8mb: { downloads: dl.length, p50_ms: pct(dl, 50), p95_ms: pct(dl, 95), total_s: +((performance.now() - t0) / 1000).toFixed(1) }, healthz_idle_p95: pct(idle, 95), healthz_during_downloads: { p50: pct(hl, 50), p95: pct(hl, 95), max: pct(hl, 100) } }));
