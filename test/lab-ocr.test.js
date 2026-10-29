// Lab sheet photo/PDF → suggested rows for the patient to confirm.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { startApp, randomNationalId } from './helpers.js';
import { parseLabLines, textToLines, tsvToLines, createLabOcr } from '../src/modules/ai/lab-ocr.js';

const SHEET = `Patient: Ali  Age 45
1  F.B.S            105  H   mg/dl     70 - 100
2  Cholesterol      182      mg/dl     < 200
HDL-C               38   L   mg/dl     > 40
WBC                 7400     /cumm     4000-11000
25-OH Vitamin D     18       ng/ml     30-100
Note: K 4.2 checked
HbA1c               6.1  H   %         4-56
Creatinine          11       mg/dl     0.7-1.4`;

test('lab lines: names, values, units and reference ranges; notes are ignored', () => {
  const rows = parseLabLines(textToLines(SHEET));
  const by = Object.fromEntries(rows.map((r) => [r.name, r]));
  assert.deepEqual(Object.keys(by), ['F.B.S', 'Cholesterol', 'HDL-C', 'WBC', '25-OH Vitamin D', 'HbA1c', 'Creatinine']);
  assert.deepEqual([by['F.B.S'].value, by['F.B.S'].unit, by['F.B.S'].ref], ['105', 'mg/dl', '70 - 100']);
  assert.equal(by['HDL-C'].ref, '> 40');
  assert.equal(by.WBC.low_confidence, false); // per-µL counts are plausible
  // A reference range 10× off ("4-56" for 4–5.6) or a value that lost its decimal point is flagged.
  assert.equal(by.HbA1c.low_confidence, true);
  assert.equal(by.Creatinine.low_confidence, true);
  assert.ok(!rows.some((r) => /^k$/i.test(r.name)));
});

test('Tesseract TSV: words with low confidence flag the value', () => {
  const tsv = ['level\tpage_num\tblock_num\tpar_num\tline_num\tword_num\tleft\ttop\twidth\theight\tconf\ttext',
    '5\t1\t1\t1\t1\t1\t0\t0\t1\t1\t96\tTSH', '5\t1\t1\t1\t1\t2\t0\t0\t1\t1\t41\t2.85', '5\t1\t1\t1\t1\t3\t0\t0\t1\t1\t90\tmIU/L',
    '5\t1\t1\t1\t2\t1\t0\t0\t1\t1\t95\tUrea', '5\t1\t1\t1\t2\t2\t0\t0\t1\t1\t93\t28'].join('\n');
  const rows = parseLabLines(tsvToLines(tsv));
  assert.deepEqual(rows.map((r) => [r.name, r.value, r.low_confidence]), [['TSH', '2.85', true], ['Urea', '28', false]]);
});

const ocr = createLabOcr();
test('real OCR on a phone-style photo of a lab sheet (skipped without tesseract)', async (t) => {
  if (!(await ocr.isAvailable())) return t.skip('tesseract not installed');
  const { rows } = await ocr.extract([{ mime: 'image/jpeg', data: readFileSync(new URL('./fixtures/lab-sheet-photo.jpg', import.meta.url)) }]);
  const v = Object.fromEntries(rows.map((r) => [r.name.toLowerCase(), r.value]));
  assert.equal(v['fasting blood sugar'], '112');
  assert.equal(v.creatinine, '1.1');
  assert.equal(v['25-oh vitamin d'], '17.5');
  assert.equal(v.tsh, '2.85');
  assert.ok(rows.length >= 10);
});

let app;
before(async () => { app = await startApp({ disableSweeper: true }); });
after(() => app.close());

test('POST /v1/records/ocr: own medical-record files only; rows come back for confirmation', async () => {
  app.app.domain.labOcr = { isAvailable: async () => true, extract: async (files) => ({ engine: 'stub', version: 't', rows: [{ name: 'FBS', value: '112', unit: 'mg/dl', ref: '70 - 100', low_confidence: false, line: 'secret line' }], n: files.length }) };
  const p = await app.newPatient({ nationalId: randomNationalId() });
  const other = await app.newPatient({ nationalId: randomNationalId() });
  const up = async (token) => (await (await fetch(`${app.base}/v1/files?purpose=medical_record`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'image/jpeg' }, body: readFileSync(new URL('./fixtures/lab-sheet-photo.jpg', import.meta.url)) })).json()).id;
  const mine = await up(p.token);
  const theirs = await up(other.token);
  assert.equal((await app.call('POST', '/v1/records/ocr', { token: p.token, body: { file_ids: [theirs] } })).body.code, 'invalid_file');
  const r = await app.call('POST', '/v1/records/ocr', { token: p.token, body: { file_ids: [mine] } });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.rows, [{ name: 'FBS', value: '112', unit: 'mg/dl', ref: '70 - 100', low_confidence: false }]);
  // Confirmed rows keep their "read from photo" mark for the doctor.
  const rec = await app.call('POST', '/v1/records', { token: p.token, body: { category: 'lab', title: 'آزمایش', file_ids: [mine], lab_rows: [{ ...r.body.rows[0], ocr: true }] } });
  assert.equal(rec.body.lab_rows[0].ocr, true);
  app.app.domain.labOcr = { isAvailable: async () => false };
  assert.equal((await app.call('POST', '/v1/records/ocr', { token: p.token, body: { file_ids: [mine] } })).body.code, 'ocr_unavailable');
});
