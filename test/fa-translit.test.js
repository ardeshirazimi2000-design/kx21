// Persian drug names → English generic names by sound (for searching the official English catalogue).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { matchPersian, buildIndex, faSkeleton, enSkeleton } from '../src/modules/rx/fa-translit.js';

const GENERICS = ['METFORMIN HYDROCHLORIDE', 'METFORMIN HYDROCHLORIDE / PIOGLITAZONE', 'LOSARTAN POTASSIUM', 'VALSARTAN', 'ATORVASTATIN',
  'LEVOTHYROXINE SODIUM', 'AMOXICILLIN', 'AMIKACIN', 'DEXAMETHASONE', 'SALBUTAMOL', 'CITALOPRAM', 'ESCITALOPRAM', 'GENTAMICIN',
  'CO-TRIMOXAZOLE', 'GLIBENCLAMIDE', 'ONDANSETRON', 'SPIRONOLACTONE', 'CEFIXIME', 'CEFALEXIN', 'OMEPRAZOLE'];
const idx = buildIndex(GENERICS);
const top = (q) => matchPersian(q, idx)[0];

test('skeletons agree for typical spellings', () => {
  assert.equal(faSkeleton('متفورمین'), enSkeleton('METFORMIN'));
  assert.equal(faSkeleton('دگزامتازون'), enSkeleton('DEXAMETHASONE'));
  assert.equal(faSkeleton('آموکسی سیلین'), enSkeleton('AMOXICILLIN'));
});

test('Persian names find the right generic (و as v or vowel, گز = x, spaces, partial typing)', () => {
  assert.equal(top('متفورمین'), 'METFORMIN HYDROCHLORIDE');
  assert.equal(top('متفور'), 'METFORMIN HYDROCHLORIDE');
  assert.equal(top('لوزارتان'), 'LOSARTAN POTASSIUM');
  assert.equal(top('والسارتان'), 'VALSARTAN');
  assert.equal(top('آتورواستاتین'), 'ATORVASTATIN');
  assert.equal(top('لووتیروکسین'), 'LEVOTHYROXINE SODIUM');
  assert.equal(top('آموکسی سیلین'), 'AMOXICILLIN');
  assert.equal(top('دگزامتازون'), 'DEXAMETHASONE');
  assert.equal(top('سیتالوپرام'), 'CITALOPRAM');
  assert.equal(top('جنتامایسین'), 'GENTAMICIN');
  assert.equal(top('کوتریموکسازول'), 'CO-TRIMOXAZOLE');
  assert.equal(top('گلی بن کلامید'), 'GLIBENCLAMIDE');
  assert.equal(top('سفکسیم'), 'CEFIXIME');
  assert.deepEqual(matchPersian('اب', idx), []); // too short to match safely
});
