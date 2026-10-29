// Health magazine: drafts never go live without a doctor's review; published articles are full
// server-rendered pages with SEO tags; edits to a live article wait for a new review; robots.txt,
// sitemap.xml and real 404s; no patient data ever reaches these pages.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, randomNationalId } from './helpers.js';
import { DEMO_ACCOUNTS } from '../src/seed.js';
import { renderMarkdown } from '../src/lib/markdown.js';
import { MAG_DRAFTS } from '../src/content/mag-drafts.js';

let t, admin, doc, docId;
before(async () => {
  t = await startApp({ disableSweeper: true, publicBaseUrl: 'https://darman-plus.ir' });
  admin = await t.login(DEMO_ACCOUNTS.admin.phone);
  doc = await t.login(DEMO_ACCOUNTS.doctors[0].phone);
  docId = (await t.call('GET', '/v1/auth/me', { token: doc })).body.doctor_id;
});
after(() => t.close());

const page = (path, headers = {}) => fetch(t.base + path, { headers, redirect: 'manual' }).then(async (r) => ({ status: r.status, html: await r.text(), headers: r.headers }));

test('launch drafts are stored as drafts only and the magazine shows nothing unreviewed', async () => {
  const list = await t.call('GET', '/v1/admin/mag/articles', { token: admin });
  assert.equal(list.status, 200);
  assert.equal(list.body.items.length, MAG_DRAFTS.length);
  assert.ok(list.body.items.every((a) => a.status === 'draft'));
  const home = await page('/mag');
  assert.equal(home.status, 200);
  assert.match(home.html, /به‌زودی منتشر می‌شوند/);
  for (const d of MAG_DRAFTS.slice(0, 2)) assert.equal((await page(`/mag/${encodeURIComponent(d.slug)}`)).status, 404);
  const sm = await page('/sitemap.xml');
  assert.doesNotMatch(sm.html, /\/mag\/[^<c]/);
  // Publishing without review is refused.
  const a = list.body.items[0];
  assert.equal((await t.call('POST', `/v1/admin/mag/articles/${a.id}/publish`, { token: admin })).body.code, 'not_reviewed');
});

