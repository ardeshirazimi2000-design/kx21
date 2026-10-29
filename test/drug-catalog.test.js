// National drug coding (eRx-IRC) import: preview → activate → search → prescription codes → rollback.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { startApp, randomNationalId } from './helpers.js';
import { DEMO_ACCOUNTS } from '../src/seed.js';
import { parseCatalog, parseErxTitle } from '../src/modules/rx/drug-catalog.js';
import { readXlsx } from '../src/lib/xlsx.js';

const XLSX = readFileSync(new URL('./fixtures/erx-coding-sample.xlsx', import.meta.url));

test('xlsx reader + eRx title parsing', () => {
  const sheets = readXlsx(XLSX);
  assert.deepEqual(sheets.map((s) => s.name), ['کدینگ نسخه نویسی', 'کدینگ نسخه پیچی', 'حذفیات']);
  assert.deepEqual(sheets[0].rows[2], ['60101', 'AMOXICILLIN 500 mg CAPSULE ORAL [AFAMOX]', '120']);
  assert.deepEqual(parseErxTitle('PANTOPRAZOLE (AS SODIUM SESQUIHYDRATE) 40 mg TABLET, DELAYED RELEASE ORAL [PANTOZOL]'), { generic: 'PANTOPRAZOLE', brand: 'PANTOZOL', form: 'TABLET' });
  const p = parseCatalog(XLSX);
  assert.equal(p.summary.prescribing_rows, 12);
  assert.equal(p.summary.dispensing_rows, 2);
  assert.deepEqual(p.deleted, [{ erx_code: '59999', title: 'AMOXICILLIN 500 mg CAPSULE ORAL [OLDBRAND]', replacement: '60101' }]);
  assert.equal(p.items.find((x) => x.erx_code === '60101').packs, 2);
  assert.ok(p.summary.safety_covered_generics >= 8);
});

let t;
before(async () => { t = await startApp({ disableSweeper: true }); });
after(() => t.close());

const upload = (token, body, name = 'coding.xlsx') => fetch(`${t.base}/v1/admin/drug-catalog?filename=${encodeURIComponent(name)}`, {
  method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }, body,
}).then(async (r) => ({ status: r.status, body: await r.json() }));

test('admin uploads → preview → activate; doctors search (English, Persian, code) and prescribe with eRx codes', async () => {
  const admin = await t.login(DEMO_ACCOUNTS.admin.phone);
  const doc = await t.login(DEMO_ACCOUNTS.doctors[0].phone);
  assert.equal((await upload(doc, XLSX)).status, 403);
  assert.equal((await upload(admin, Buffer.from('Rar!\x1a\x07\x01\x00'))).body.code, 'invalid_xlsx');

  const up = await upload(admin, XLSX);
  assert.equal(up.status, 201);
  assert.equal(up.body.status, 'staged');
  assert.equal(up.body.summary.prescribing_rows, 12);
  assert.equal(up.body.sample.length, 8);
  // Staged data is not used yet.
  assert.equal((await t.call('GET', '/v1/drug-catalog/search?q=amoxicillin', { token: doc })).body.catalog, null);
  assert.equal((await t.call('POST', `/v1/admin/drug-catalog/${up.body.id}/activate`, { token: admin, body: {} })).body.status, 'active');

  const s = (await t.call('GET', '/v1/drug-catalog/search?q=amoxicillin 500', { token: doc })).body;
  assert.equal(s.items[0].erx_code, '60100'); // generic (unbranded) row first
  assert.equal(s.items[0].safety_checked, true);
  assert.equal((await t.call('GET', `/v1/drug-catalog/search?q=${encodeURIComponent('پنتوپرازول')}`, { token: doc })).body.items[0].generic_name, 'PANTOPRAZOLE');
  assert.equal((await t.call('GET', '/v1/drug-catalog/search?q=60600', { token: doc })).body.items[0].title, 'CETIRIZINE DIHYDROCHLORIDE 10 mg TABLET ORAL');

  // Prescription with official codes; deleted code refused with its replacement.
  const p = await t.newPatient({ nationalId: randomNationalId() });
  const [slot] = (await t.call('GET', '/v1/slots?specialty=general&limit=5', { token: p.token })).body.items;
  const appt = (await t.call('POST', '/v1/appointments', { token: p.token, headers: { 'Idempotency-Key': 'cat-1' }, body: { doctor_id: slot.doctor_id, slot_id: slot.id, channel: 'chat' } })).body;
  const bad = await t.call('POST', '/v1/prescriptions', { token: doc, headers: { 'Idempotency-Key': 'c0' }, body: { consultation_id: appt.consultation.id, drugs: [{ name: 'x', erx_code: '59999' }] } });
  assert.equal(bad.body.code, 'erx_code_deleted');
  assert.match(bad.body.message, /60101/);
  const ok = await t.call('POST', '/v1/prescriptions', { token: doc, headers: { 'Idempotency-Key': 'c1' }, body: {
    consultation_id: appt.consultation.id, drugs: [{ name: 'AMOXICILLIN 500 mg CAPSULE ORAL [AFAMOX]', erx_code: '60101', frequency: 'هر ۸ ساعت' }],
  } });
  assert.equal(ok.status, 201);
  assert.equal(ok.body.drugs[0].erx_code, '60101');
  assert.equal(ok.body.drugs[0].erx_title, 'AMOXICILLIN 500 mg CAPSULE ORAL [AFAMOX]');
  const signed = await t.call('POST', `/v1/prescriptions/${ok.body.id}/sign`, { token: doc, body: {} });
  assert.equal((await t.call('GET', `/v1/prescriptions/${signed.body.id}/verify`)).body.valid, true);

  // A new version can be staged and activated; the previous one is kept for rollback.
  const up2 = await upload(admin, XLSX, 'coding-v2.xlsx');
  await t.call('POST', `/v1/admin/drug-catalog/${up2.body.id}/activate`, { token: admin, body: {} });
  let list = (await t.call('GET', '/v1/admin/drug-catalog', { token: admin })).body.items;
  assert.deepEqual(list.map((c) => c.status), ['active', 'archived']);
  await t.call('POST', `/v1/admin/drug-catalog/${up.body.id}/activate`, { token: admin, body: {} });
  list = (await t.call('GET', '/v1/admin/drug-catalog', { token: admin })).body.items;
  assert.equal(list.find((c) => c.id === up.body.id).status, 'active');
});
