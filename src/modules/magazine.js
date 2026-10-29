// Health magazine (مجله سلامت): public articles for search engines and readers.
//   • Staff with mag.write write and edit; every article is reviewed by an approved doctor before
//     it can go live; staff with mag.publish publish and unpublish.
//   • Edits to a live article wait in pending_changes with their own review; the reviewed text
//     stays online meanwhile. Every save is kept in mag_revisions and can be restored.
//   • Separate tables (mag_*); nothing here reads or writes patient data.
// The public pages themselves are rendered on the server by magazine-pages.js.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ApiError, badRequest, conflict, forbidden, notFound, requireUuid } from '../lib/http.js';
import { uuid, nowIso, parseJson, isUniqueViolation } from '../lib/db.js';
import { renderMarkdown, readingMinutes } from '../lib/markdown.js';
import { sniff } from './files.js';
import { requireUser } from './auth.js';
import { MAG_DRAFTS } from '../content/mag-drafts.js';

export const MAG_CATEGORIES = {
  nutrition: 'تغذیه سالم',
  fitness: 'ورزش و تحرک',
  mental: 'سلامت روان',
  prevention: 'پیشگیری و ایمنی',
  diseases: 'بیماری‌ها',
  women: 'سلامت زنان و خانواده',
  men: 'سلامت مردان',
};
const CONTENT_FIELDS = ['title', 'summary', 'body', 'category'];
const LIVE_FIELDS = ['slug', 'seo_title', 'seo_description', 'keywords', 'cover_image_id'];
const IMAGE_MAX = 3 * 1024 * 1024;
const PREVIEW_TTL_S = 30 * 60;

export const STATUS_LABELS = { draft: 'پیش‌نویس', review: 'در انتظار بازبینی پزشک', approved: 'تأییدشده، آماده انتشار', published: 'منتشرشده', archived: 'بایگانی' };

export function slugify(text) {
  return String(text ?? '').trim().toLowerCase()
    .replace(/[‌\s_]+/g, '-')
    .replace(/[^\p{L}\p{N}-]/gu, '')
    .replace(/-+/g, '-').replace(/^-|-$/g, '')
    .slice(0, 90);
}

