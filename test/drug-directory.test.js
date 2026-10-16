// External Iranian drug directory (reference only): tolerant parsing, caching, URL validation.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { startApp } from './helpers.js';
import { DEMO_ACCOUNTS } from '../src/seed.js';
import { extractItems, normalizeSearchItem, normalizeInfo } from '../src/modules/rx/drug-directory.js';

test('search results are found in different envelopes; links must be darooyab.ir', () => {
  const a = { status: 200, result: [{ title: 'استامینوفن', en: 'Acetaminophen', url: 'https://www.darooyab.ir/G-1/Acetaminophen' }] };
  const b = { data: { items: [{ name: 'Acetaminophen-Codeine', link: 'https://www.darooyab.ir/G-2/x' }, { name: 'bad', link: 'https://evil.example/x' }] } };
  assert.deepEqual(extractItems(a).map(normalizeSearchItem)[0], { title: 'استامینوفن', title_en: 'Acetaminophen', subtitle: null, url: 'https://www.darooyab.ir/G-1/Acetaminophen' });
  const items = extractItems(b).map(normalizeSearchItem);
  assert.equal(items[0].url, 'https://www.darooyab.ir/G-2/x');
  assert.equal(items[1].url, null);
});

test('monograph sections from keyed objects or title/content lists; HTML stripped; meta dropped', () => {
  const s1 = normalizeInfo({ status: 200, dev: 'x', result: { title: 'استامینوفن', usage: '<p>تب و درد</p>', side_effects: 'تهوع<br>بثورات', interactions: 'وارفارین', image: 'https://x/y.png' } });
  assert.deepEqual(s1.map((x) => x.label), ['نام', 'موارد مصرف', 'عوارض جانبی', 'تداخلات دارویی']);
  assert.equal(s1[2].text, 'تهوع\nبثورات');
  const s2 = normalizeInfo({ ok: true, result: { sections: [{ title: 'مقدار مصرف', content: '۵۰۰ میلی‌گرم' }, { title: 'هشدار', content: 'کبد' }] } });
  assert.deepEqual(s2.map((x) => [x.label, x.text]), [['مقدار مصرف', '۵۰۰ میلی‌گرم'], ['هشدار', 'کبد']]);
});

let api;
let calls = [];
let t;
before(async () => {
  api = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    calls.push(`${u.pathname}?${u.searchParams.toString()}`);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    if (u.pathname.endsWith('/search')) {
      res.end(JSON.stringify({ status: 200, result: [
        { title: 'استامینوفن', en: 'Acetaminophen', url: 'https://www.darooyab.ir/G-1/Acetaminophen' },
        { title: 'استامینوفن دیفن هیدرامین', url: 'https://www.darooyab.ir/G-947/Acetaminophen-Diphenhydramine' },
      ] }));
    } else {
      res.end(JSON.stringify({ status: 200, result: { title: 'استامینوفن', usage: 'تب و درد خفیف تا متوسط', interactions: 'وارفارین (مصرف طولانی)' } }));
    }
  }).listen(0, '127.0.0.1');
  await new Promise((r) => api.once('listening', r));
  t = await startApp({ disableSweeper: true, drugApiBase: `http://127.0.0.1:${api.address().port}/darooyab`, drugApiToken: 'tkn' });
});
after(() => { t.close(); api.close(); });

test('doctor searches the directory (cached), opens a monograph; only darooyab links; patients refused', async () => {
  const doc = await t.login(DEMO_ACCOUNTS.doctors[0].phone);
  const r = await t.call('GET', `/v1/drugs?q=${encodeURIComponent('استامینوفن')}`, { token: doc });
  assert.equal(r.body.directory, true);
  assert.equal(r.body.directory_items.length, 2);
  assert.equal(r.body.directory_items[0].safety_checked, true); // known to the local safety KB
  assert.equal(r.body.directory_items[1].safety_checked, true);
  assert.match(calls[0], /search=.*&token=tkn/);
  await t.call('GET', `/v1/drugs?q=${encodeURIComponent('استامینوفن')}`, { token: doc });
  assert.equal(calls.length, 1); // served from cache

  const info = await t.call('GET', `/v1/drugs/info?url=${encodeURIComponent('https://www.darooyab.ir/G-1/Acetaminophen')}`, { token: doc });
  assert.deepEqual(info.body.sections.map((s) => s.label), ['نام', 'موارد مصرف', 'تداخلات دارویی']);
  assert.match(info.body.disclaimer, /بررسی ایمنی خودکار استفاده نمی‌شود/);
  assert.equal((await t.call('GET', `/v1/drugs/info?url=${encodeURIComponent('http://169.254.169.254/latest')}`, { token: doc })).status, 422);
  const p = await t.newPatient();
  assert.equal((await t.call('GET', '/v1/drugs?q=abc', { token: p.token })).status, 403);
});
