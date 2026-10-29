// Public pages rendered on the server (full HTML for readers and search engines): the health
// magazine, doctors who chose to have a public page, specialties, legal documents, robots.txt and
// sitemap.xml. Only published articles and consenting, approved doctors are ever shown; nothing here
// touches patient, visit or payment data.
import crypto from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { renderMarkdown, readingMinutes, esc } from '../lib/markdown.js';
import { normalizePhone } from '../lib/fa.js';
import { uuid, nowIso, parseJson } from '../lib/db.js';
import { COMPANY, legalDoc, legalIndex, LEGAL_UPDATED } from '../lib/legal.js';
import { DOCTOR_BOOKABLE_SQL } from '../lib/contract-text.js';
import { getVisitSettings } from '../lib/visit-settings.js';
import { SPECIALTIES } from './patient.js';
import { MAG_CATEGORIES } from './magazine.js';

// Short introductions for the category pages (shown under the heading and used as their description).
const CATEGORY_INTRO = {
  nutrition: 'آنچه می‌خوریم بر قلب، کبد، قند خون و وزن اثر مستقیم دارد. در این بخش، نکات علمی و کاربردی تغذیه سالم را برای همه سنین می‌خوانید.',
  fitness: 'فعالیت بدنی منظم از مؤثرترین راه‌های پیشگیری از بیماری‌های قلب، دیابت و افسردگی است. مقالات این بخش به شروع امن و ادامه ورزش کمک می‌کنند.',
  mental: 'خواب، استرس، اضطراب و خلق‌وخو بخش جدانشدنی سلامت‌اند. در این بخش، راهکارهای ساده و علمی برای مراقبت از سلامت روان را می‌خوانید.',
  prevention: 'بسیاری از بیماری‌ها با غربالگری به‌موقع و سبک زندگی سالم قابل پیشگیری‌اند. این بخش درباره فشار خون، واکسن‌ها، معاینات دوره‌ای و ایمنی است.',
  diseases: 'آشنایی با علائم، علت‌ها و مسیر درمان بیماری‌های شایع، به تصمیم بهتر و مراجعه به‌موقع به پزشک کمک می‌کند.',
  women: 'سلامت زنان در مراحل مختلف زندگی، بارداری، شیردهی و مراقبت از خانواده؛ مطالبی که با بازبینی پزشک منتشر می‌شوند.',
  men: 'سلامت پروستات، قلب، سلامت جنسی و غربالگری‌های مهم مردان در سنین مختلف.',
};

const PAGE_SIZE = 12;
const BOT_UA = /bot|crawl|spider|slurp|preview|facebookexternalhit|curl|wget|lighthouse/i;
const IMG_KEY = /^[0-9a-f-]{36}\.(jpg|png|webp)$/;
const IMG_MIME = { jpg: 'image/jpeg', png: 'image/png', webp: 'image/webp' };
const faDate = (iso) => (iso ? new Intl.DateTimeFormat('fa-IR-u-ca-persian', { year: 'numeric', month: 'long', day: 'numeric' }).format(new Date(iso)) : '');
const faNum = (n) => Number(n).toLocaleString('fa-IR');
const json = (o) => JSON.stringify(o).replace(/</g, '\\u003c');

const ICON = {
  all: '<circle cx="11" cy="11" r="6.5"/><path d="m20 20-4.2-4.2"/>',
  nutrition: '<path d="M12 7c-3-2-7-.5-7 4 0 4.5 3 9 5 9 1 0 1.5-.5 2-.5s1 .5 2 .5c2 0 5-4.5 5-9 0-4.5-4-6-7-4z"/><path d="M12 7c0-2 1-3.5 3-4"/>',
  fitness: '<path d="M6.5 6.5v11M17.5 6.5v11M3.5 9v6M20.5 9v6M6.5 12h11"/>',
  mental: '<path d="M9 21v-3.5a6.5 6.5 0 1 1 7.6-6.4l1.4 3.4h-2V18a3 3 0 0 1-3 3"/><path d="M9.5 9.5a2 2 0 1 1 3 1.7V12"/>',
  prevention: '<path d="M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z"/><path d="M12 9v6M9 12h6"/>',
  diseases: '<path d="M7 3h10M9 3v5.5L4.5 17A2.5 2.5 0 0 0 6.7 21h10.6a2.5 2.5 0 0 0 2.2-4L15 8.5V3"/><path d="M7 14h10"/>',
  women: '<circle cx="12" cy="9" r="5"/><path d="M12 14v7M9 18h6"/>',
  men: '<circle cx="10" cy="14" r="5"/><path d="M14 10l6-6M15 4h5v5"/>',
  doc: '<path d="M6 3h8.5L19 7.5V21H6z"/><path d="M14 3v5h5M9 12h7M9 16h7"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  cal: '<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 10h18M8 3v4M16 3v4"/>',
  shield: '<path d="M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z"/><path d="m8.5 12 2.5 2.5 4.5-5"/>',
  doctor: '<circle cx="12" cy="7" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/><path d="M9 15v3M15 15v2a1.5 1.5 0 0 0 3 0"/>',
  chat: '<path d="M4 5h16v11H9l-5 4z"/><path d="M8 10h8"/>',
  support: '<path d="M4 14v-2a8 8 0 0 1 16 0v2"/><rect x="3" y="13" width="4" height="6" rx="1.5"/><rect x="17" y="13" width="4" height="6" rx="1.5"/>',
  fire: '<path d="M12 21c-4 0-7-2.6-7-6.5 0-3.3 2.3-5.4 4-7.5.4 1.8 1.5 3 3 3.5-.4-3 .9-5.7 3-7.5.3 3 4 5.4 4 10.5 0 4-3 7.5-7 7.5z"/>',
  mail: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="m4 7 8 6 8-6"/>',
  home: '<path d="M3 10.5 12 3l9 7.5V20a1 1 0 0 1-1 1h-5v-6h-6v6H4a1 1 0 0 1-1-1z"/>',
  book: '<path d="M3 5.5C5.5 4 8.5 4 12 6c3.5-2 6.5-2 9-.5V19c-2.5-1.5-5.5-1.5-9 .5-3.5-2-6.5-2-9-.5z"/><path d="M12 6v13.5"/>',
  arrow: '<path d="M15 6l-6 6 6 6"/>',
};
const svg = (name, size = 22) => `<svg class="ic" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICON[name] ?? ''}</svg>`;

