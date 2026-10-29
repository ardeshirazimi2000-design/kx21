// Multi-core mode: several server processes share one SQLite file. Video-call signals, security rate
// limits and files must work whichever process serves a request; downloads stream in chunks.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startApp, randomNationalId } from './helpers.js';
import { DEMO_ACCOUNTS } from '../src/seed.js';
import { openDb } from '../src/lib/db.js';
import { RateLimiter } from '../src/lib/http.js';

let dir, a, b;
before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'kx21-multi-'));
  const dbPath = join(dir, 'app.db');
  a = await startApp({ dbPath, disableSweeper: true });
  b = await startApp({ dbPath, disableSweeper: true, bootstrap: false }); // like a worker process
});
after(() => { a.close(); b.close(); rmSync(dir, { recursive: true, force: true }); });

test('video-call signals reach the other side through a different process', async () => {
  const p = await a.newPatient({ nationalId: randomNationalId() });
  const [slot] = (await a.call('GET', '/v1/slots?specialty=general&limit=5', { token: p.token })).body.items;
  const appt = await a.call('POST', '/v1/appointments', { token: p.token, body: { doctor_id: slot.doctor_id, slot_id: slot.id, channel: 'video' }, headers: { 'Idempotency-Key': 'mc-1' } });
  const cid = appt.body.consultation.id;
  const doc = await b.login(DEMO_ACCOUNTS.doctors[0].phone);
  const start = (await b.call('GET', `/v1/consultations/${cid}/signal?after=-1`, { token: doc })).body.seq;
  assert.equal((await a.call('POST', `/v1/consultations/${cid}/signal`, { token: p.token, body: { type: 'offer', data: { sdp: 'v=0' } } })).status, 201);
  const got = (await b.call('GET', `/v1/consultations/${cid}/signal?after=${start}`, { token: doc })).body;
  assert.deepEqual(got.items.map((i) => [i.type, i.data]), [['offer', { sdp: 'v=0' }]]);
  // Own signals are not echoed back.
  assert.equal((await a.call('GET', `/v1/consultations/${cid}/signal?after=${start}`, { token: p.token })).body.items.length, 0);
});

test('a file uploaded through one process downloads intact through another, streamed', async () => {
  const p = await a.newPatient({ nationalId: randomNationalId() });
  const data = Buffer.alloc(3 * 1024 * 1024 + 123);
  for (let i = 0; i < data.length; i++) data[i] = (i * 31) & 255;
  data.write('%PDF-1.4', 0);
  const up = await fetch(`${a.base}/v1/files?purpose=medical_record`, { method: 'POST', headers: { Authorization: `Bearer ${p.token}`, 'Content-Type': 'application/pdf' }, body: data }).then((r) => r.json());
  assert.ok(up.url, JSON.stringify(up));
  const r = await fetch(b.base + up.url);
  assert.equal(r.status, 200);
  assert.equal(Number(r.headers.get('content-length')), data.length);
  assert.ok(Buffer.from(await r.arrayBuffer()).equals(data));
  assert.equal((await fetch(b.base + up.url.replace(/sig=[^&]+/, 'sig=AAAA'))).status, 403);
});

test('security rate limits are counted across processes', () => {
  const dbPath = join(dir, 'app.db');
  const x = new RateLimiter(openDb(dbPath));
  const y = new RateLimiter(openDb(dbPath));
  x.hitShared('otp:test', 3, 60_000);
  y.hitShared('otp:test', 3, 60_000);
  x.hitShared('otp:test', 3, 60_000);
  assert.throws(() => y.hitShared('otp:test', 3, 60_000), (e) => e.status === 429);
  // A fresh window starts after the old one ends.
  y.hitShared('otp:test', 3, 60_000, Date.now() + 61_000);
  assert.equal(x.firstIn('join:c1', 60_000), true);
  assert.equal(y.firstIn('join:c1', 60_000), false);
});
