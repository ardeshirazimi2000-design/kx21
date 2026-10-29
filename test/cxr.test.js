// Chest X-ray pattern flags: doctor-only research aid, with physician feedback for the pilot.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn, execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { startApp, randomNationalId } from './helpers.js';
import { DEMO_ACCOUNTS } from '../src/seed.js';

const PNG1x1 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
let fake;
let t;
let calls = 0;
before(async () => {
  fake = http.createServer((req, res) => {
    calls++;
    req.resume();
    req.on('end', () => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        model: 'fake-cxr', quality: ['low_resolution'], overlays: { Cardiomegaly: PNG1x1 },
        findings: [{ key: 'Cardiomegaly', score: 0.62, tier: 'moderate' }, { key: 'Effusion', score: 0.41, tier: 'none' }, { key: 'Bogus', score: 0.9, tier: 'strong' }],
      }));
    });
  }).listen(0, '127.0.0.1');
  await new Promise((r) => fake.once('listening', r));
  t = await startApp({ disableSweeper: true, cxrUrl: `http://127.0.0.1:${fake.address().port}` });
});
after(() => { t.close(); fake.close(); });

test('CXR flags: treating doctor only, confirmation required, overlays private, feedback → pilot stats', async () => {
  const p = await t.newPatient({ nationalId: randomNationalId() });
  const [slot] = (await t.call('GET', '/v1/slots?specialty=general&limit=5', { token: p.token })).body.items;
  const appt = (await t.call('POST', '/v1/appointments', { token: p.token, headers: { 'Idempotency-Key': 'cxr-1' }, body: { doctor_id: slot.doctor_id, slot_id: slot.id, channel: 'chat' } })).body;
  const img = readFileSync(new URL('./fixtures/cxr-nih-00000001_000.png', import.meta.url));
  const up = await (await fetch(`${t.base}/v1/files?purpose=medical_record`, { method: 'POST', headers: { Authorization: `Bearer ${p.token}`, 'Content-Type': 'image/png' }, body: img })).json();
  const rec = (await t.call('POST', '/v1/records', { token: p.token, body: { category: 'imaging', title: 'عکس قفسه سینه', appointment_id: appt.id, file_ids: [up.id] } })).body;

  // There is no user-uploadable "AI overlay" file type.
  assert.equal((await fetch(`${t.base}/v1/files?purpose=ai_overlay`, { method: 'POST', headers: { Authorization: `Bearer ${p.token}`, 'Content-Type': 'image/png' }, body: img })).status, 422);

  const doc = await t.login(DEMO_ACCOUNTS.doctors[0].phone);
  const other = await t.login(DEMO_ACCOUNTS.doctors[3].phone);
  assert.equal((await t.call('POST', `/v1/records/${rec.id}/cxr`, { token: doc, body: { file_id: up.id } })).body.code, 'confirmation_required');
  assert.equal((await t.call('POST', `/v1/records/${rec.id}/cxr`, { token: other, body: { file_id: up.id, confirm_frontal_cxr: true } })).status, 404);
  assert.equal((await t.call('POST', `/v1/records/${rec.id}/cxr`, { token: p.token, body: { file_id: up.id, confirm_frontal_cxr: true } })).status, 403);

  const a = await t.call('POST', `/v1/records/${rec.id}/cxr`, { token: doc, body: { file_id: up.id, confirm_frontal_cxr: true } });
  assert.equal(a.status, 201);
  assert.deepEqual(a.body.findings.map((f) => [f.key, f.tier]), [['Cardiomegaly', 'moderate'], ['Effusion', 'none']]); // unknown keys dropped
  assert.equal(a.body.findings[0].label, 'بزرگی سایه قلب');
  assert.match(a.body.quality[0].message, /وضوح/);
  assert.match(a.body.disclaimer, /تشخیص نیست/);
  const ov = await fetch(`${t.base}${a.body.findings[0].overlay_url}`);
  assert.equal(ov.headers.get('content-type'), 'image/png');

  // The patient's record view never carries the analysis.
  const mine = (await t.call('GET', '/v1/records', { token: p.token })).body.items.find((r) => r.id === rec.id);
  assert.equal(JSON.stringify(mine).includes('Cardiomegaly'), false);

  assert.equal((await t.call('POST', `/v1/cxr/${a.body.id}/feedback`, { token: doc, body: { verdicts: { Effusion: 'agree' } } })).status, 422); // not a flag
  const fb = await t.call('POST', `/v1/cxr/${a.body.id}/feedback`, { token: doc, body: { verdicts: { Cardiomegaly: 'agree' }, missed: ['Effusion'], overall: 'useful', note: 'سایه قلب بزرگ' } });
  assert.deepEqual(fb.body.feedback, { verdicts: { Cardiomegaly: 'agree' }, missed: ['Effusion'], overall: 'useful' });

  const admin = await t.login(DEMO_ACCOUNTS.admin.phone);
  const st = (await t.call('GET', '/v1/admin/cxr-stats', { token: admin })).body;
  assert.equal(st.analyses, 1);
  assert.equal(st.reviewed, 1);
  const cm = st.items.find((x) => x.key === 'Cardiomegaly');
  assert.deepEqual([cm.flagged, cm.agree, cm.agreement], [1, 1, 100]);
  assert.equal(st.items.find((x) => x.key === 'Effusion').missed, 1);
  assert.equal(calls, 1);
});

// The real model service (skipped when python/onnxruntime are not installed).
const hasRuntime = (() => { try { execFileSync('python3', ['-c', 'import onnxruntime, numpy, PIL'], { stdio: 'ignore' }); return true; } catch { return false; } })();
test('real CXR service flags cardiomegaly on the NIH sample and rejects a document photo', { skip: !hasRuntime && 'onnxruntime not installed' }, async () => {
  const port = 18000 + Math.floor(Math.random() * 1000);
  const svc = spawn('python3', [new URL('../cxr/cxr_service.py', import.meta.url).pathname], { env: { ...process.env, CXR_PORT: String(port) }, stdio: ['ignore', 'pipe', 'inherit'] });
  try {
    await new Promise((resolve, reject) => { svc.stdout.once('data', resolve); svc.once('exit', reject); });
    const ask = async (file, mime) => (await fetch(`http://127.0.0.1:${port}/analyze`, { method: 'POST', headers: { 'Content-Type': mime }, body: readFileSync(new URL(file, import.meta.url)) })).json();
    const cxr = await ask('./fixtures/cxr-nih-00000001_000.png', 'image/png');
    assert.equal(cxr.findings[0].key, 'Cardiomegaly');
    assert.notEqual(cxr.findings[0].tier, 'none');
    assert.ok(cxr.overlays.Cardiomegaly);
    assert.deepEqual(cxr.quality, []);
    const doc = await ask('./fixtures/lab-sheet-photo.jpg', 'image/jpeg');
    assert.ok(doc.quality.includes('not_cxr_like'));
  } finally {
    svc.kill();
  }
});
