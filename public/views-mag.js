// Health magazine panels: staff write, send for a doctor's review, publish; doctors review.
// The public pages themselves are served by the server under /mag.
export function installMag(x) {
  const { VIEWS, h, api, toast, fa, fmt, route, guard, apiUrl } = x;
  const TONE = { draft: '', review: 'warn', approved: 'info', published: 'ok', archived: 'danger' };
  const siteUrl = (path) => apiUrl(path); // the magazine is on the same server as the API
  const openTab = (path) => window.open(siteUrl(path), '_blank', 'noopener');
  const fld = (label, el, extra = null) => { el.style.width = '100%'; return h('div', { class: 'stack', style: 'gap:4px' }, h('label', {}, label), el, extra); };

  // ---------------------------------------------------------------- staff: list
  VIEWS.magazine = async (id) => {
    if (id) return editor(id);
    const meta = await api('GET', '/v1/admin/mag/meta');
    let status = '';
    const tabs = h('div', { class: 'row wrap', style: 'margin-bottom:10px' });
    const q = h('input', { type: 'search', placeholder: 'جستجو در عنوان', style: 'max-width:260px' });
    const list = h('div', { class: 'card' });
    const load = guard(async () => {
      const r = await api('GET', `/v1/admin/mag/articles?status=${status}&q=${encodeURIComponent(q.value.trim())}`);
      tabs.replaceChildren(...[['', 'همه'], ...Object.entries(meta.statuses)].map(([k, l]) => h('button', { class: `btn small ${status === k ? 'primary' : ''}`, onclick: () => { status = k; load(); } }, l)));
      list.replaceChildren(
        r.items.length ? h('ul', { class: 'list' }, r.items.map((a) => h('li', { class: 'row' },
          h('span', { class: 'grow' }, h('b', {}, a.title), h('br'),
            h('span', { class: 'muted small' }, `${a.category_label} · ${a.reviewer ? `بازبین: ${a.reviewer.full_name}` : 'بدون بازبین'} · ${fa(a.views)} بازدید · ویرایش ${fmt.short(a.updated_at)}`)),
          a.has_pending ? h('span', { class: 'pill warn' }, 'ویرایش در انتظار') : null,
          h('span', { class: `pill ${TONE[a.status]}` }, a.status_label),
          h('button', { class: 'btn small', onclick: () => route('magazine', a.id) }, 'باز کردن'))))
          : h('div', { class: 'empty' }, 'مقاله‌ای نیست.'));
    });
    q.oninput = () => { clearTimeout(q.t); q.t = setTimeout(load, 300); };
    x.$app.append(
      h('div', { class: 'card stack' },
        h('div', { class: 'row wrap' }, h('h2', { class: 'grow' }, '📰 مجله سلامت'),
          h('button', { class: 'btn', onclick: () => openTab('/mag') }, 'مشاهده مجله'),
          h('button', { class: 'btn primary', onclick: () => route('magazine', 'new') }, '+ مقاله جدید')),
        h('p', { class: 'muted' }, 'هر مقاله پیش از انتشار باید توسط یک پزشک تأییدشده بازبینی شود. ویرایش متن مقاله منتشرشده تا تأیید دوباره پزشک، روی سایت نمی‌رود؛ عنوان سئو، توضیحات متا و تصویر بدون بازبینی به‌روز می‌شوند.'),
        h('p', { class: 'muted small' }, `مشترکان خبرنامه: ${fa(meta.subscribers)}`)),
      tabs, h('div', { style: 'margin-bottom:10px' }, q), list);
    await load();
  };

  // ---------------------------------------------------------------- staff: editor
  async function editor(id) {
    const meta = await api('GET', '/v1/admin/mag/meta');
    const isNew = id === 'new';
    const a = isNew ? { title: '', slug: '', summary: '', body: '', category: 'nutrition', keywords: [], seo_title: '', seo_description: '', status: 'draft', revisions: [] } : await api('GET', `/v1/admin/mag/articles/${id}`);
    const counter = (el, max) => {
      const c = h('span', { class: 'muted small' });
      const upd = () => { c.textContent = `${fa(el.value.length)} از ${fa(max)}`; c.style.color = el.value.length > max ? 'var(--danger)' : ''; };
      el.addEventListener('input', upd); upd();
      return c;
    };
    const title = h('input', { value: a.title, maxlength: 140 });
    const slug = h('input', { value: a.slug, class: 'ltr', placeholder: 'خالی بگذارید تا از عنوان ساخته شود' });
    const category = h('select', {}, meta.categories.map((c) => h('option', { value: c.code, selected: c.code === a.category }, c.label)));
    const summary = h('textarea', { rows: 3, maxlength: 320 }, a.summary);
    const body = h('textarea', { rows: 22, style: 'font-family:inherit;line-height:1.9' }, a.body);
    const seoTitle = h('input', { value: a.seo_title ?? '', maxlength: 70 });
    const seoDesc = h('textarea', { rows: 2, maxlength: 170 }, a.seo_description ?? '');
    const keywords = h('input', { value: (a.keywords ?? []).join('، '), placeholder: 'با ویرگول جدا کنید' });
    let coverId = a.cover_image_id ?? null;
    const coverImg = h('img', { src: a.cover_url ? siteUrl(a.cover_url) : '', alt: '', style: `max-width:320px;border-radius:12px;${a.cover_url ? '' : 'display:none'}` });
    const coverInput = h('input', { type: 'file', accept: 'image/jpeg,image/png,image/webp' });
    coverInput.onchange = guard(async () => {
      const f = coverInput.files[0];
      if (!f) return;
      if (f.size > 3 * 1024 * 1024) throw new Error('حداکثر حجم تصویر ۳ مگابایت است');
      const res = await fetch(apiUrl('/v1/admin/mag/images'), { method: 'POST', headers: { Authorization: `Bearer ${x.getSession().access_token}`, 'Content-Type': f.type }, body: f });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(j.message || 'بارگذاری ناموفق بود');
      coverId = j.id; coverImg.src = siteUrl(j.url); coverImg.style.display = '';
      toast('تصویر بارگذاری شد؛ برای ثبت، ذخیره کنید');
    });
    const fields = () => ({
      title: title.value, slug: slug.value, category: category.value, summary: summary.value, body: body.value,
      seo_title: seoTitle.value, seo_description: seoDesc.value, keywords: keywords.value, cover_image_id: coverId,
    });
    const save = guard(async () => {
      const r = isNew ? await api('POST', '/v1/admin/mag/articles', fields()) : await api('PUT', `/v1/admin/mag/articles/${id}`, fields());
      toast(r.has_pending ? 'ذخیره شد؛ تغییرات متن پس از تأیید پزشک روی سایت می‌رود' : 'ذخیره شد');
      route('magazine', r.id);
    });
    const reviewer = h('select', {}, h('option', { value: '' }, 'انتخاب پزشک بازبین…'),
      meta.reviewers.map((d) => h('option', { value: d.id, selected: d.id === a.reviewer?.id }, d.full_name ?? 'پزشک')));
    const act = (path, msg) => guard(async () => { await api('POST', `/v1/admin/mag/articles/${id}/${path}`, path === 'submit' ? { reviewer_doctor_id: reviewer.value } : {}); toast(msg); route('magazine', id); });
    const reviewState = a.has_pending ? a.pending_state : a.status;

    const statusBox = isNew ? null : h('div', { class: 'card stack' },
      h('div', { class: 'row wrap' },
        h('span', { class: `pill ${TONE[a.status]}` }, a.status_label),
        a.has_pending ? h('span', { class: 'pill warn' }, `ویرایش در انتظار: ${meta.statuses[a.pending_state] ?? a.pending_state}`) : null,
        h('span', { class: 'grow' }),
        h('button', { class: 'btn small', onclick: () => openTab(a.preview_url) }, '👁 پیش‌نمایش'),
        a.status === 'published' ? h('button', { class: 'btn small', onclick: () => openTab(`/mag/${encodeURIComponent(a.slug)}`) }, '🔗 صفحه منتشرشده') : null),
      a.review_note ? h('div', { class: `banner ${reviewState === 'draft' ? 'warn' : 'info'}` }, `یادداشت بازبینی: ${a.review_note}`) : null,
      a.reviewed_at ? h('p', { class: 'muted small' }, `تأیید پزشک: ${a.reviewer?.full_name ?? ''} — ${fmt.short(a.reviewed_at)}`) : null,
      ['draft', 'review', 'approved'].includes(reviewState) && a.status !== 'archived' ? h('div', { class: 'row wrap' }, reviewer,
        h('button', { class: 'btn', onclick: act('submit', 'برای بازبینی پزشک ارسال شد') }, reviewState === 'review' ? 'تغییر بازبین' : 'ارسال برای بازبینی پزشک')) : null,
      meta.can_publish && reviewState === 'approved' ? h('button', { class: 'btn primary', onclick: act('publish', 'منتشر شد') }, a.status === 'published' ? '✓ انتشار تغییرات تأییدشده' : '✓ انتشار در مجله') : null,
      meta.can_publish && a.status === 'published' ? h('button', { class: 'btn danger small', onclick: guard(async () => { if (!confirm('مقاله از سایت برداشته شود؟')) return; await act('unpublish', 'از سایت برداشته شد')(); }) }, 'برداشتن از سایت') : null,
      a.status === 'archived' ? h('button', { class: 'btn', onclick: act('reopen', 'به پیش‌نویس برگشت') }, 'بازگرداندن به پیش‌نویس') : null);

    const help = h('details', {}, h('summary', {}, 'راهنمای نگارش متن'),
      h('ul', { class: 'muted small' },
        h('li', {}, '«## عنوان» برای سرفصل اصلی و «### عنوان» برای زیرعنوان'),
        h('li', {}, '«- » در ابتدای خط برای فهرست و «۱. » برای فهرست شماره‌دار'),
        h('li', {}, '«**متن**» برای پررنگ و «[متن](/mag/...)» برای پیوند'),
        h('li', {}, '«> » در ابتدای خط برای کادر هشدار (مثلاً زمان مراجعه به پزشک)'),
        h('li', {}, 'تشخیص قطعی یا دوز دارو ننویسید؛ مطالب برای آگاهی عمومی است.')));

    x.$app.append(
      h('button', { class: 'btn small', style: 'margin-bottom:10px', onclick: () => route('magazine') }, '→ بازگشت به فهرست'),
      statusBox ?? '',
      h('div', { class: 'card stack' },
        h('h2', {}, isNew ? 'مقاله جدید' : 'ویرایش مقاله'),
        fld('عنوان', title, counter(title, 140)),
        h('div', { class: 'grid2' }, fld('دسته‌بندی', category), fld('نشانی (slug)', slug)),
        fld('خلاصه (زیر عنوان و در فهرست‌ها)', summary, counter(summary, 320)),
        fld('متن مقاله', body), help,
        fld('تصویر شاخص (اختیاری، نسبت ۱۶ به ۹، حداکثر ۳ مگابایت)', coverInput), coverImg),
      h('div', { class: 'card stack' },
        h('h3', {}, 'سئو'),
        fld('عنوان صفحه در گوگل (اگر خالی باشد، عنوان مقاله)', seoTitle, counter(seoTitle, 60)),
        fld('توضیحات متا (متن زیر عنوان در نتایج گوگل)', seoDesc, counter(seoDesc, 160)),
        fld('کلمات کلیدی', keywords)),
      h('div', { class: 'row', style: 'margin:12px 0' }, h('button', { class: 'btn primary', onclick: save }, '💾 ذخیره')),
      isNew || !a.revisions?.length ? '' : h('div', { class: 'card' }, h('h3', {}, 'تاریخچه نسخه‌ها'),
        h('ul', { class: 'list' }, a.revisions.map((r) => h('li', { class: 'row' },
          h('span', { class: 'grow' }, `${REV[r.action] ?? r.action} — ${r.actor ?? 'سامانه'}`, h('br'), h('span', { class: 'muted small' }, fmt.short(r.created_at))),
          ['edit', 'create', 'restore'].includes(r.action) ? h('button', { class: 'btn small', onclick: guard(async () => {
            if (!confirm('محتوای این نسخه جایگزین شود؟ متن تغییرکرده دوباره به بازبینی پزشک نیاز دارد.')) return;
            await api('POST', `/v1/admin/mag/articles/${id}/restore`, { revision_id: r.id }); toast('نسخه بازگردانده شد'); route('magazine', id);
          }) }, 'بازگردانی') : null)))));
  }
  const REV = { create: 'ایجاد', edit: 'ویرایش', restore: 'بازگردانی نسخه', publish: 'انتشار', unpublish: 'برداشتن از سایت', reopen: 'بازگشت به پیش‌نویس', review_approve: 'تأیید پزشک', review_reject: 'درخواست اصلاح پزشک' };

  // ---------------------------------------------------------------- doctor: review queue
  VIEWS['doctor-mag-reviews'] = async () => {
    const r = await api('GET', '/v1/doctors/me/mag-reviews');
    const item = (a) => {
      const note = h('textarea', { rows: 2, placeholder: 'یادداشت برای تیم محتوا (برای درخواست اصلاح الزامی است)' });
      const decide = (approve) => guard(async () => {
        await api('POST', `/v1/doctors/me/mag-reviews/${a.id}`, { approve, note: note.value });
        toast(approve ? 'تأیید شد' : 'برای اصلاح برگشت داده شد'); route('doctor-mag-reviews');
      });
      return h('li', { class: 'stack', style: 'padding:12px 0' },
        h('div', { class: 'row wrap' }, h('b', { class: 'grow' }, a.title), h('span', { class: 'pill' }, a.category_label)),
        h('p', { class: 'muted small' }, a.summary),
        h('div', { class: 'row wrap' },
          h('button', { class: 'btn small', onclick: guard(async () => { const d = await api('GET', `/v1/doctors/me/mag-reviews/${a.id}`); openTab(d.preview_url); }) }, '👁 خواندن متن کامل')),
        note,
        h('div', { class: 'row wrap' },
          h('button', { class: 'btn primary small', onclick: decide(true) }, '✓ از نظر پزشکی صحیح است'),
          h('button', { class: 'btn small', onclick: decide(false) }, 'نیاز به اصلاح دارد')));
    };
    x.$app.append(
      h('div', { class: 'card stack' }, h('h2', {}, '📰 بازبینی مقالات مجله سلامت'),
        h('p', { class: 'muted' }, 'مقالات پیش از انتشار با نام شما به‌عنوان «بازبین پزشکی» نمایش داده می‌شوند. فقط در صورتی تأیید کنید که متن از نظر علمی درست و برای عموم بی‌خطر است.'),
        r.waiting.length ? h('ul', { class: 'list' }, r.waiting.map(item)) : h('div', { class: 'empty' }, 'مقاله‌ای در انتظار بازبینی شما نیست.')),
      r.done.length ? h('div', { class: 'card' }, h('h3', {}, 'بازبینی‌های اخیر'),
        h('ul', { class: 'list' }, r.done.map((a) => h('li', { class: 'row' }, h('span', { class: 'grow' }, a.title), h('span', { class: 'muted small' }, fmt.short(a.reviewed_at)))))) : '');
  };
}