test('write → doctor review → publish; page carries title, canonical, structured data and reviewer', async () => {
  const body = `## مقدمه\n\nمتن **مهم** با [پیوند](/mag) و <script>alert(1)</script>.\n\n## نکته دوم\n\n- یک\n- دو\n\n## نکته سوم\n\n> به پزشک مراجعه کنید.\n\n${'توضیح بیشتر برای طول متن. '.repeat(10)}`;
  const c = await t.call('POST', '/v1/admin/mag/articles', { token: admin, body: { title: 'آزمون <b>مقاله</b> سلامت', category: 'prevention', summary: 'خلاصه آزمون', body, seo_description: 'توضیح متای آزمون' } });
  assert.equal(c.status, 201);
  const id = c.body.id;
  assert.equal(c.body.status, 'draft');
  // Only an approved doctor can review; the doctor sees it in the queue.
  assert.equal((await t.call('POST', `/v1/admin/mag/articles/${id}/submit`, { token: admin, body: { reviewer_doctor_id: t.uuid() } })).status, 422);
  assert.equal((await t.call('POST', `/v1/admin/mag/articles/${id}/submit`, { token: admin, body: { reviewer_doctor_id: docId } })).body.status, 'review');
  const q = await t.call('GET', '/v1/doctors/me/mag-reviews', { token: doc });
  assert.ok(q.body.waiting.some((a) => a.id === id));
  // Another doctor cannot review it.
  const other = await t.login(DEMO_ACCOUNTS.doctors[1].phone);
  assert.equal((await t.call('POST', `/v1/doctors/me/mag-reviews/${id}`, { token: other, body: { approve: true } })).status, 404);
  // Rejecting needs a reason; then the author fixes and resubmits.
  assert.equal((await t.call('POST', `/v1/doctors/me/mag-reviews/${id}`, { token: doc, body: { approve: false } })).status, 422);
  assert.equal((await t.call('POST', `/v1/doctors/me/mag-reviews/${id}`, { token: doc, body: { approve: false, note: 'منبع بند دوم را اضافه کنید' } })).body.status, 'draft');
  await t.call('POST', `/v1/admin/mag/articles/${id}/submit`, { token: admin, body: { reviewer_doctor_id: docId } });
  const ok = await t.call('POST', `/v1/doctors/me/mag-reviews/${id}`, { token: doc, body: { approve: true, note: '' } });
  assert.equal(ok.body.status, 'approved');
  const pub = await t.call('POST', `/v1/admin/mag/articles/${id}/publish`, { token: admin });
  assert.equal(pub.body.status, 'published');

  const slug = pub.body.slug;
  const p = await page(`/mag/${encodeURIComponent(slug)}`);
  assert.equal(p.status, 200);
  assert.match(p.html, /<title>آزمون &lt;b&gt;مقاله&lt;\/b&gt; سلامت \| مجله سلامت درمان پلاس<\/title>/);
  assert.match(p.html, /<meta name="description" content="توضیح متای آزمون">/);
  assert.ok(p.html.includes(`<link rel="canonical" href="https://darman-plus.ir/mag/${encodeURIComponent(slug)}">`));
  assert.match(p.html, /<h1>آزمون &lt;b&gt;مقاله&lt;\/b&gt; سلامت<\/h1>/);
  assert.equal((p.html.match(/<h1/g) ?? []).length, 1);
  assert.doesNotMatch(p.html, /<script>alert/); // body HTML is escaped
  assert.match(p.html, /<strong>مهم<\/strong>/);
  assert.match(p.html, /"@type":"MedicalWebPage"/);
  assert.match(p.html, /"reviewedBy":\{"@type":"Physician"/);
  assert.match(p.html, /بازبینی پزشکی: <b>/);
  assert.match(p.html, /آنچه در این مقاله می‌خوانید/); // table of contents for 3+ sections
  // Listed on the home, its category, the sitemap; counted once per (non-bot) view.
  assert.ok((await page('/mag')).html.includes(encodeURIComponent(slug)));
  assert.match((await page('/mag/c/prevention')).html, /آزمون/);
  assert.ok((await page('/sitemap.xml')).html.includes(`https://darman-plus.ir/mag/${encodeURIComponent(slug)}`));
  await page(`/mag/${encodeURIComponent(slug)}`, { 'User-Agent': 'Googlebot/2.1' });
  const v = await t.call('GET', `/v1/admin/mag/articles/${id}`, { token: admin });
  assert.equal(v.body.views, 1);

  // Editing the text of a live article: the reviewed text stays online until a new review.
  const e = await t.call('PUT', `/v1/admin/mag/articles/${id}`, { token: admin, body: { body: `${body}\n\nجمله تازه بدون بازبینی.` } });
  assert.equal(e.body.status, 'published');
  assert.equal(e.body.pending_state, 'draft');
  assert.doesNotMatch((await page(`/mag/${encodeURIComponent(slug)}`)).html, /جمله تازه/);
  assert.equal((await t.call('POST', `/v1/admin/mag/articles/${id}/publish`, { token: admin })).body.code, 'not_reviewed');
  await t.call('POST', `/v1/admin/mag/articles/${id}/submit`, { token: admin, body: { reviewer_doctor_id: docId } });
  await t.call('POST', `/v1/doctors/me/mag-reviews/${id}`, { token: doc, body: { approve: true } });
  await t.call('POST', `/v1/admin/mag/articles/${id}/publish`, { token: admin });
  assert.match((await page(`/mag/${encodeURIComponent(slug)}`)).html, /جمله تازه/);
  // SEO fields change live, without review.
  await t.call('PUT', `/v1/admin/mag/articles/${id}`, { token: admin, body: { seo_title: 'عنوان سئوی تازه' } });
  assert.match((await page(`/mag/${encodeURIComponent(slug)}`)).html, /<title>عنوان سئوی تازه/);

  // Restoring an older version goes through review again; unpublishing gives 410 Gone.
  const revs = (await t.call('GET', `/v1/admin/mag/articles/${id}`, { token: admin })).body.revisions;
  const first = revs.at(-1);
  const r = await t.call('POST', `/v1/admin/mag/articles/${id}/restore`, { token: admin, body: { revision_id: first.id } });
  assert.equal(r.body.pending_state, 'draft');
  assert.equal((await t.call('POST', `/v1/admin/mag/articles/${id}/unpublish`, { token: admin })).body.status, 'archived');
  assert.equal((await page(`/mag/${encodeURIComponent(slug)}`)).status, 410);
});

test('only staff with magazine rights manage articles; previews need a valid signature', async () => {
  const p = await t.newPatient({ nationalId: randomNationalId() });
  assert.equal((await t.call('GET', '/v1/admin/mag/articles', { token: p.token })).status, 403);
  assert.equal((await t.call('POST', '/v1/admin/mag/articles', { token: doc, body: { title: 'عنوان آزمایشی', category: 'men' } })).status, 403);
  assert.equal((await t.call('GET', '/v1/doctors/me/mag-reviews', { token: p.token })).status, 403);
  const list = (await t.call('GET', '/v1/admin/mag/articles', { token: admin })).body.items;
  const a = await t.call('GET', `/v1/admin/mag/articles/${list[0].id}`, { token: admin });
  const prev = await page(a.body.preview_url);
  assert.equal(prev.status, 200);
  assert.match(prev.html, /noindex,nofollow/);
  assert.match(prev.html, /پیش‌نمایش/);
  assert.equal((await page(a.body.preview_url.replace(/sig=[^&]+/, 'sig=AAAA'))).status, 404);
});

test('robots.txt, real 404s, search is noindex, newsletter validates', async () => {
  const r = await page('/robots.txt');
  assert.match(r.html, /Disallow: \/v1\//);
  assert.match(r.html, /Sitemap: https:\/\/darman-plus\.ir\/sitemap\.xml/);
  const nf = await page('/some/unknown/path');
  assert.equal(nf.status, 404);
  assert.match(nf.html, /noindex/);
  assert.equal((await page('/')).status, 200); // the app itself
  assert.equal((await page('/mag/c/unknown')).status, 404);
  assert.match((await page('/mag/search?q=فشار')).html, /noindex,follow/);
  assert.equal((await page('/mag/')).status, 301);

  const sub = (contact) => fetch(`${t.base}/mag/subscribe`, { method: 'POST', redirect: 'manual', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ contact }) });
  assert.match((await sub('not-valid')).headers.get('location'), /subscribe=bad/);
  assert.match((await sub('reader@example.com')).headers.get('location'), /subscribed=1/);
  assert.match((await sub('09121112233')).headers.get('location'), /subscribed=1/);
  assert.equal((await t.call('GET', '/v1/admin/mag/meta', { token: admin })).body.subscribers, 2);
});

test('markdown renderer escapes HTML and only allows safe links', () => {
  const { html, headings } = renderMarkdown('## سرفصل\n\nمتن <img src=x onerror=alert(1)> و [بد](javascript:alert(1)) و [خوب](https://example.com)');
  assert.doesNotMatch(html, /<img/);
  assert.doesNotMatch(html, /javascript:/);
  assert.match(html, /href="https:\/\/example\.com" rel="noopener nofollow"/);
  assert.equal(headings[0].text, 'سرفصل');
});