export function createMagazinePages({ db, config, domain, limiter }) {
  const siteBase = (req) => config.publicBaseUrl || `https://${req.headers['x-forwarded-host'] ?? req.headers.host ?? COMPANY.site}`;
  const tenantOf = () => config.defaultTenant;
  const cover = (a) => domain.magazine.imageUrl(a.cover_image_id) ?? `/mag-assets/cat-${a.category}.svg`;
  // Social networks and search results need a raster image (SVG is not shown in link previews).
  const shareImage = (a) => domain.magazine.imageUrl(a.cover_image_id) ?? `/mag-assets/cat-${a.category}.png`;
  const published = (tenantId, where = '', ...args) => db.all(
    `SELECT * FROM mag_articles WHERE tenant_id = ? AND status = 'published' ${where}`, tenantId, ...args);

  function send(req, res, status, html, headers = {}, type = 'text/html; charset=utf-8') {
    let body = Buffer.from(html);
    const gz = body.length > 1024 && /\bgzip\b/.test(String(req.headers['accept-encoding'] ?? ''));
    if (gz) body = gzipSync(body);
    res.writeHead(status, { 'Content-Type': type, 'Content-Length': body.length, 'Cache-Control': 'public, max-age=300', Vary: 'Accept-Encoding', ...(gz ? { 'Content-Encoding': 'gzip' } : {}), ...headers });
    res.end(req.method === 'HEAD' ? undefined : body);
    return true;
  }

  function layout(req, { title, description, path, robots = 'index,follow', jsonld = [], ogType = 'website', image = null, body, nav = 'mag' }) {
    const base = siteBase(req);
    const canonical = `${base}${path}`;
    const img = image ? (image.startsWith('http') ? image : `${base}${image}`) : `${base}/mag-assets/og-default.png`;
    return `<!doctype html>
<html lang="fa" dir="rtl">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<meta name="description" content="${esc(description)}">
<meta name="robots" content="${robots}">
<link rel="canonical" href="${esc(canonical)}">
<meta property="og:type" content="${ogType}">
<meta property="og:locale" content="fa_IR">
<meta property="og:site_name" content="${esc(COMPANY.brand)}">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(description)}">
<meta property="og:url" content="${esc(canonical)}">
<meta property="og:image" content="${esc(img)}">
<meta name="twitter:card" content="summary_large_image">
<meta name="theme-color" content="#0B3D91">
<link rel="icon" href="/icon.svg" type="image/svg+xml">
<link rel="stylesheet" href="/fonts/vazirmatn.css">
<link rel="stylesheet" href="/magazine.css">
${jsonld.map((j) => `<script type="application/ld+json">${json(j)}</script>`).join('\n')}
</head>
<body>
<a class="mg-skip" href="#main">رفتن به محتوای اصلی</a>
${header(req, nav)}
<main id="main" class="mg-wrap">${body}</main>
${footer()}
</body>
</html>`;
  }

  function header(req, active) {
    const q = new URL(req.url, 'http://x').searchParams.get('q') ?? '';
    return `<header class="mg-top">
<div class="mg-wrap mg-top-in">
<a class="mg-brand" href="/mag" aria-label="مجله سلامت درمان پلاس"><img src="/brand/mark.svg" alt="" width="44" height="44"><span><b>درمان پلاس</b><small>سلامت شما، اولویت ماست</small></span></a>
<form class="mg-search" action="/mag/search" method="get" role="search"><input type="search" name="q" value="${esc(q)}" placeholder="جستجوی مقاله، بیماری یا موضوع سلامت…" aria-label="جستجو در مجله" maxlength="80"><button type="submit" aria-label="جستجو">${svg('all', 20)}</button></form>
<a class="mg-login" href="/">${svg('doctor', 18)}<span>ورود / ثبت‌نام</span></a>
</div>
<nav class="mg-nav" aria-label="پیوندهای اصلی"><div class="mg-wrap">
<a href="/">${svg('home', 18)}خانه</a>
<a href="/doctors"${active === 'doctors' ? ' aria-current="page"' : ''}>${svg('doctor', 18)}پزشکان و مشاوره آنلاین</a>
<a href="/mag"${active === 'mag' ? ' aria-current="page"' : ''}>${svg('book', 18)}مجله سلامت</a>
<a href="/legal"${active === 'legal' ? ' aria-current="page"' : ''}>${svg('shield', 18)}قوانین و حریم خصوصی</a>
</div></nav>
</header>`;
  }

  function footer() {
    return `<footer class="mg-foot"><div class="mg-wrap mg-foot-in">
<a class="mg-brand" href="/mag"><img src="/brand/mark.svg" alt="" width="36" height="36"><span><b>درمان پلاس</b><small>سلامت شما، اولویت ماست</small></span></a>
<nav aria-label="پیوندهای پایین صفحه"><a href="/">خانه</a><a href="/doctors">پزشکان</a><a href="/specialties">تخصص‌ها</a><a href="/mag">مجله سلامت</a>${Object.entries(MAG_CATEGORIES).slice(0, 4).map(([c, l]) => `<a href="/mag/c/${c}">${esc(l)}</a>`).join('')}<a href="/legal">قوانین و حریم خصوصی</a></nav>
<p class="mg-copy">© ${esc(COMPANY.brand)} — ${esc(COMPANY.name)}. مطالب مجله جایگزین معاینه و مشاوره پزشک نیست.</p>
</div></footer>`;
  }

  const card = (a) => `<article class="mg-card">
<a class="mg-card-img" href="/mag/${encodeURIComponent(a.slug)}" tabindex="-1" aria-hidden="true"><img src="${esc(cover(a))}" alt="" loading="lazy" width="400" height="225"><span class="mg-badge">${esc(MAG_CATEGORIES[a.category])}</span></a>
<div class="mg-card-body">
<h3><a href="/mag/${encodeURIComponent(a.slug)}">${esc(a.title)}</a></h3>
<p>${esc(a.summary)}</p>
<div class="mg-meta"><span>${svg('cal', 16)}<time datetime="${esc(a.published_at)}">${faDate(a.published_at)}</time></span><span>${svg('clock', 16)}${faNum(readingMinutes(renderMarkdown(a.body).text))} دقیقه مطالعه</span></div>
</div></article>`;

  const consultBox = () => `<section class="mg-side-card mg-consult" aria-labelledby="consult-h">
<img src="/intro/visit.webp" alt="" loading="lazy" width="320" height="180">
<h2 id="consult-h">مشاوره آنلاین با پزشکان</h2>
<p>پاسخ به سؤالات سلامت شما در سریع‌ترین زمان، به‌صورت متنی، صوتی یا تصویری.</p>
<a class="mg-btn" href="/">${svg('chat', 18)}دریافت مشاوره آنلاین</a>
</section>`;

  const popularBox = (tenantId) => {
    const rows = published(tenantId, 'ORDER BY views DESC, published_at DESC LIMIT 5');
    if (!rows.length) return '';
    return `<section class="mg-side-card" aria-labelledby="pop-h"><h2 id="pop-h">${svg('fire', 20)}مطالب پربازدید</h2><ol class="mg-pop">${rows.map((a) => `<li><a href="/mag/${encodeURIComponent(a.slug)}"><img src="${esc(cover(a))}" alt="" loading="lazy" width="56" height="56"><span><b>${esc(a.title)}</b><small>${a.views ? `${faNum(a.views)} بازدید` : faDate(a.published_at)}</small></span></a></li>`).join('')}</ol></section>`;
  };

  const newsletterBox = (state) => `<section class="mg-side-card" aria-labelledby="news-h"><h2 id="news-h">${svg('mail', 20)}عضویت در خبرنامه</h2>
${state === 'ok' ? '<p class="mg-ok" role="status">عضویت شما ثبت شد. سپاس از همراهی‌تان.</p>' : state === 'bad' ? '<p class="mg-err" role="alert">ایمیل یا شماره موبایل معتبر وارد کنید.</p>' : '<p>مقالات جدید و نکات سلامتی را از دست ندهید.</p>'}
<form class="mg-news" action="/mag/subscribe" method="post"><label class="mg-sr" for="news-contact">ایمیل یا شماره موبایل</label><input id="news-contact" name="contact" type="text" inputmode="email" maxlength="120" placeholder="ایمیل یا شماره موبایل خود را وارد کنید" required><input class="mg-hp" name="website" tabindex="-1" autocomplete="off" aria-hidden="true"><button type="submit" class="mg-btn">عضویت</button></form>
<p class="mg-fine">نشانی شما فقط برای ارسال خبرنامه استفاده می‌شود.</p></section>`;

  const categoryTiles = (active) => `<section aria-labelledby="cat-h"><h2 id="cat-h" class="mg-h2">${svg('doc', 22)}دسته‌بندی مطالب</h2>
<ul class="mg-cats"><li><a href="/mag"${active ? '' : ' aria-current="page"'}><span class="mg-cat-ic c-all">${svg('all', 30)}</span>همه</a></li>${Object.entries(MAG_CATEGORIES).map(([c, l]) => `<li><a href="/mag/c/${c}"${active === c ? ' aria-current="page"' : ''}><span class="mg-cat-ic c-${c}">${svg(c, 30)}</span>${esc(l)}</a></li>`).join('')}</ul></section>`;

  const orgLd = (base) => ({ '@type': 'Organization', name: COMPANY.brand, legalName: COMPANY.name, url: base, logo: `${base}/icons/icon-512.png` });

  function home(req, res, url) {
    const t = tenantOf();
    const base = siteBase(req);
    const latest = published(t, 'ORDER BY published_at DESC LIMIT 9');
    const state = url.searchParams.get('subscribed') === '1' ? 'ok' : url.searchParams.get('subscribe') === 'bad' ? 'bad' : null;
    const body = `<section class="mg-hero">
<div class="mg-hero-text">
<p class="mg-kicker">${svg('book', 26)}مجله سلامت</p>
<h1>دانش امروز، سلامت فردا</h1>
<p>در مجله سلامت درمان پلاس، مطالب علمی و کاربردی در زمینه تغذیه، ورزش، پیشگیری و درمان بیماری‌ها را می‌خوانید؛ هر مطلب پیش از انتشار توسط پزشک بازبینی می‌شود.</p>
<ul class="mg-points"><li>${svg('doctor', 22)}بازبینی پزشکی پیش از انتشار</li><li>${svg('shield', 22)}نوشته‌شده بر پایه منابع معتبر</li><li>${svg('chat', 22)}زبان ساده، مناسب برای همه</li></ul>
</div>
<img class="mg-hero-img" src="/mag-assets/hero.svg" alt="" width="460" height="300">
</section>
${categoryTiles(null)}
<div class="mg-cols">
<section class="mg-main" aria-labelledby="latest-h">
<h2 id="latest-h" class="mg-h2">${svg('doc', 22)}جدیدترین مطالب</h2>
${latest.length ? `<div class="mg-grid">${latest.map(card).join('')}</div>` : '<p class="mg-empty">نخستین مقالات مجله پس از بازبینی پزشکان به‌زودی منتشر می‌شوند.</p>'}
</section>
<aside class="mg-side">${consultBox()}${popularBox(t)}${newsletterBox(state)}</aside>
</div>
${bottomBanner()}`;
    return send(req, res, 200, layout(req, {
      title: 'مجله سلامت درمان پلاس | مقالات پزشکی، تغذیه و سبک زندگی سالم',
      description: 'مقالات علمی و کاربردی سلامت درباره تغذیه، ورزش، سلامت روان، پیشگیری و بیماری‌ها؛ بازبینی‌شده توسط پزشک، همراه با امکان مشاوره آنلاین.',
      path: '/mag', body,
      jsonld: [{ '@context': 'https://schema.org', '@type': 'CollectionPage', name: 'مجله سلامت درمان پلاس', url: `${base}/mag`, inLanguage: 'fa', publisher: orgLd(base),
        hasPart: latest.map((a) => ({ '@type': 'Article', headline: a.title, url: `${base}/mag/${encodeURIComponent(a.slug)}` })) }],
    }), state ? { 'Cache-Control': 'no-store' } : {});
  }

  const bottomBanner = () => `<section class="mg-banner" aria-labelledby="banner-h">
<div><h2 id="banner-h">سلامتی در دستان شماست</h2><p>با مجله سلامت درمان پلاس آگاه‌تر زندگی کنید و در صورت نیاز، از مشاوره آنلاین پزشکان بهره‌مند شوید.</p><a class="mg-btn" href="/">مشاهده خدمات مشاوره آنلاین ${svg('arrow', 18)}</a></div>
<ul class="mg-feat"><li>${svg('doc', 30)}مقالات بازبینی‌شده</li><li>${svg('doctor', 30)}پزشکان دارای مجوز</li><li>${svg('support', 30)}دستیار پشتیبانی</li></ul>
</section>`;

  function category(req, res, cat, url) {
    if (!MAG_CATEGORIES[cat]) return notFoundPage(req, res);
    const t = tenantOf();
    const page = Math.max(1, Math.min(500, Number.parseInt(url.searchParams.get('page') ?? '1', 10) || 1));
    const total = db.get(`SELECT COUNT(*) AS n FROM mag_articles WHERE tenant_id = ? AND status = 'published' AND category = ?`, t, cat).n;
    const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
    if (page > pages) return notFoundPage(req, res);
    const rows = published(t, 'AND category = ? ORDER BY published_at DESC LIMIT ? OFFSET ?', cat, PAGE_SIZE, (page - 1) * PAGE_SIZE);
    const label = MAG_CATEGORIES[cat];
    const path = `/mag/c/${cat}${page > 1 ? `?page=${page}` : ''}`;
    const nav = pages > 1 ? `<nav class="mg-pager" aria-label="صفحه‌ها">${page > 1 ? `<a rel="prev" href="/mag/c/${cat}${page > 2 ? `?page=${page - 1}` : ''}">صفحه قبل</a>` : ''}<span>صفحه ${faNum(page)} از ${faNum(pages)}</span>${page < pages ? `<a rel="next" href="/mag/c/${cat}?page=${page + 1}">صفحه بعد</a>` : ''}</nav>` : '';
    const base = siteBase(req);
    const body = `${crumbs([['مجله سلامت', '/mag'], [label, null]])}
<h1 class="mg-h1">${esc(label)}</h1>
<p class="mg-intro">${esc(CATEGORY_INTRO[cat])}</p>
${categoryTiles(cat)}
${rows.length ? `<div class="mg-grid mg-grid-wide">${rows.map(card).join('')}</div>${nav}` : '<p class="mg-empty">هنوز مقاله‌ای در این دسته منتشر نشده است.</p>'}`;
    return send(req, res, 200, layout(req, {
      title: `${label}${page > 1 ? ` — صفحه ${faNum(page)}` : ''} | مجله سلامت درمان پلاس`,
      description: CATEGORY_INTRO[cat],
      path, robots: rows.length ? 'index,follow' : 'noindex,follow', body,
      jsonld: [breadcrumbLd(base, [['مجله سلامت', '/mag'], [label, `/mag/c/${cat}`]])],
    }));
  }

  const crumbs = (items) => `<nav class="mg-crumbs" aria-label="مسیر"><ol><li><a href="/">خانه</a></li>${items.map(([l, href]) => `<li>${href ? `<a href="${href}">${esc(l)}</a>` : `<span aria-current="page">${esc(l)}</span>`}</li>`).join('')}</ol></nav>`;
  const breadcrumbLd = (base, items) => ({ '@context': 'https://schema.org', '@type': 'BreadcrumbList',
    itemListElement: [['خانه', '/'], ...items].map(([name, p], i) => ({ '@type': 'ListItem', position: i + 1, name, item: `${base}${p}` })) });

  function articlePage(req, res, a, { preview = false } = {}) {
    const base = siteBase(req);
    const w = preview ? domain.magazine.working(a) : a;
    const md = renderMarkdown(w.body, { siteHost: new URL(base).host });
    const minutes = readingMinutes(md.text);
    const reviewer = domain.magazine.doctorName(w.reviewer_doctor_id);
    const reviewedAt = w.reviewed_at;
    const label = MAG_CATEGORIES[w.category];
    const path = `/mag/${encodeURIComponent(a.slug)}`;
    const related = preview ? [] : published(a.tenant_id, 'AND category = ? AND id != ? ORDER BY published_at DESC LIMIT 3', a.category, a.id);
    const toc = md.headings.filter((x) => x.level === 2);
    const body = `${preview ? '<p class="mg-preview-bar" role="status">پیش‌نمایش — این صفحه هنوز منتشر نشده و برای موتورهای جستجو قابل مشاهده نیست.</p>' : ''}
${crumbs([['مجله سلامت', '/mag'], [label, `/mag/c/${w.category}`], [w.title, null]])}
<div class="mg-cols">
<article class="mg-main mg-article">
<header>
<span class="mg-badge static">${esc(label)}</span>
<h1>${esc(w.title)}</h1>
<p class="mg-lead">${esc(w.summary)}</p>
<div class="mg-meta">${a.published_at ? `<span>${svg('cal', 16)}انتشار: <time datetime="${esc(a.published_at)}">${faDate(a.published_at)}</time></span>` : ''}${a.published_at && a.updated_at > a.published_at ? `<span>به‌روزرسانی: <time datetime="${esc(a.updated_at)}">${faDate(a.updated_at)}</time></span>` : ''}<span>${svg('clock', 16)}${faNum(minutes)} دقیقه مطالعه</span></div>
${reviewer && reviewedAt ? `<p class="mg-reviewed">${svg('shield', 18)}بازبینی پزشکی: <b>${reviewer.public_profile && reviewer.public_slug ? `<a href="/doctors/${encodeURIComponent(reviewer.public_slug)}">${esc(reviewer.full_name ?? 'پزشک')}</a>` : esc(reviewer.full_name ?? 'پزشک')}</b>${reviewer.specialty && SPECIALTIES[reviewer.specialty] ? ` — ${esc(SPECIALTIES[reviewer.specialty])}` : ''} · <time datetime="${esc(reviewedAt)}">${faDate(reviewedAt)}</time></p>` : ''}
</header>
<img class="mg-cover" src="${esc(cover(w))}" alt="${esc(w.title)}" width="800" height="450">
${toc.length >= 3 ? `<nav class="mg-toc" aria-label="فهرست مطالب"><b>آنچه در این مقاله می‌خوانید</b><ol>${toc.map((x) => `<li><a href="#${x.id}">${esc(x.text)}</a></li>`).join('')}</ol></nav>` : ''}
<div class="mg-body">${md.html}</div>
<aside class="mg-disclaimer">${svg('shield', 20)}<p>این مطلب برای آگاهی عمومی است و جایگزین معاینه، تشخیص یا درمان توسط پزشک نیست. در صورت داشتن علائم، با پزشک مشورت کنید؛ در شرایط اورژانسی با ۱۱۵ تماس بگیرید.</p></aside>
<div class="mg-cta"><div><b>سؤالی درباره این موضوع دارید؟</b><p>با پزشکان درمان پلاس به‌صورت آنلاین مشورت کنید.</p></div><a class="mg-btn" href="/">${svg('chat', 18)}مشاوره آنلاین</a></div>
${related.length ? `<section aria-labelledby="rel-h"><h2 id="rel-h" class="mg-h2">مطالب مرتبط</h2><div class="mg-grid">${related.map(card).join('')}</div></section>` : ''}
</article>
<aside class="mg-side">${consultBox()}${preview ? '' : popularBox(a.tenant_id)}</aside>
</div>`;
    const image = shareImage(w);
    const ld = [{
      '@context': 'https://schema.org', '@type': 'MedicalWebPage', '@id': `${base}${path}#page`, url: `${base}${path}`, name: w.title, inLanguage: 'fa',
      ...(reviewer && reviewedAt ? { lastReviewed: reviewedAt.slice(0, 10), reviewedBy: { '@type': 'Physician', name: reviewer.full_name, ...(reviewer.public_profile && reviewer.public_slug ? { url: `${base}/doctors/${encodeURIComponent(reviewer.public_slug)}` } : {}), ...(SPECIALTIES[reviewer.specialty] ? { medicalSpecialty: SPECIALTIES[reviewer.specialty] } : {}) } } : {}),
      mainEntity: {
        '@type': 'Article', headline: w.title.slice(0, 110), description: w.summary, image: `${base}${image}`,
        datePublished: a.published_at, dateModified: a.updated_at, articleSection: label, keywords: parseJson(a.keywords, []).join('، ') || undefined,
        author: orgLd(base), publisher: orgLd(base), mainEntityOfPage: `${base}${path}`,
      },
    }, breadcrumbLd(base, [['مجله سلامت', '/mag'], [label, `/mag/c/${w.category}`], [w.title, path]])];
    return send(req, res, 200, layout(req, {
      title: `${a.seo_title || w.title} | مجله سلامت درمان پلاس`,
      description: a.seo_description || w.summary,
      path, robots: preview ? 'noindex,nofollow' : 'index,follow', ogType: 'article', image, jsonld: preview ? [] : ld, body,
    }), preview ? { 'Cache-Control': 'private, no-store' } : {});
  }

  function search(req, res, url) {
    const q = String(url.searchParams.get('q') ?? '').trim().slice(0, 80);
    const t = tenantOf();
    const rows = q.length >= 2 ? published(t, `AND (title LIKE ? OR summary LIKE ? OR body LIKE ?) ORDER BY published_at DESC LIMIT 30`, `%${q}%`, `%${q}%`, `%${q}%`) : [];
    const body = `${crumbs([['مجله سلامت', '/mag'], ['جستجو', null]])}
<h1 class="mg-h1">${q ? `نتایج جستجو برای «${esc(q)}»` : 'جستجو در مجله سلامت'}</h1>
${rows.length ? `<div class="mg-grid mg-grid-wide">${rows.map(card).join('')}</div>` : `<p class="mg-empty">${q.length >= 2 ? 'مطلبی پیدا نشد. واژه دیگری را امتحان کنید.' : 'دست‌کم دو حرف بنویسید.'}</p>`}`;
    return send(req, res, 200, layout(req, { title: 'جستجو | مجله سلامت درمان پلاس', description: 'جستجو در مقالات مجله سلامت درمان پلاس', path: '/mag/search', robots: 'noindex,follow', body }), { 'Cache-Control': 'no-store' });
  }

  // ---------------------------------------------------------------- legal documents
  const legalSettings = () => ({ refundHours: getVisitSettings(db, tenantOf()).cancel_refund_hours, holdMin: domain.payments?.HOLD_MIN ?? 15 });

  function legalIndexPage(req, res) {
    const items = legalIndex(legalSettings());
    const body = `${crumbs([['قوانین و حریم خصوصی', null]])}
<h1 class="mg-h1">قوانین، حریم خصوصی و شرایط خدمات</h1>
<p class="mg-intro">شرایط استفاده، حریم خصوصی، محدودیت‌های مشاوره غیرحضوری و شیوه رسیدگی به شکایات در درمان پلاس. آخرین به‌روزرسانی: ${esc(LEGAL_UPDATED)}</p>
<ul class="mg-links">${items.map((it) => `<li><a href="/legal/${it.id}">${svg('shield', 20)}${esc(it.title)}</a></li>`).join('')}</ul>`;
    return send(req, res, 200, layout(req, { title: 'قوانین و حریم خصوصی | درمان پلاس', description: 'شرایط استفاده از خدمات، اطلاعیه حریم خصوصی، محدودیت‌های مشاوره غیرحضوری و شیوه رسیدگی به شکایات درمان پلاس.', path: '/legal', body, nav: 'legal' }));
  }

  function legalPage(req, res, id) {
    const d = legalDoc(id, legalSettings());
    if (!d) return notFoundPage(req, res);
    const sec = (s) => `<section>${s.h ? `<h2>${esc(s.h)}</h2>` : ''}${(s.p ?? []).map((p) => `<p>${esc(p)}</p>`).join('')}${s.list ? `<ul>${s.list.map((li) => `<li>${esc(li)}</li>`).join('')}</ul>` : ''}${s.table ? `<div class="mg-table"><table><thead><tr>${s.table.head.map((c) => `<th>${esc(c)}</th>`).join('')}</tr></thead><tbody>${s.table.rows.map((r) => `<tr>${r.map((c) => `<td>${esc(c)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>` : ''}</section>`;
    const first = d.sections.find((s) => s.p?.length)?.p[0] ?? d.title;
    const body = `${crumbs([['قوانین و حریم خصوصی', '/legal'], [d.title, null]])}
<article class="mg-article mg-legal"><h1>${esc(d.title)}</h1><p class="mg-meta">آخرین به‌روزرسانی: ${esc(d.updated)} — ${esc(d.company.name)}</p>
<div class="mg-body">${d.sections.map(sec).join('')}</div>
<p class="mg-meta">رایانامه: <a href="mailto:${esc(d.company.email)}" dir="ltr">${esc(d.company.email)}</a></p></article>`;
    return send(req, res, 200, layout(req, { title: `${d.title} | درمان پلاس`, description: first.slice(0, 160), path: `/legal/${id}`, body, nav: 'legal',
      jsonld: [breadcrumbLd(siteBase(req), [['قوانین و حریم خصوصی', '/legal'], [d.title, `/legal/${id}`]])] }));
  }

  // ---------------------------------------------------------------- doctors and specialties
  // Only approved doctors who can take bookings AND turned on their public page themselves.
  const publicDoctors = (where = '', ...args) => db.all(
    `SELECT d.*, u.full_name FROM doctors d JOIN users u ON u.id = d.user_id
     WHERE d.tenant_id = ? AND d.deleted_at IS NULL AND u.disabled_at IS NULL AND u.deleted_at IS NULL
       AND d.public_profile = 1 AND d.public_slug IS NOT NULL AND ${DOCTOR_BOOKABLE_SQL} ${where}
     ORDER BY u.full_name`, tenantOf(), ...args);
  const doctorUrl = (d) => `/doctors/${encodeURIComponent(d.public_slug)}`;
  const doctorName = (d) => { const n = d.full_name ?? 'پزشک'; return n.startsWith('دکتر') ? n : `دکتر ${n}`; };
  const photo = (d, size) => (d.photo_file_id
    ? `<img class="mg-avatar" src="${doctorUrl(d)}/photo" alt="${esc(doctorName(d))}" width="${size}" height="${size}" loading="lazy">`
    : `<span class="mg-avatar ph" style="width:${size}px;height:${size}px" aria-hidden="true">${svg('doctor', Math.round(size / 2))}</span>`);
  const tehranTime = (iso) => new Intl.DateTimeFormat('fa-IR-u-ca-persian', { weekday: 'long', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Tehran' }).format(new Date(iso));
  const nextFree = (doctorId) => db.get(
    `SELECT s.starts_at FROM slots s WHERE s.doctor_id = ? AND s.starts_at > ? AND s.blocked_at IS NULL AND s.removed_at IS NULL
       AND NOT EXISTS (SELECT 1 FROM appointments a WHERE a.slot_id = s.id AND a.status IN ('pending','confirmed'))
     ORDER BY s.starts_at LIMIT 1`, doctorId, nowIso())?.starts_at ?? null;
  const doctorCard = (d) => `<article class="mg-doc">
<a href="${doctorUrl(d)}" class="mg-doc-in">${photo(d, 72)}<span><b>${esc(doctorName(d))}</b><small>${esc(SPECIALTIES[d.specialty] ?? '')}${d.experience_years ? ` · ${faNum(d.experience_years)} سال سابقه` : ''}</small></span></a></article>`;
  const prices = () => {
    const t = domain.payments?.effectiveTariffs?.(tenantOf()) ?? {};
    const rows = [['visit_video', 'ویزیت تصویری'], ['visit_audio', 'ویزیت صوتی'], ['visit_chat', 'ویزیت متنی']];
    return `<ul class="mg-services">${rows.map(([k, l]) => `<li>${svg(k === 'visit_chat' ? 'chat' : 'doctor', 20)}<span>${l}</span><b>${t[k] ? `${faNum(Math.round(t[k] / 10))} تومان` : ''}</b></li>`).join('')}</ul>`;
  };
  const howItWorks = () => `<section class="mg-side-card"><h2>${svg('cal', 20)}نوبت‌گیری چطور است؟</h2><ol class="mg-steps"><li>وارد درمان پلاس شوید یا با شماره موبایل ثبت‌نام کنید.</li><li>پزشک و یکی از زمان‌های آزاد را انتخاب و پرداخت کنید.</li><li>در زمان نوبت، از بخش «نوبت‌ها» وارد اتاق ویزیت شوید.</li></ol><a class="mg-btn" href="/">${svg('cal', 18)}رزرو نوبت آنلاین</a></section>`;

  function doctorsPage(req, res) {
    const docs = publicDoctors();
    const base = siteBase(req);
    const bySpec = Object.keys(SPECIALTIES).map((code) => [code, docs.filter((d) => d.specialty === code)]).filter(([, l]) => l.length);
    const body = `${crumbs([['پزشکان', null]])}
<h1 class="mg-h1">پزشکان مشاوره آنلاین درمان پلاس</h1>
<p class="mg-intro">با پزشکان دارای مجوز نظام پزشکی، به‌صورت تصویری، صوتی یا متنی مشورت کنید. مدارک همه پزشکان پیش از فعالیت بررسی و تأیید می‌شود.</p>
<div class="mg-cols"><div class="mg-main">
${bySpec.length ? bySpec.map(([code, list]) => `<section><h2 class="mg-h2"><a href="/specialties/${code}">${esc(SPECIALTIES[code])}</a></h2><div class="mg-docs">${list.map(doctorCard).join('')}</div></section>`).join('') : '<p class="mg-empty">فهرست پزشکان به‌زودی در این صفحه نمایش داده می‌شود. تا آن زمان می‌توانید پس از ورود، همه پزشکان و زمان‌های آزادشان را ببینید.</p>'}
<p><a class="mg-btn ghost" href="/specialties">همه تخصص‌ها</a></p>
</div><aside class="mg-side">${howItWorks()}</aside></div>`;
    return send(req, res, 200, layout(req, {
      title: 'پزشکان مشاوره آنلاین و ویزیت آنلاین | درمان پلاس', description: 'فهرست پزشکان و متخصصان درمان پلاس برای مشاوره آنلاین تصویری، صوتی و متنی؛ نوبت‌دهی اینترنتی با پزشکان دارای مجوز.',
      path: '/doctors', robots: docs.length ? 'index,follow' : 'noindex,follow', nav: 'doctors', body,
      jsonld: [breadcrumbLd(base, [['پزشکان', '/doctors']]), { '@context': 'https://schema.org', '@type': 'ItemList', itemListElement: docs.map((d, i) => ({ '@type': 'ListItem', position: i + 1, url: `${base}${doctorUrl(d)}`, name: doctorName(d) })) }],
    }));
  }

  function doctorPage(req, res, slug) {
    const d = publicDoctors('AND d.public_slug = ?', slug)[0];
    if (!d) return notFoundPage(req, res);
    const base = siteBase(req);
    const spec = SPECIALTIES[d.specialty] ?? '';
    const next = nextFree(d.id);
    const reviewed = published(tenantOf(), 'AND reviewer_doctor_id = ? ORDER BY published_at DESC LIMIT 6', d.id);
    const license = d.public_show_license && d.license_no && !String(d.license_no).startsWith('pending-') ? d.license_no : null;
    const body = `${crumbs([['پزشکان', '/doctors'], [spec, `/specialties/${d.specialty}`], [doctorName(d), null]])}
<div class="mg-cols"><article class="mg-main mg-article">
<header class="mg-doc-head">${photo(d, 120)}<div><h1>${esc(doctorName(d))}</h1><p class="mg-lead">${esc(spec)}${d.experience_years ? ` · ${faNum(d.experience_years)} سال سابقه` : ''}</p>
${license ? `<p class="mg-meta">${svg('shield', 16)}شماره نظام پزشکی: <bdi>${esc(license)}</bdi></p>` : ''}
<p class="mg-reviewed">${svg('shield', 18)}مدارک این پزشک توسط درمان پلاس بررسی و تأیید شده است.</p></div></header>
${d.bio ? `<section><h2 class="mg-h2">درباره پزشک</h2><div class="mg-body"><p>${esc(d.bio).replace(/\n+/g, '</p><p>')}</p></div></section>` : ''}
${d.education ? `<section><h2 class="mg-h2">تحصیلات</h2><div class="mg-body"><p>${esc(d.education).replace(/\n+/g, '</p><p>')}</p></div></section>` : ''}
<section><h2 class="mg-h2">خدمات آنلاین</h2>${prices()}</section>
<div class="mg-cta"><div><b>${next ? `نزدیک‌ترین زمان آزاد: ${esc(tehranTime(next))}` : 'زمان‌های آزاد این پزشک به‌زودی منتشر می‌شود'}</b><p>برای رزرو، وارد درمان پلاس شوید و زمان دلخواه را انتخاب کنید.</p></div><a class="mg-btn" href="/">${svg('cal', 18)}رزرو نوبت آنلاین</a></div>
${reviewed.length ? `<section aria-labelledby="rv-h"><h2 id="rv-h" class="mg-h2">مقالات بازبینی‌شده توسط این پزشک</h2><div class="mg-grid">${reviewed.map(card).join('')}</div></section>` : ''}
</article><aside class="mg-side">${howItWorks()}</aside></div>`;
    const ld = { '@context': 'https://schema.org', '@type': 'Physician', name: doctorName(d), url: `${base}${doctorUrl(d)}`,
      ...(spec ? { medicalSpecialty: spec } : {}), ...(d.bio ? { description: String(d.bio).slice(0, 300) } : {}),
      ...(d.photo_file_id ? { image: `${base}${doctorUrl(d)}/photo` } : {}), ...(license ? { identifier: license } : {}),
      isAcceptingNewPatients: true, memberOf: orgLd(base), availableService: { '@type': 'MedicalProcedure', name: 'مشاوره پزشکی آنلاین (تصویری، صوتی و متنی)' } };
    return send(req, res, 200, layout(req, {
      title: `${doctorName(d)}، ${spec} | نوبت و مشاوره آنلاین درمان پلاس`,
      description: `${doctorName(d)}، ${spec}${d.experience_years ? ` با ${faNum(d.experience_years)} سال سابقه` : ''}. مشاوره و ویزیت آنلاین تصویری، صوتی و متنی و نوبت‌دهی اینترنتی در درمان پلاس.`,
      path: doctorUrl(d), nav: 'doctors', ogType: 'profile', image: d.photo_file_id ? `${doctorUrl(d)}/photo` : null, body,
      jsonld: [ld, breadcrumbLd(base, [['پزشکان', '/doctors'], [spec, `/specialties/${d.specialty}`], [doctorName(d), doctorUrl(d)]])],
    }));
  }

  function doctorPhoto(req, res, slug) {
    const d = publicDoctors('AND d.public_slug = ?', slug)[0];
    const f = d?.photo_file_id && db.get('SELECT * FROM files WHERE id = ?', d.photo_file_id);
    if (!f) return notFoundPage(req, res);
    const data = domain.files.read(f);
    res.writeHead(200, { 'Content-Type': f.mime, 'Content-Length': data.length, 'Cache-Control': 'public, max-age=86400', 'X-Content-Type-Options': 'nosniff' });
    res.end(req.method === 'HEAD' ? undefined : data);
    return true;
  }

  function specialtiesPage(req, res) {
    const docs = publicDoctors();
    const body = `${crumbs([['تخصص‌ها', null]])}
<h1 class="mg-h1">مشاوره آنلاین با پزشکان متخصص</h1>
<p class="mg-intro">تخصص موردنظر را انتخاب کنید تا پزشکان آن و زمان‌های آزادشان را ببینید. اگر نمی‌دانید به کدام متخصص مراجعه کنید، دستیار هوشمند درمان پلاس پس از ورود علائم شما را بررسی و تخصص مناسب را پیشنهاد می‌کند.</p>
<ul class="mg-links">${Object.entries(SPECIALTIES).map(([code, l]) => { const n = docs.filter((d) => d.specialty === code).length; return `<li><a href="/specialties/${code}">${svg('doctor', 20)}${esc(l)}<small>${n ? `${faNum(n)} پزشک` : 'به‌زودی'}</small></a></li>`; }).join('')}</ul>`;
    return send(req, res, 200, layout(req, { title: 'تخصص‌های پزشکی برای مشاوره آنلاین | درمان پلاس', description: 'مشاوره و ویزیت آنلاین با پزشکان عمومی و متخصص قلب، پوست، کودکان، زنان، اعصاب، گوارش و سایر تخصص‌ها در درمان پلاس.', path: '/specialties', nav: 'doctors', body, jsonld: [breadcrumbLd(siteBase(req), [['تخصص‌ها', '/specialties']])] }));
  }

  function specialtyPage(req, res, code) {
    const label = SPECIALTIES[code];
    if (!label) return notFoundPage(req, res);
    const docs = publicDoctors('AND d.specialty = ?', code);
    const base = siteBase(req);
    const name = code === 'general' ? 'پزشک عمومی' : `متخصص ${label}`;
    const body = `${crumbs([['تخصص‌ها', '/specialties'], [label, null]])}
<h1 class="mg-h1">مشاوره و ویزیت آنلاین ${esc(name)}</h1>
<p class="mg-intro">در درمان پلاس می‌توانید بدون مراجعه حضوری، با ${esc(name)} به‌صورت تصویری، صوتی یا متنی مشورت کنید، مدارک و نتایج آزمایش خود را برای پزشک بفرستید و در صورت نیاز نسخه الکترونیک دریافت کنید.</p>
<div class="mg-cols"><div class="mg-main">
${docs.length ? `<div class="mg-docs">${docs.map(doctorCard).join('')}</div>` : '<p class="mg-empty">صفحه پزشکان این تخصص به‌زودی تکمیل می‌شود. پس از ورود، فهرست کامل پزشکان را می‌بینید.</p>'}
<section><h2 class="mg-h2">خدمات و تعرفه‌ها</h2>${prices()}</section>
<aside class="mg-disclaimer">${svg('shield', 20)}<p>مشاوره آنلاین جایگزین خدمات اورژانس نیست. در شرایط اورژانسی با ۱۱۵ تماس بگیرید یا به نزدیک‌ترین مرکز درمانی مراجعه کنید.</p></aside>
</div><aside class="mg-side">${howItWorks()}</aside></div>`;
    return send(req, res, 200, layout(req, {
      title: `مشاوره آنلاین ${name} | نوبت و ویزیت آنلاین درمان پلاس`,
      description: `مشاوره و ویزیت آنلاین با ${name} به‌صورت تصویری، صوتی و متنی؛ نوبت‌دهی اینترنتی با پزشکان دارای مجوز در درمان پلاس.`,
      path: `/specialties/${code}`, robots: docs.length ? 'index,follow' : 'noindex,follow', nav: 'doctors', body,
      jsonld: [breadcrumbLd(base, [['تخصص‌ها', '/specialties'], [label, `/specialties/${code}`]]), { '@context': 'https://schema.org', '@type': 'MedicalWebPage', name: `مشاوره آنلاین ${name}`, url: `${base}/specialties/${code}`, inLanguage: 'fa', specialty: label,
        mainEntity: { '@type': 'ItemList', itemListElement: docs.map((d, i) => ({ '@type': 'ListItem', position: i + 1, url: `${base}${doctorUrl(d)}`, name: doctorName(d) })) } }],
    }));
  }

  function notFoundPage(req, res, status = 404) {
    const body = `<section class="mg-404"><h1 class="mg-h1">${status === 410 ? 'این مطلب دیگر در دسترس نیست' : 'صفحه پیدا نشد'}</h1>
<p>${status === 410 ? 'این مقاله از مجله برداشته شده است.' : 'نشانی واردشده وجود ندارد یا جابه‌جا شده است.'}</p>
<p><a class="mg-btn" href="/mag">رفتن به مجله سلامت</a> <a class="mg-btn ghost" href="/">صفحه اصلی درمان پلاس</a></p></section>`;
    return send(req, res, status, layout(req, { title: 'صفحه پیدا نشد | درمان پلاس', description: 'صفحه موردنظر پیدا نشد.', path: new URL(req.url, 'http://x').pathname, robots: 'noindex,follow', body }), { 'Cache-Control': 'no-store' });
  }

  function robots(req, res) {
    const base = siteBase(req);
    const txt = `User-agent: *\nAllow: /\nDisallow: /v1/\nDisallow: /mag/search\nDisallow: /mag/preview/\n\nSitemap: ${base}/sitemap.xml\n`;
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'public, max-age=3600' });
    res.end(req.method === 'HEAD' ? undefined : txt);
    return true;
  }

  function sitemap(req, res) {
    const base = siteBase(req);
    const t = tenantOf();
    const rows = published(t, 'ORDER BY published_at DESC LIMIT 45000');
    const latest = rows.reduce((m, a) => (a.updated_at > m ? a.updated_at : m), '');
    const cats = [...new Set(rows.map((a) => a.category))];
    const docs = publicDoctors();
    const u = (loc, lastmod) => `<url><loc>${esc(loc)}</loc>${lastmod ? `<lastmod>${lastmod.slice(0, 10)}</lastmod>` : ''}</url>`;
    const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${[
      u(`${base}/`), u(`${base}/mag`, latest || null),
      ...cats.map((c) => u(`${base}/mag/c/${c}`, rows.filter((a) => a.category === c).reduce((m, a) => (a.updated_at > m ? a.updated_at : m), ''))),
      ...rows.map((a) => u(`${base}/mag/${encodeURIComponent(a.slug)}`, a.updated_at)),
      ...(docs.length ? [u(`${base}/doctors`)] : []), u(`${base}/specialties`),
      ...[...new Set(docs.map((d) => d.specialty))].map((c) => u(`${base}/specialties/${c}`)),
      ...docs.map((d) => u(`${base}${doctorUrl(d)}`)),
      u(`${base}/legal`), ...legalIndex(legalSettings()).map((it) => u(`${base}/legal/${it.id}`)),
    ].join('\n')}\n</urlset>\n`;
    res.writeHead(200, { 'Content-Type': 'application/xml; charset=utf-8', 'Cache-Control': 'public, max-age=900' });
    res.end(req.method === 'HEAD' ? undefined : xml);
    return true;
  }

  function image(req, res, key) {
    if (!IMG_KEY.test(key)) return notFoundPage(req, res);
    const file = join(domain.magazine.imageDir, key);
    if (!existsSync(file)) return notFoundPage(req, res);
    res.writeHead(200, { 'Content-Type': IMG_MIME[key.split('.').pop()], 'Content-Length': statSync(file).size, 'Cache-Control': 'public, max-age=2592000, immutable', 'X-Content-Type-Options': 'nosniff' });
    if (req.method === 'HEAD') { res.end(); return true; }
    createReadStream(file).pipe(res);
    return true;
  }

  async function readForm(req) {
    let size = 0;
    const chunks = [];
    for await (const c of req) { size += c.length; if (size > 4096) return null; chunks.push(c); }
    return new URLSearchParams(Buffer.concat(chunks).toString('utf8'));
  }

  async function subscribe(req, res, ip) {
    const back = (q) => { res.writeHead(303, { Location: `/mag?${q}#news-h`, 'Cache-Control': 'no-store' }); res.end(); return true; };
    try { limiter.hit(`mag-sub:${ip}`, 5, 3600e3); } catch { return back('subscribe=bad'); }
    const form = await readForm(req);
    if (!form || form.get('website')) return back('subscribed=1'); // honeypot: pretend success
    const raw = String(form.get('contact') ?? '').trim().slice(0, 120);
    const email = /^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i.test(raw) ? raw.toLowerCase() : null;
    const phone = email ? null : normalizePhone(raw);
    if (!email && !phone) return back('subscribe=bad');
    db.run(`INSERT INTO mag_subscribers (id, tenant_id, contact, kind, created_at) VALUES (?,?,?,?,?)
            ON CONFLICT (tenant_id, contact) DO UPDATE SET unsubscribed_at = NULL`, uuid(), tenantOf(), email ?? phone, email ? 'email' : 'phone', nowIso());
    return back('subscribed=1');
  }

  // → true when the request was answered here.
  async function handle(req, res, url, ip) {
    const p = url.pathname;
    const read = req.method === 'GET' || req.method === 'HEAD';
    if (p === '/robots.txt' && read) return robots(req, res);
    if (p === '/sitemap.xml' && read) return sitemap(req, res);
    let m;
    if (read && (p === '/legal' || p === '/legal/')) return legalIndexPage(req, res);
    if (read && (m = /^\/legal\/([a-z]+)\/?$/.exec(p))) return legalPage(req, res, m[1]);
    if (read && (p === '/doctors' || p === '/doctors/')) return doctorsPage(req, res);
    if (read && (p === '/specialties' || p === '/specialties/')) return specialtiesPage(req, res);
    if (read && (m = /^\/specialties\/([a-z]+)\/?$/.exec(p))) return specialtyPage(req, res, m[1]);
    if (read && (m = /^\/doctors\/([^/]+)(\/photo)?\/?$/.exec(p))) {
      let slug;
      try { slug = decodeURIComponent(m[1]); } catch { return notFoundPage(req, res); }
      return m[2] ? doctorPhoto(req, res, slug) : doctorPage(req, res, slug);
    }
    if (p !== '/mag' && !p.startsWith('/mag/')) return false;
    if (p === '/mag/subscribe' && req.method === 'POST') return subscribe(req, res, ip);
    if (!read) return false;
    if (p === '/mag' || p === '/mag/') return p === '/mag/' ? redirect(res, '/mag') : home(req, res, url);
    if (p === '/mag/search') return search(req, res, url);
    if ((m = /^\/mag\/c\/([a-z]+)\/?$/.exec(p))) return category(req, res, m[1], url);
    if ((m = /^\/mag\/img\/([^/]+)$/.exec(p))) return image(req, res, m[1]);
    if ((m = /^\/mag\/preview\/([0-9a-f-]{36})$/.exec(p))) {
      const exp = Number(url.searchParams.get('exp'));
      const sig = String(url.searchParams.get('sig') ?? '');
      const good = domain.files.sign(`mag-preview:${m[1]}`, exp);
      const ok = exp > Date.now() / 1000 && sig.length === good.length && crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(good));
      const a = ok && db.get('SELECT * FROM mag_articles WHERE id = ?', m[1]);
      return a ? articlePage(req, res, a, { preview: true }) : notFoundPage(req, res);
    }
    if ((m = /^\/mag\/([^/]+)\/?$/.exec(p))) {
      let slug;
      try { slug = decodeURIComponent(m[1]); } catch { return notFoundPage(req, res); }
      const a = db.get('SELECT * FROM mag_articles WHERE tenant_id = ? AND slug = ?', tenantOf(), slug);
      if (!a || !['published', 'archived'].includes(a.status)) return notFoundPage(req, res);
      if (a.status === 'archived') return notFoundPage(req, res, 410);
      if (p.endsWith('/')) return redirect(res, `/mag/${encodeURIComponent(a.slug)}`);
      if (req.method === 'GET' && !BOT_UA.test(String(req.headers['user-agent'] ?? ''))) db.run('UPDATE mag_articles SET views = views + 1 WHERE id = ?', a.id);
      return articlePage(req, res, a);
    }
    return notFoundPage(req, res);
  }

  const redirect = (res, to) => { res.writeHead(301, { Location: to }); res.end(); return true; };

  return { handle, notFoundPage };
}