export function createMagazineDomain({ db, platform, config, domain }) {
  const imageDir = join(config.filesDir, '..', 'mag-images');
  mkdirSync(imageDir, { recursive: true });

  const get = (ctx, id) => {
    const a = db.get('SELECT * FROM mag_articles WHERE id = ? AND tenant_id = ?', requireUuid(id, 'id'), ctx.tenantId);
    if (!a) throw notFound('مقاله');
    return a;
  };
  const doctorName = (doctorId) => doctorId && db.get(
    `SELECT u.full_name, d.specialty, d.id, d.public_profile, d.public_slug FROM doctors d JOIN users u ON u.id = d.user_id WHERE d.id = ?`, doctorId) || null;
  const approvedDoctor = (tenantId, doctorId) => db.get(
    `SELECT d.id, d.user_id, u.phone FROM doctors d JOIN users u ON u.id = d.user_id
     WHERE d.id = ? AND d.tenant_id = ? AND d.status = 'approved' AND d.deleted_at IS NULL AND u.disabled_at IS NULL`, doctorId, tenantId);
  const imageUrl = (id) => {
    if (!id) return null;
    const row = db.get('SELECT storage_key FROM mag_images WHERE id = ?', id);
    return row ? `/mag/img/${row.storage_key}` : null;
  };
  const pending = (a) => parseJson(a.pending_changes, null);
  // What the reviewer and the editor work on: the pending edit of a live article, else the article.
  const working = (a) => {
    const p = pending(a);
    return p ? { ...a, ...p.fields, review_state: p.state, reviewer_doctor_id: p.reviewer_doctor_id ?? a.reviewer_doctor_id, review_note: p.note ?? null, reviewed_at: p.reviewed_at ?? null } : { ...a, review_state: a.status };
  };

  function revision(ctx, article, action) {
    const snap = Object.fromEntries([...CONTENT_FIELDS, ...LIVE_FIELDS, 'status'].map((k) => [k, article[k]]));
    const p = pending(article);
    if (p) snap.pending = p.fields;
    db.run('INSERT INTO mag_revisions (id, article_id, action, snapshot, actor_id, created_at) VALUES (?,?,?,?,?,?)',
      uuid(), article.id, action, JSON.stringify(snap), ctx.user?.sub ?? null, nowIso());
  }

  function clean(input, { partial = false } = {}) {
    const out = {};
    const has = (k) => input[k] !== undefined;
    const str = (k, min, max, label) => {
      const v = String(input[k] ?? '').trim();
      if (v.length < min || v.length > max) throw badRequest(`${label} باید بین ${min} تا ${max} نویسه باشد`);
      return v;
    };
    if (!partial || has('title')) out.title = str('title', 5, 140, 'عنوان');
    if (!partial || has('summary')) out.summary = str('summary', 0, 320, 'خلاصه');
    if (!partial || has('body')) out.body = str('body', 0, 60000, 'متن مقاله');
    if (!partial || has('category')) {
      if (!MAG_CATEGORIES[input.category]) throw badRequest('دسته‌بندی نامعتبر است');
      out.category = input.category;
    }
    if (has('slug') || !partial) {
      const s = slugify(input.slug || input.title);
      if (s.length < 3) throw badRequest('نشانی مقاله (slug) کوتاه است');
      out.slug = s;
    }
    if (has('seo_title')) out.seo_title = str('seo_title', 0, 70, 'عنوان سئو') || null;
    if (has('seo_description')) out.seo_description = str('seo_description', 0, 170, 'توضیحات متا') || null;
    if (has('keywords')) {
      const k = Array.isArray(input.keywords) ? input.keywords : String(input.keywords ?? '').split(/[,،]/);
      out.keywords = JSON.stringify(k.map((x) => String(x).trim()).filter(Boolean).slice(0, 10).map((x) => x.slice(0, 40)));
    }
    if (has('cover_image_id')) {
      if (input.cover_image_id && !db.get('SELECT 1 FROM mag_images WHERE id = ?', input.cover_image_id)) throw badRequest('تصویر نامعتبر است');
      out.cover_image_id = input.cover_image_id || null;
    }
    return out;
  }

  function create(ctx, input) {
    const f = clean(input);
    const id = uuid();
    const now = nowIso();
    try {
      db.run(`INSERT INTO mag_articles (id, tenant_id, slug, title, summary, body, category, cover_image_id, seo_title, seo_description, keywords, author_id, created_at, updated_at)
              VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        id, ctx.tenantId, f.slug, f.title, f.summary, f.body, f.category, f.cover_image_id ?? null, f.seo_title ?? null, f.seo_description ?? null, f.keywords ?? '[]', ctx.user?.sub ?? null, now, now);
    } catch (e) {
      if (isUniqueViolation(e)) throw conflict('مقاله‌ای با همین نشانی (slug) وجود دارد', 'slug_taken');
      throw e;
    }
    const a = db.get('SELECT * FROM mag_articles WHERE id = ?', id);
    revision(ctx, a, 'create');
    platform.audit(ctx, 'mag.create', `mag_article:${id}`, { slug: f.slug });
    return a;
  }

  // Content edits need a new medical review; live fields (slug, SEO texts, cover) do not.
  function update(ctx, id, input, action = 'edit') {
    const a = get(ctx, id);
    const f = clean(input, { partial: true });
    const live = Object.fromEntries(LIVE_FIELDS.filter((k) => f[k] !== undefined).map((k) => [k, f[k]]));
    const base = working(a);
    const content = Object.fromEntries(CONTENT_FIELDS.filter((k) => f[k] !== undefined && f[k] !== base[k]).map((k) => [k, f[k]]));
    const now = nowIso();
    db.tx(() => {
      if (Object.keys(live).length) {
        const cols = Object.keys(live);
        try {
          db.run(`UPDATE mag_articles SET ${cols.map((c) => `${c} = ?`).join(', ')}, updated_at = ? WHERE id = ?`, ...cols.map((c) => live[c]), now, a.id);
        } catch (e) {
          if (isUniqueViolation(e)) throw conflict('مقاله‌ای با همین نشانی (slug) وجود دارد', 'slug_taken');
          throw e;
        }
      }
      if (Object.keys(content).length) {
        if (a.status === 'published') {
          const p = pending(a);
          const fields = { ...Object.fromEntries(CONTENT_FIELDS.map((k) => [k, a[k]])), ...(p?.fields ?? {}), ...content };
          db.run('UPDATE mag_articles SET pending_changes = ?, updated_at = ? WHERE id = ?',
            JSON.stringify({ fields, state: 'draft', reviewer_doctor_id: p?.reviewer_doctor_id ?? a.reviewer_doctor_id ?? null }), now, a.id);
        } else {
          const cols = Object.keys(content);
          db.run(`UPDATE mag_articles SET ${cols.map((c) => `${c} = ?`).join(', ')}, status = CASE WHEN status = 'archived' THEN 'archived' ELSE 'draft' END,
                  reviewed_at = NULL, updated_at = ? WHERE id = ?`, ...cols.map((c) => content[c]), now, a.id);
        }
      }
    });
    const out = db.get('SELECT * FROM mag_articles WHERE id = ?', a.id);
    revision(ctx, out, action);
    platform.audit(ctx, `mag.${action}`, `mag_article:${a.id}`, { content: Object.keys(content), live: Object.keys(live) });
    return out;
  }

  function submitForReview(ctx, id, doctorId) {
    const a = get(ctx, id);
    const doc = approvedDoctor(ctx.tenantId, requireUuid(doctorId, 'reviewer_doctor_id'));
    if (!doc) throw badRequest('پزشک بازبین باید یک پزشک تأییدشده و فعال باشد', 'invalid_reviewer');
    const w = working(a);
    if (!w.body || String(w.body).trim().length < 200) throw badRequest('متن مقاله برای بازبینی خیلی کوتاه است (حداقل ۲۰۰ نویسه)');
    if (a.status === 'published') {
      const p = pending(a);
      if (!p) throw conflict('تغییری برای بازبینی وجود ندارد', 'nothing_to_review');
      db.run('UPDATE mag_articles SET pending_changes = ?, updated_at = ? WHERE id = ?',
        JSON.stringify({ ...p, state: 'review', reviewer_doctor_id: doc.id, note: null, reviewed_at: null }), nowIso(), a.id);
    } else {
      if (!['draft', 'approved', 'review'].includes(a.status)) throw conflict('این مقاله در وضعیت قابل ارسال برای بازبینی نیست', 'invalid_status');
      db.run(`UPDATE mag_articles SET status = 'review', reviewer_doctor_id = ?, review_note = NULL, reviewed_at = NULL, updated_at = ? WHERE id = ?`, doc.id, nowIso(), a.id);
    }
    platform.notify(ctx, { userId: doc.user_id, channel: 'push', target: doc.phone, body: `مقاله «${w.title}» برای بازبینی پزشکی به شما ارسال شد؛ از بخش «بازبینی مقالات» ببینید.` });
    platform.audit(ctx, 'mag.submit', `mag_article:${a.id}`, { reviewer: doc.id });
    return db.get('SELECT * FROM mag_articles WHERE id = ?', a.id);
  }

  function review(ctx, id, { approve, note }) {
    requireUser(ctx, 'doctor');
    const a = db.get('SELECT * FROM mag_articles WHERE id = ? AND tenant_id = ?', requireUuid(id, 'id'), ctx.tenantId);
    const w = a && working(a);
    if (!a || w.review_state !== 'review' || w.reviewer_doctor_id !== ctx.user.did) throw notFound('مقاله در انتظار بازبینی شما');
    const text = String(note ?? '').trim().slice(0, 1000) || null;
    if (!approve && (!text || text.length < 5)) throw badRequest('برای رد مقاله، دلیل یا اصلاحات لازم را بنویسید');
    const now = nowIso();
    if (a.status === 'published') {
      const p = pending(a);
      db.run('UPDATE mag_articles SET pending_changes = ?, updated_at = ? WHERE id = ?',
        JSON.stringify({ ...p, state: approve ? 'approved' : 'draft', note: text, reviewed_at: approve ? now : null }), now, a.id);
    } else {
      db.run(`UPDATE mag_articles SET status = ?, review_note = ?, reviewed_at = ?, updated_at = ? WHERE id = ?`,
        approve ? 'approved' : 'draft', text, approve ? now : null, now, a.id);
    }
    const out = db.get('SELECT * FROM mag_articles WHERE id = ?', a.id);
    revision(ctx, out, approve ? 'review_approve' : 'review_reject');
    platform.audit(ctx, approve ? 'mag.review_approve' : 'mag.review_reject', `mag_article:${a.id}`);
    const author = a.author_id && db.get('SELECT id, phone FROM users WHERE id = ?', a.author_id);
    if (author) platform.notify(ctx, { userId: author.id, channel: 'push', target: author.phone, body: approve ? `مقاله «${w.title}» توسط پزشک تأیید شد و آماده انتشار است.` : `مقاله «${w.title}» نیاز به اصلاح دارد: ${text}` });
    return out;
  }

  function publish(ctx, id) {
    const a = get(ctx, id);
    const now = nowIso();
    if (a.status === 'published') {
      const p = pending(a);
      if (!p || p.state !== 'approved') throw conflict('تغییرات این مقاله هنوز توسط پزشک تأیید نشده است', 'not_reviewed');
      const cols = CONTENT_FIELDS;
      db.run(`UPDATE mag_articles SET ${cols.map((c) => `${c} = ?`).join(', ')}, reviewer_doctor_id = ?, review_note = ?, reviewed_at = ?, pending_changes = NULL, updated_at = ? WHERE id = ?`,
        ...cols.map((c) => p.fields[c]), p.reviewer_doctor_id, p.note ?? null, p.reviewed_at, now, a.id);
    } else {
      if (a.status !== 'approved' || !a.reviewed_at || !a.reviewer_doctor_id) throw conflict('فقط مقاله‌ای که پزشک تأیید کرده منتشر می‌شود', 'not_reviewed');
      db.run(`UPDATE mag_articles SET status = 'published', published_at = COALESCE(published_at, ?), updated_at = ? WHERE id = ?`, now, now, a.id);
    }
    const out = db.get('SELECT * FROM mag_articles WHERE id = ?', a.id);
    revision(ctx, out, 'publish');
    platform.audit(ctx, 'mag.publish', `mag_article:${a.id}`, { slug: out.slug });
    return out;
  }

  function unpublish(ctx, id) {
    const a = get(ctx, id);
    if (a.status !== 'published') throw conflict('این مقاله منتشر نشده است', 'invalid_status');
    db.run(`UPDATE mag_articles SET status = 'archived', updated_at = ? WHERE id = ?`, nowIso(), a.id);
    const out = db.get('SELECT * FROM mag_articles WHERE id = ?', a.id);
    revision(ctx, out, 'unpublish');
    platform.audit(ctx, 'mag.unpublish', `mag_article:${a.id}`);
    return out;
  }

  // An archived article goes back to draft (it needs a fresh review before it returns).
  function reopen(ctx, id) {
    const a = get(ctx, id);
    if (a.status !== 'archived') throw conflict('فقط مقاله بایگانی‌شده دوباره باز می‌شود', 'invalid_status');
    db.run(`UPDATE mag_articles SET status = 'draft', reviewed_at = NULL, updated_at = ? WHERE id = ?`, nowIso(), a.id);
    const out = db.get('SELECT * FROM mag_articles WHERE id = ?', a.id);
    revision(ctx, out, 'reopen');
    return out;
  }

  function restore(ctx, id, revisionId) {
    const a = get(ctx, id);
    const r = db.get('SELECT * FROM mag_revisions WHERE id = ? AND article_id = ?', requireUuid(revisionId, 'revision_id'), a.id);
    if (!r) throw notFound('نسخه');
    const s = parseJson(r.snapshot, {});
    const src = s.pending ?? s;
    const input = { ...Object.fromEntries(CONTENT_FIELDS.map((k) => [k, src[k]])), ...Object.fromEntries(LIVE_FIELDS.filter((k) => s[k] !== undefined).map((k) => [k, k === 'keywords' ? parseJson(s[k], []) : s[k]])) };
    return update(ctx, id, input, 'restore');
  }

  function storeImage(ctx, buffer) {
    if (!buffer.length) throw badRequest('فایل خالی است');
    if (buffer.length > IMAGE_MAX) throw new ApiError(413, 'file_too_large', 'حداکثر حجم تصویر مقاله ۳ مگابایت است');
    const t = sniff(buffer);
    if (!t || t.kind !== 'image') throw badRequest('فقط تصویر JPG، PNG یا WEBP مجاز است', 'unsupported_file_type');
    const id = uuid();
    const key = `${id}.${t.mime.split('/')[1].replace('jpeg', 'jpg')}`;
    writeFileSync(join(imageDir, key), buffer, { mode: 0o644 });
    db.run('INSERT INTO mag_images (id, tenant_id, mime, size, storage_key, uploaded_by, created_at) VALUES (?,?,?,?,?,?,?)',
      id, ctx.tenantId, t.mime, buffer.length, key, ctx.user.sub, nowIso());
    platform.audit(ctx, 'mag.image_upload', `mag_image:${id}`, { size: buffer.length });
    return { id, url: `/mag/img/${key}` };
  }

  // Signed preview link (works for the reviewing doctor without staff rights; not indexed).
  const previewUrl = (id) => {
    const exp = Math.floor(Date.now() / 1000) + PREVIEW_TTL_S;
    return `/mag/preview/${id}?exp=${exp}&sig=${domain.files.sign(`mag-preview:${id}`, exp)}`;
  };

  function view(a, { full = false } = {}) {
    const w = working(a);
    const reviewer = doctorName(w.reviewer_doctor_id);
    const out = {
      id: a.id, slug: a.slug, title: w.title, summary: w.summary, category: w.category, category_label: MAG_CATEGORIES[w.category],
      status: a.status, status_label: STATUS_LABELS[a.status], review_state: w.review_state,
      has_pending: !!a.pending_changes, pending_state: pending(a)?.state ?? null,
      reviewer: reviewer ? { id: reviewer.id, full_name: reviewer.full_name } : null, review_note: w.review_note, reviewed_at: w.reviewed_at,
      cover_url: imageUrl(a.cover_image_id), cover_image_id: a.cover_image_id,
      seo_title: a.seo_title, seo_description: a.seo_description, keywords: parseJson(a.keywords, []),
      views: a.views, published_at: a.published_at, updated_at: a.updated_at, created_at: a.created_at,
      reading_min: readingMinutes(renderMarkdown(w.body).text),
    };
    if (full) Object.assign(out, { body: w.body, live_title: a.title, preview_url: previewUrl(a.id) });
    return out;
  }

  // Draft articles written for the launch: added once, never published without a doctor's review.
  function seedDrafts(tenantId) {
    const flag = db.get(`SELECT 1 FROM settings WHERE tenant_id = ? AND key = 'mag_drafts_v1'`, tenantId);
    if (flag) return 0;
    let n = 0;
    const ctx = { tenantId, user: null };
    for (const d of MAG_DRAFTS) {
      if (db.get('SELECT 1 FROM mag_articles WHERE tenant_id = ? AND slug = ?', tenantId, slugify(d.slug))) continue;
      const a = create(ctx, d);
      db.run('UPDATE mag_articles SET review_note = ? WHERE id = ?', 'پیش‌نویس اولیه سامانه؛ پیش از انتشار باید توسط پزشک بازبینی و در صورت نیاز اصلاح شود.', a.id);
      n++;
    }
    db.run(`INSERT INTO settings (tenant_id, key, value, updated_at) VALUES (?, 'mag_drafts_v1', '{"done":true}', ?)`, tenantId, nowIso());
    return n;
  }

  return { get, create, update, submitForReview, review, publish, unpublish, reopen, restore, storeImage, view, working, doctorName, imageUrl, imageDir, seedDrafts, previewUrl };
}

export function register(router, { db, domain }) {
  const mag = domain.magazine;
  const can = (ctx, p) => domain.access.require(ctx, p);

  router.get('/v1/admin/mag/meta', async (ctx) => {
    can(ctx, 'mag.write');
    const reviewers = db.all(
      `SELECT d.id, u.full_name, d.specialty FROM doctors d JOIN users u ON u.id = d.user_id
       WHERE d.tenant_id = ? AND d.status = 'approved' AND d.deleted_at IS NULL AND u.disabled_at IS NULL ORDER BY u.full_name`, ctx.tenantId);
    const subs = db.get('SELECT COUNT(*) AS n FROM mag_subscribers WHERE tenant_id = ? AND unsubscribed_at IS NULL', ctx.tenantId).n;
    return { body: { categories: Object.entries(MAG_CATEGORIES).map(([code, label]) => ({ code, label })), statuses: STATUS_LABELS, reviewers, subscribers: subs, can_publish: domain.access.can(ctx, 'mag.publish') } };
  });

  router.get('/v1/admin/mag/articles', async (ctx) => {
    can(ctx, 'mag.write');
    const { status, q } = ctx.query;
    let rows = db.all(`SELECT * FROM mag_articles WHERE tenant_id = ? ${status && STATUS_LABELS[status] ? 'AND status = ?' : ''} ORDER BY updated_at DESC LIMIT 500`,
      ctx.tenantId, ...(status && STATUS_LABELS[status] ? [status] : []));
    if (q) { const t = String(q).trim(); rows = rows.filter((r) => r.title.includes(t) || r.slug.includes(t)); }
    return { body: { items: rows.map((a) => mag.view(a)) } };
  });

  router.post('/v1/admin/mag/articles', async (ctx) => {
    can(ctx, 'mag.write');
    return { status: 201, body: mag.view(mag.create(ctx, ctx.body), { full: true }) };
  });

  router.get('/v1/admin/mag/articles/:id', async (ctx) => {
    can(ctx, 'mag.write');
    const a = mag.get(ctx, ctx.params.id);
    const revisions = db.all(
      `SELECT r.id, r.action, r.created_at, u.full_name AS actor FROM mag_revisions r LEFT JOIN users u ON u.id = r.actor_id
       WHERE r.article_id = ? ORDER BY r.created_at DESC LIMIT 50`, a.id);
    return { body: { ...mag.view(a, { full: true }), revisions } };
  });

  router.put('/v1/admin/mag/articles/:id', async (ctx) => {
    can(ctx, 'mag.write');
    return { body: mag.view(mag.update(ctx, ctx.params.id, ctx.body), { full: true }) };
  });

  router.post('/v1/admin/mag/articles/:id/submit', async (ctx) => {
    can(ctx, 'mag.write');
    return { body: mag.view(mag.submitForReview(ctx, ctx.params.id, ctx.body.reviewer_doctor_id), { full: true }) };
  });

  router.post('/v1/admin/mag/articles/:id/restore', async (ctx) => {
    can(ctx, 'mag.write');
    return { body: mag.view(mag.restore(ctx, ctx.params.id, ctx.body.revision_id), { full: true }) };
  });

  router.post('/v1/admin/mag/articles/:id/publish', async (ctx) => {
    can(ctx, 'mag.publish');
    return { body: mag.view(mag.publish(ctx, ctx.params.id), { full: true }) };
  });

  router.post('/v1/admin/mag/articles/:id/unpublish', async (ctx) => {
    can(ctx, 'mag.publish');
    return { body: mag.view(mag.unpublish(ctx, ctx.params.id), { full: true }) };
  });

  router.post('/v1/admin/mag/articles/:id/reopen', async (ctx) => {
    can(ctx, 'mag.write');
    return { body: mag.view(mag.reopen(ctx, ctx.params.id), { full: true }) };
  });

  // Raw upload: body is the image itself.
  router.post('/v1/admin/mag/images', async (ctx) => {
    can(ctx, 'mag.write');
    const chunks = [];
    let size = 0;
    for await (const c of ctx.req) {
      size += c.length;
      if (size > IMAGE_MAX) throw new ApiError(413, 'file_too_large', 'حداکثر حجم تصویر مقاله ۳ مگابایت است');
      chunks.push(c);
    }
    return { status: 201, body: mag.storeImage(ctx, Buffer.concat(chunks)) };
  });

  // ---- reviewing doctor ----
  router.get('/v1/doctors/me/mag-reviews', async (ctx) => {
    requireUser(ctx, 'doctor');
    if (!ctx.user.did) throw forbidden();
    const rows = db.all(`SELECT * FROM mag_articles WHERE tenant_id = ? AND (reviewer_doctor_id = ? OR pending_changes LIKE ?) ORDER BY updated_at DESC LIMIT 200`,
      ctx.tenantId, ctx.user.did, `%${ctx.user.did}%`);
    const mine = rows.map((a) => mag.view(a)).filter((v) => v.reviewer?.id === ctx.user.did);
    return { body: { waiting: mine.filter((v) => v.review_state === 'review'), done: mine.filter((v) => v.review_state !== 'review' && v.reviewed_at).slice(0, 30) } };
  });

  router.get('/v1/doctors/me/mag-reviews/:id', async (ctx) => {
    requireUser(ctx, 'doctor');
    const a = db.get('SELECT * FROM mag_articles WHERE id = ? AND tenant_id = ?', requireUuid(ctx.params.id, 'id'), ctx.tenantId);
    const v = a && mag.view(a, { full: true });
    if (!v || v.reviewer?.id !== ctx.user.did) throw notFound('مقاله');
    return { body: v };
  });

  router.post('/v1/doctors/me/mag-reviews/:id', async (ctx) => {
    requireUser(ctx, 'doctor');
    if (typeof ctx.body.approve !== 'boolean') throw badRequest('approve باید true یا false باشد');
    domain.moderate(ctx, String(ctx.body.note ?? ''), 'mag_review');
    return { body: mag.view(mag.review(ctx, ctx.params.id, ctx.body)) };
  });
}
