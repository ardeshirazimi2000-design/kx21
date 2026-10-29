// Public website pages for search engines: doctor pages exist only for approved, bookable doctors who
// opted in and never show private data; legal pages are server-rendered; static files are cached and
// compressed; the sitemap lists only what is public.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp } from './helpers.js';
import { DEMO_ACCOUNTS } from '../src/seed.js';

let t, doc;
before(async () => {
  t = await startApp({ disableSweeper: true, publicBaseUrl: 'https://darman-plus.ir' });
  doc = await t.login(DEMO_ACCOUNTS.doctors[0].phone);
});
after(() => t.close());

const page = (path, headers = {}) => fetch(t.base + path, { headers, redirect: 'manual' }).then(async (r) => ({ status: r.status, html: await r.text(), headers: r.headers }));

test('doctor pages need the doctor\'s explicit consent and show no private data', async () => {
  // Nothing is public by default.
  let list = await page('/doctors');
  assert.equal(list.status, 200);
  assert.match(list.html, /noindex/);
  assert.doesNotMatch(list.html, /سارا احمدی/);
  assert.doesNotMatch((await page('/sitemap.xml')).html, /\/doctors\//);

  assert.equal((await t.call('PUT', '/v1/doctors/me/public-profile', { token: doc, body: {} })).status, 422);
  const on = await t.call('PUT', '/v1/doctors/me/public-profile', { token: doc, body: { enabled: true, show_license: false } });
  assert.equal(on.status, 200);
  assert.equal(on.body.public_profile, true);
  const url = on.body.public_url;
  assert.match(url, /^\/doctors\//);

  const p = await page(url);
  assert.equal(p.status, 200);
  assert.match(p.html, /<h1>دکتر سارا احمدی<\/h1>/);
  assert.match(p.html, /"@type":"Physician"/);
  assert.ok(p.html.includes(`<link rel="canonical" href="https://darman-plus.ir${url}">`));
  assert.doesNotMatch(p.html, /09120000001|N-100201/); // no phone; licence hidden unless chosen
  assert.doesNotMatch(p.html, /sheba|IR\d{24}/i);
  list = await page('/doctors');
  assert.doesNotMatch(list.html, /noindex/);
  assert.ok(list.html.includes(url));
  const spec = await page('/specialties/general');
  assert.equal(spec.status, 200);
  assert.ok(spec.html.includes(url));
  const sm = (await page('/sitemap.xml')).html;
  assert.ok(sm.includes(`https://darman-plus.ir${url}`));
  assert.ok(sm.includes('https://darman-plus.ir/specialties/general'));
  assert.doesNotMatch(sm, /specialties\/cardiology/); // no public doctor there yet
  assert.match((await page('/specialties/cardiology')).html, /noindex/);

  // The licence number appears only when the doctor chooses it.
  await t.call('PUT', '/v1/doctors/me/public-profile', { token: doc, body: { enabled: true, show_license: true } });
  assert.match((await page(url)).html, /N-100201/);

  // Turning it off removes the page at once.
  const off = await t.call('PUT', '/v1/doctors/me/public-profile', { token: doc, body: { enabled: false } });
  assert.equal(off.body.public_url, null);
  assert.equal((await page(url)).status, 404);
  assert.equal((await page(`${url}/photo`)).status, 404);
});

test('a doctor who is not yet approved cannot publish a page', async () => {
  const fresh = await t.login('09129998877', { role: 'doctor' });
  const r = await t.call('PUT', '/v1/doctors/me/public-profile', { token: fresh, body: { enabled: true } });
  assert.equal(r.status, 409);
  assert.equal(r.body.code, 'doctor_not_bookable');
});

test('legal pages are server-rendered with canonical links', async () => {
  const idx = await page('/legal');
  assert.equal(idx.status, 200);
  assert.ok(idx.html.includes('<link rel="canonical" href="https://darman-plus.ir/legal">'));
  const first = idx.html.match(/href="(\/legal\/[^"]+)"/)[1];
  const d = await page(first);
  assert.equal(d.status, 200);
  assert.equal((d.html.match(/<h1/g) ?? []).length, 1);
  assert.equal((await page('/legal/nope')).status, 404);
  assert.ok((await page('/sitemap.xml')).html.includes(`https://darman-plus.ir${first}`));
  assert.match((await page('/specialties')).html, /تخصص/);
});

test('static files: ETag revalidation, gzip, long cache for assets, favicon, crawlable home', async () => {
  const home = await page('/', { 'Accept-Encoding': 'gzip' });
  assert.equal(home.headers.get('content-encoding'), 'gzip');
  assert.match(home.html, /<a href="\/mag">/);
  assert.match(home.html, /application\/ld\+json/);
  const etag = home.headers.get('etag');
  assert.ok(etag);
  assert.equal((await page('/', { 'If-None-Match': etag })).status, 304);
  const fav = await page('/favicon.ico');
  assert.equal(fav.status, 200);
  assert.equal(fav.headers.get('content-type'), 'image/x-icon');
  const og = await page('/mag-assets/og-default.png');
  assert.equal(og.status, 200);
  assert.match(og.headers.get('cache-control'), /max-age=604800/);
  assert.match((await page('/app.js')).headers.get('cache-control'), /no-cache/);
});

test('services page shows the tariffs set by the admin, in toman; about page and Enamad seal', async () => {
  const admin = await t.login(DEMO_ACCOUNTS.admin.phone);
  await t.call('PUT', '/v1/admin/settings', { token: admin, body: { tariffs: { visit_video: 1_500_000, visit_audio: 1_200_000, visit_chat: 800_000, triage: 0 } } });
  const s = await page('/services');
  assert.equal(s.status, 200);
  assert.match(s.html, /<h1 class="mg-h1">خدمات و تعرفه‌های درمان پلاس<\/h1>/);
  assert.match(s.html, /ویزیت تصویری<\/b>.*?۱۵۰٬۰۰۰ تومان/s);
  assert.match(s.html, /ویزیت متنی<\/b>.*?۸۰٬۰۰۰ تومان/s);
  assert.match(s.html, /رایگان/); // triage tariff 0
  assert.match(s.html, /"@type":"OfferCatalog"/);
  assert.match(s.html, /trustseal\.enamad\.ir\/logo\.aspx\?id=8314749/);
  assert.match(s.html, /referrerpolicy="origin"/);
  assert.match(s.headers.get('content-security-policy'), /img-src[^;]*https:\/\/trustseal\.enamad\.ir/);
  // A new tariff shows at once.
  await t.call('PUT', '/v1/admin/settings', { token: admin, body: { tariffs: { visit_video: 2_000_000 } } });
  assert.match((await page('/services')).html, /۲۰۰٬۰۰۰ تومان/);
  const a = await page('/about');
  assert.equal(a.status, 200);
  assert.match(a.html, /info@darman-plus\.ir/);
  assert.match(a.html, /trustseal\.enamad\.ir/);
  const sm = (await page('/sitemap.xml')).html;
  assert.ok(sm.includes('https://darman-plus.ir/services') && sm.includes('https://darman-plus.ir/about'));
  assert.match((await page('/')).html, /href="\/services"/);
});
