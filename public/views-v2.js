import { jalaliPicker, todayJalali, formatJalaliDate } from './jalali.js';
// Views added for the second requirements document (app.docx):
//   doctor self-onboarding (profile, photo, medical-council card, status/rejection reason),
//   admin credential review, admin settings (tariffs) and payments, doctor directory and
//   profile pages for patients, patient medical documents, doctor-side records with AI pre-read,
//   and the ZarinPal payment flow.
// Helpers (h, api, …) are injected by app.js.

export const RECORD_ICONS = { lab: '🧪', imaging: '🩻', report: '📄', prescription: '💊', other: '📎' };

export function installV2(x) {
  const { VIEWS, h, api, toast, fa, fmt, route, guard, onCleanup, apiUrl, IS_NATIVE } = x;
  const toman = (rial) => fa(Math.round(rial / 10).toLocaleString('en-US')).replace(/,/g, '٬');

  // ---------------------------------------------------------------- uploads
  async function uploadFile(file, purpose) {
    if (file.size > 8 * 1024 * 1024) throw new Error('حداکثر حجم فایل ۸ مگابایت است');
    const s = x.getSession();
    const res = await fetch(apiUrl(`/v1/files?purpose=${purpose}`), {
      method: 'POST', headers: { Authorization: `Bearer ${s.access_token}`, 'Content-Type': file.type || 'application/octet-stream' }, body: file,
    });
    const j = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(j.message || 'بارگذاری ناموفق بود');
    return j;
  }
  const fileUrl = (u) => (u ? apiUrl(u) : null);
  const thumb = (f) => (f.mime === 'application/pdf'
    ? h('a', { class: 'thumb pdf', href: fileUrl(f.url), target: '_blank' }, '📄 PDF')
    : h('a', { href: fileUrl(f.url), target: '_blank' }, h('img', { class: 'thumb', src: fileUrl(f.url), alt: '' })));

  // ---------------------------------------------------------------- payments
  // Opens the gateway (system browser in the app, new tab on the web) and polls the result.
  async function pay(paymentId, { onPaid, title = 'پرداخت' } = {}) {
    const p = await api('POST', `/v1/payments/${paymentId}/start`, {});
    const status = h('p', { class: 'muted', role: 'status' }, 'در انتظار تکمیل پرداخت در درگاه…');
    const box = h('div', { class: 'wizard-overlay', role: 'dialog', 'aria-modal': 'true' }, h('div', { class: 'card pay-box' },
      h('h2', {}, title), h('p', {}, `مبلغ: `, h('b', {}, `${toman(p.amount)} تومان`)),
      h('p', { class: 'muted' }, 'درگاه پرداخت زرین‌پال باز می‌شود. پس از پرداخت به این صفحه برگردید؛ وضعیت خودکار به‌روز می‌شود.'),
      status,
      h('div', { class: 'row' },
        h('a', { class: 'btn primary', href: p.pay_url, target: '_blank', rel: 'noopener', onclick: (e) => { if (IS_NATIVE) { e.preventDefault(); location.href = p.pay_url; } } }, 'باز کردن دوباره درگاه'),
        h('button', { class: 'btn', onclick: () => { stop(); box.remove(); } }, 'بستن'))));
    document.body.append(box);
    if (IS_NATIVE) location.href = p.pay_url; else window.open(p.pay_url, '_blank', 'noopener');
    let timer = setInterval(async () => {
      try {
        const r = await api('GET', `/v1/payments/${paymentId}`);
        if (r.status === 'paid') { stop(); box.remove(); toast(`پرداخت موفق — کد پیگیری ${r.ref_number}`); onPaid?.(r); }
        else if (r.status === 'failed') { status.textContent = 'پرداخت ناموفق بود یا لغو شد. می‌توانید دوباره تلاش کنید.'; }
        else if (r.status === 'expired' || r.status === 'refund_required') { stop(); status.textContent = 'مهلت پرداخت تمام شد.'; }
      } catch { /* keep polling */ }
    }, 2000);
    const stop = () => { clearInterval(timer); timer = null; };
    onCleanup(stop);
  }
  x.pay = pay;

  function paymentBanner(a, onDone) {
    if (a.status !== 'pending' || !a.payment || a.payment.status === 'paid') return null;
    const left = a.payment_due_at ? Math.max(0, Math.round((Date.parse(a.payment_due_at) - Date.now()) / 60000)) : null;
    return h('div', { class: 'banner warn row' },
      h('span', { class: 'grow' }, `رزرو موقت — پرداخت ${toman(a.payment.amount)} تومان${left != null ? ` (حداکثر ${fa(left)} دقیقه دیگر)` : ''}`),
      h('button', { class: 'btn primary small', onclick: guard(() => pay(a.payment.id, { title: 'پرداخت هزینه ویزیت', onPaid: onDone })) }, '💳 پرداخت'));
  }
  x.paymentBanner = paymentBanner;

  // Ensure triage is paid before opening the wizard (emergencies are handled anyway).
  x.ensureTriagePaid = async () => {
    const e = await api('GET', '/v1/payments/entitlements');
    if (e.triage.available) return true;
    const ok = window.confirm(`ارزیابی علائم ${toman(e.triage.fee)} تومان هزینه دارد. پرداخت می‌کنید؟\n(در صورت علائم خطرناک مانند درد قفسه سینه یا تنگی نفس شدید همین حالا با ۱۱۵ تماس بگیرید.)`);
    if (!ok) return false;
    const r = await api('POST', '/v1/payments/triage', {});
    if (r.already_available) return true;
    return new Promise((resolve) => pay(r.id, { title: 'پرداخت هزینه ارزیابی علائم', onPaid: () => resolve(true) }));
  };

  // ---------------------------------------------------------------- doctor: profile & documents
  // Civil-registry (ثبت احوال) check: birth date + verified national id → official name.
  function registryBox(d, readOnly) {
    if (d.registry_verified) return h('div', { class: 'banner info' }, `✓ هویت در ثبت احوال تأیید شد (تاریخ تولد ${formatJalaliDate(d.birth_date)}).`);
    if (!d.person_info_enabled || readOnly) return null;
    let dob = null;
    return h('div', { class: 'banner warn stack' },
      h('b', {}, 'استعلام هویت از ثبت احوال (الزامی)'),
      h('span', {}, 'تاریخ تولد را وارد کنید؛ نام شما از ثبت احوال دریافت و در پروفایل ثبت می‌شود.'),
      jalaliPicker(h, { id: 'reg-dob', label: 'تاریخ تولد', minYear: todayJalali().jy - 100, onchange: (iso) => { dob = iso; } }),
      h('button', { class: 'btn primary', onclick: guard(async () => {
        if (!dob) throw new Error('تاریخ تولد را کامل انتخاب کنید');
        await api('PUT', '/v1/doctors/me/profile', { birth_date: dob });
        toast('هویت تأیید شد');
        route('doctor-profile');
      }) }, 'استعلام'));
  }

  VIEWS['doctor-profile'] = async () => {
    const [d, specs] = await Promise.all([api('GET', '/v1/doctors/me/profile'), api('GET', '/v1/specialties')]);
    const s = x.getSession();
    if (s && (s.user.doctor_status !== d.status || s.user.full_name !== d.full_name)) {
      x.setSession({ ...s, user: { ...s.user, doctor_status: d.status, full_name: d.full_name } });
      x.renderChrome();
    }
    const locked = d.status === 'pending_review';
    const approved = d.status === 'approved';
    const f = {
      full_name: h('input', { type: 'text', value: d.full_name ?? '', disabled: locked || approved || d.registry_verified }),
      specialty: h('select', { disabled: locked || approved }, specs.items.map((s) => h('option', { value: s.code, selected: s.code === d.specialty }, s.label))),
      license_no: h('input', { type: 'text', dir: 'ltr', value: d.license_no ?? '', disabled: locked || approved, placeholder: 'مثلاً 123456' }),
      education: h('textarea', { rows: 2, disabled: locked, placeholder: 'مثلاً دکترای حرفه‌ای پزشکی دانشگاه تهران؛ تخصص پوست …' }, d.education ?? ''),
      experience_years: h('input', { type: 'number', min: 0, max: 70, value: d.experience_years ?? '', disabled: locked }),
      bio: h('textarea', { rows: 6, disabled: locked, placeholder: 'معرفی، زمینه‌های کاری، افتخارات و … (این متن به بیماران نمایش داده می‌شود)' }, d.bio ?? ''),
    };
    let photoId = d.photo_file_id;
    let cardId = d.license_card_file_id;
    const photoPrev = h('div', { class: 'upload-prev' }, d.photo_url ? h('img', { src: fileUrl(d.photo_url), class: 'avatar-lg', alt: '' }) : 'عکسی انتخاب نشده');
    const cardPrev = h('div', { class: 'upload-prev' }, d.license_card_url ? h('a', { href: fileUrl(d.license_card_url), target: '_blank' }, '✓ کارت نظام پزشکی بارگذاری شده — مشاهده') : 'فایلی انتخاب نشده');
    const picker = (accept, purpose, onDone, prev) => h('input', {
      type: 'file', accept, disabled: locked || (purpose === 'license_card' && approved),
      onchange: guard(async (e) => {
        const file = e.target.files[0]; if (!file) return;
        prev.replaceChildren('در حال بارگذاری…');
        const r = await uploadFile(file, purpose);
        onDone(r.id);
        prev.replaceChildren(r.mime.startsWith('image/') ? h('img', { src: fileUrl(r.url), class: purpose === 'doctor_photo' ? 'avatar-lg' : 'card-img', alt: '' }) : '✓ فایل PDF بارگذاری شد');
      }),
    });
    const banner = {
      draft: h('div', { class: 'banner info' }, 'برای قرار گرفتن در فهرست پزشکان، پروفایل و مدارک را کامل کنید و «ارسال برای بررسی» را بزنید.'),
      pending_review: h('div', { class: 'banner warn' }, '⏳ مدارک شما در حال بررسی توسط مدیر سامانه است. نتیجه پیامک می‌شود.'),
      rejected: h('div', { class: 'banner danger' }, h('b', {}, 'مدارک تأیید نشد. '), `دلیل: ${d.review_reason ?? '—'}`, h('br'), 'موارد را اصلاح کنید و دوباره ارسال کنید.'),
      approved: h('div', { class: 'banner info' }, '✅ پروفایل شما تأیید شده و در فهرست پزشکان نمایش داده می‌شود. نام، تخصص، شماره و کارت نظام پزشکی فقط با درخواست به مدیر تغییر می‌کند.'),
    }[d.status];
    const save = async () => {
      const body = { education: f.education.value, experience_years: f.experience_years.value === '' ? null : Number(f.experience_years.value), bio: f.bio.value, photo_file_id: photoId };
      if (!approved) Object.assign(body, { ...(d.registry_verified ? {} : { full_name: f.full_name.value }), specialty: f.specialty.value, license_no: f.license_no.value, license_card_file_id: cardId });
      return api('PUT', '/v1/doctors/me/profile', body);
    };
    x.$app.append(
      h('div', { class: 'card' }, h('div', { class: 'row' }, h('h2', { class: 'grow' }, 'پروفایل و مدارک پزشک'), h('span', { class: `pill ${approved ? 'ok' : d.status === 'rejected' ? 'danger' : 'warn'}` }, d.status_label)),
        banner, d.identity_verified ? h('p', { class: 'muted' }, `✓ هویت با ${d.identity_source === 'shahkar' ? 'استعلام شاهکار' : 'استعلام آزمایشی'} تأیید شده است.`) : null),
      h('div', { class: 'card stack' },
        registryBox(d, locked || approved),
        h('div', { class: 'grid2' },
          h('div', {}, h('label', {}, d.registry_verified ? 'نام و نام خانوادگی (از ثبت احوال)' : 'نام و نام خانوادگی *'), f.full_name),
          h('div', {}, h('label', {}, 'تخصص *'), f.specialty),
          h('div', {}, h('label', {}, 'شماره نظام پزشکی *'), f.license_no),
          h('div', {}, h('label', {}, 'سابقه کار (سال)'), f.experience_years)),
        h('div', {}, h('label', {}, 'تحصیلات'), f.education),
        h('div', {}, h('label', {}, 'رزومه و معرفی * (حداقل ۳۰ حرف)'), f.bio),
        h('div', { class: 'grid2' },
          h('div', { class: 'upload' }, h('label', {}, 'عکس پروفایل * (پرسنلی و مناسب)'), photoPrev, picker('image/*', 'doctor_photo', (id) => { photoId = id; }, photoPrev)),
          h('div', { class: 'upload' }, h('label', {}, 'تصویر کارت نظام پزشکی * (عکس یا PDF)'), cardPrev, picker('image/*,application/pdf', 'license_card', (id) => { cardId = id; }, cardPrev))),
        locked ? null : h('div', { class: 'row' },
          h('button', { class: 'btn', onclick: guard(async () => { await save(); toast('ذخیره شد'); route('doctor-profile'); }) }, 'ذخیره'),
          approved ? null : h('button', { class: 'btn primary', onclick: guard(async () => { await save(); await api('POST', '/v1/doctors/me/submit', {}); toast('برای بررسی ارسال شد'); route('doctor-profile'); }) }, 'ذخیره و ارسال برای بررسی'))));
  };

  // ---------------------------------------------------------------- admin: credential review
  VIEWS['admin-doctors'] = async (id) => {
    if (id) return adminDoctorDetail(id);
    let status = 'pending_review';
    const tabs = h('div', { class: 'row', style: 'margin-bottom:10px' });
    const list = h('div', { class: 'card' });
    const STATUS = [['pending_review', 'در انتظار بررسی'], ['rejected', 'ردشده'], ['approved', 'تأییدشده'], ['draft', 'ناقص']];
    const load = async () => {
      const r = await api('GET', `/v1/admin/doctor-applications?status=${status}`);
      tabs.replaceChildren(...STATUS.map(([k, l]) => h('button', { class: `btn small ${status === k ? 'primary' : ''}`, onclick: () => { status = k; load(); } }, l)));
      list.replaceChildren(h('h2', {}, 'تأیید مدارک پزشکان'),
        r.items.length ? h('ul', { class: 'list' }, r.items.map((d) => h('li', { class: 'row' },
          d.photo_url ? h('img', { class: 'avatar', src: fileUrl(d.photo_url), alt: '' }) : h('span', { class: 'avatar ph' }, '👤'),
          h('span', { class: 'grow' }, h('b', {}, d.full_name ?? 'بدون نام'), ' · ', d.specialty_label, h('br'), h('span', { class: 'muted' }, `نظام پزشکی: ${d.license_no || '—'} · ${d.submitted_at ? fmt.short(d.submitted_at) : 'ارسال نشده'}`)),
          h('button', { class: 'btn small', onclick: () => route('admin-doctors', d.id) }, 'بررسی'))))
          : h('div', { class: 'empty' }, 'موردی نیست.'));
    };
    x.$app.append(tabs, list);
    await load();
  };

  async function adminDoctorDetail(id) {
    const d = await api('GET', `/v1/admin/doctors/${id}`);
    const reason = h('textarea', { rows: 3, placeholder: 'دلیل رد (برای پزشک پیامک و در پنل او نمایش داده می‌شود)' });
    x.$app.append(
      h('button', { class: 'btn small', style: 'margin-bottom:10px', onclick: () => route('admin-doctors') }, '→ بازگشت'),
      h('div', { class: 'card' },
        h('div', { class: 'row' }, d.photo_url ? h('img', { class: 'avatar-lg', src: fileUrl(d.photo_url), alt: '' }) : null,
          h('div', { class: 'grow' }, h('h2', {}, d.full_name ?? '—'), h('span', { class: 'pill' }, d.status_label), ' ', d.specialty_label)),
        h('div', { class: 'grid2', style: 'margin-top:12px' },
          h('div', {}, h('label', {}, 'شماره نظام پزشکی'), h('bdi', {}, d.license_no || '—')),
          h('div', {}, h('label', {}, 'موبایل'), h('bdi', {}, d.phone)),
          h('div', {}, h('label', {}, 'تأیید هویت'), d.identity_verified ? `✓ ${d.identity_source === 'shahkar' ? 'شاهکار' : 'آزمایشی'}` : '—', d.registry_verified ? ' · ✓ ثبت احوال' : ''),
          h('div', {}, h('label', {}, 'سابقه'), d.experience_years != null ? `${fa(d.experience_years)} سال` : '—')),
        h('h3', { style: 'margin-top:12px' }, 'تحصیلات'), h('p', {}, d.education ?? '—'),
        h('h3', {}, 'رزومه'), h('p', { style: 'white-space:pre-wrap' }, d.bio ?? '—'),
        h('h3', {}, 'کارت نظام پزشکی'),
        d.license_card_url ? h('a', { href: fileUrl(d.license_card_url), target: '_blank' }, h('img', { class: 'card-img', src: fileUrl(d.license_card_url), alt: 'کارت نظام پزشکی', onerror: (e) => { e.target.replaceWith('📄 مشاهده فایل PDF'); } })) : h('p', {}, '—'),
        h('p', { class: 'muted' }, 'شماره نظام پزشکی را با سامانه سازمان نظام پزشکی تطبیق دهید.')),
      d.status === 'pending_review' || d.status === 'approved' ? h('div', { class: 'card stack' },
        d.status === 'pending_review' ? h('button', { class: 'btn primary', onclick: guard(async () => { await api('POST', `/v1/admin/doctors/${id}/approve`, {}); toast('پزشک تأیید شد'); route('admin-doctors'); }) }, '✅ تأیید و افزودن به فهرست پزشکان') : null,
        reason,
        h('button', { class: 'btn danger', onclick: guard(async () => { await api('POST', `/v1/admin/doctors/${id}/reject`, { reason: reason.value }); toast('نتیجه برای پزشک ارسال شد'); route('admin-doctors'); }) }, d.status === 'approved' ? 'لغو تأیید با ذکر دلیل' : 'رد با ذکر دلیل')) : null);
  }

  // ---------------------------------------------------------------- admin: settings & payments
  VIEWS.settings = async () => {
    const s = await api('GET', '/v1/admin/settings');
    const inputs = Object.fromEntries(Object.keys(s.tariffs).map((k) => [k, h('input', { type: 'number', min: 0, step: 1000, value: Math.round(s.tariffs[k] / 10) })]));
    const enabled = h('input', { type: 'checkbox', checked: s.payments_enabled });
    const note = h('div', { class: 'banner warn' }, 'حالت آزمایشی: از بیماران هیچ هزینه‌ای گرفته نمی‌شود؛ نوبت‌ها بلافاصله قطعی و تریاژ رایگان است. مبالغ زیر حفظ می‌شوند.');
    const sync = () => { note.style.display = enabled.checked ? 'none' : ''; };
    enabled.onchange = sync; sync();
    x.$app.append(h('div', { class: 'card stack' },
      h('h2', {}, 'تعرفه خدمات'),
      h('label', { class: 'row', style: 'gap:8px;align-items:center;font-weight:700' }, enabled, 'دریافت هزینه از بیماران فعال است'),
      note,
      h('p', { class: 'muted' }, 'مبالغ به تومان. صفر یعنی خدمت رایگان است. حداقل مبلغ قابل پرداخت در درگاه ۱٬۰۰۰ تومان است.'),
      h('div', { class: 'grid2' }, Object.entries(inputs).map(([k, el]) => h('div', {}, h('label', {}, s.labels[k]), el))),
      h('div', { class: `banner ${s.gateway === 'zarinpal' ? 'info' : 'warn'}` },
        s.gateway === 'zarinpal' ? `درگاه: زرین‌پال${s.sandbox ? ' (محیط آزمایشی sandbox)' : ''}` : 'درگاه زرین‌پال تنظیم نشده؛ پرداخت‌ها با درگاه آزمایشی شبیه‌سازی می‌شوند (ZARINPAL_MERCHANT_ID را روی سرور تنظیم کنید).'),
      h('button', { class: 'btn primary', onclick: guard(async () => {
        const tariffs = Object.fromEntries(Object.entries(inputs).map(([k, el]) => [k, Math.round(Number(el.value || 0)) * 10]));
        await api('PUT', '/v1/admin/settings', { tariffs, payments_enabled: enabled.checked });
        toast(enabled.checked ? 'تعرفه‌ها ذخیره شد' : 'ذخیره شد — پرداخت بیماران غیرفعال است');
      }) }, 'ذخیره تعرفه‌ها')));
  };

  VIEWS.payments = async () => {
    const r = await api('GET', '/v1/payments?all=1');
    const st = { pending: ['در انتظار', 'warn'], paid: ['پرداخت‌شده', 'ok'], failed: ['ناموفق', ''], expired: ['منقضی', ''], refund_required: ['نیاز به بازگشت وجه', 'danger'], refunded: ['بازگشت داده شد', 'info'] };
    x.$app.append(h('div', { class: 'card' }, h('h2', {}, 'پرداخت‌ها'),
      r.items.length ? h('div', { style: 'overflow-x:auto' }, h('table', {},
        h('thead', {}, h('tr', {}, ['زمان', 'شرح', 'مبلغ (تومان)', 'وضعیت', 'کد پیگیری'].map((c) => h('th', {}, c)))),
        h('tbody', {}, r.items.map((p) => h('tr', {}, h('td', {}, fmt.short(p.created_at)), h('td', {}, p.description), h('td', {}, toman(p.amount)),
          h('td', {}, h('span', { class: `pill ${st[p.status]?.[1] ?? ''}` }, st[p.status]?.[0] ?? p.status)), h('td', { class: 'ltr' }, p.ref_number ?? '')))))) : h('div', { class: 'empty' }, '—')));
  };

  // ---------------------------------------------------------------- patient: doctors directory
  VIEWS.doctors = async () => {
    const specs = (await api('GET', '/v1/specialties')).items;
    const sel = h('select', {}, h('option', { value: '' }, 'همه تخصص‌ها'), specs.map((s) => h('option', { value: s.code }, s.label)));
    const q = h('input', { type: 'search', placeholder: 'جستجوی نام پزشک' });
    const grid = h('div', { class: 'doc-grid' });
    const load = guard(async () => {
      const r = await api('GET', `/v1/doctors?${new URLSearchParams({ ...(sel.value ? { specialty: sel.value } : {}), ...(q.value ? { q: q.value } : {}) })}`);
      grid.replaceChildren(...(r.items.length ? r.items.map((d) => h('button', { class: 'doc-card', onclick: () => route('doctor', d.id) },
        d.photo_url ? h('img', { class: 'avatar-lg', src: fileUrl(d.photo_url), alt: '' }) : h('span', { class: 'avatar-lg ph' }, '👨‍⚕️'),
        h('b', {}, d.full_name), h('span', { class: 'muted' }, d.specialty_label),
        d.experience_years != null ? h('span', { class: 'pill' }, `${fa(d.experience_years)} سال سابقه`) : null)) : [h('div', { class: 'empty' }, 'پزشکی یافت نشد.')]));
    });
    sel.onchange = load; q.oninput = load;
    x.$app.append(h('div', { class: 'card row' }, h('div', { class: 'grow' }, sel), h('div', { class: 'grow' }, q)), grid);
    load();
  };

  VIEWS.doctor = async (id) => {
    const [d, slots] = await Promise.all([api('GET', `/v1/doctors/${id}`), api('GET', `/v1/doctors/${id}/slots?limit=12`)]);
    x.$app.append(
      h('button', { class: 'btn small', style: 'margin-bottom:10px', onclick: () => route('doctors') }, '→ همه پزشکان'),
      h('div', { class: 'card doc-profile' },
        d.photo_url ? h('img', { class: 'avatar-xl', src: fileUrl(d.photo_url), alt: '' }) : h('span', { class: 'avatar-xl ph' }, '👨‍⚕️'),
        h('h2', {}, d.full_name), h('p', { class: 'muted' }, d.specialty_label, d.license_no ? ` · نظام پزشکی ${d.license_no}` : ''),
        d.experience_years != null ? h('span', { class: 'pill' }, `${fa(d.experience_years)} سال سابقه`) : null),
      h('div', { class: 'card' }, h('h3', {}, 'تحصیلات'), h('p', {}, d.education ?? '—'), h('h3', {}, 'رزومه و معرفی'), h('p', { style: 'white-space:pre-wrap' }, d.bio ?? '—')),
      h('div', { class: 'card' }, h('h3', {}, 'نزدیک‌ترین زمان‌های آزاد'),
        slots.items.length ? h('div', { class: 'slots' }, slots.items.map((s) => h('button', { class: 'slot', onclick: () => x.bookSlot({ ...s, doctor_name: d.full_name }) }, fmt.dt(s.starts_at))))
          : h('p', { class: 'muted' }, 'فعلاً زمان آزادی ندارد.')));
  };

  // ---------------------------------------------------------------- patient: medical documents
  VIEWS.records = async () => {
    const [cats, recs, appts] = await Promise.all([api('GET', '/v1/records/categories'), api('GET', '/v1/records'), api('GET', '/v1/appointments?limit=50')]);
    const usable = appts.items.filter((a) => ['pending', 'confirmed', 'completed'].includes(a.status));
    const form = recordForm(cats.items, usable, () => route('records'));
    const groups = new Map(cats.items.map((c) => [c.code, []]));
    for (const r of recs.items) groups.get(r.category)?.push(r);
    x.$app.append(form,
      ...[...groups].filter(([, items]) => items.length).map(([code, items]) => h('div', { class: 'card' },
        h('h2', {}, `${RECORD_ICONS[code]} ${cats.items.find((c) => c.code === code).label}`),
        h('ul', { class: 'list' }, items.map((r) => h('li', {},
          h('div', { class: 'row' }, h('b', { class: 'grow' }, r.title), h('span', { class: 'muted' }, fmt.short(r.created_at))),
          r.appointment_id ? h('p', { class: 'muted small' }, `ارسال‌شده برای ${usable.find((a) => a.id === r.appointment_id)?.doctor?.full_name ?? 'پزشک'}`) : h('p', { class: 'muted small' }, 'فقط برای خودتان (به نوبتی متصل نیست)'),
          r.note ? h('p', {}, r.note) : null,
          r.lab_rows.length ? h('p', { class: 'small' }, r.lab_rows.map((l) => `${l.name}: ${l.value}${l.unit ? ` ${l.unit}` : ''}`).join(' · ')) : null,
          r.files.length ? h('div', { class: 'thumbs' }, r.files.map(thumb)) : null,
          r.doctor_opinion ? h('div', { class: 'banner info' }, h('b', {}, 'نظر پزشک: '), r.doctor_opinion) : null))))),
      recs.items.length ? null : h('div', { class: 'empty' }, 'هنوز مدرکی ثبت نکرده‌اید.'));
  };

  function recordForm(cats, appts, onDone, presetAppointment = null) {
    let category = 'lab';
    const files = [];
    const rows = h('div');
    const title = h('input', { type: 'text', placeholder: 'مثلاً «آزمایش خون مهر ۱۴۰۵» یا «سونوگرافی شکم»' });
    const note = h('textarea', { rows: 3, placeholder: 'توضیح یا سؤال شما برای پزشک' });
    const apptSel = h('select', {}, h('option', { value: '' }, 'فقط ذخیره برای خودم'),
      appts.map((a) => h('option', { value: a.id, selected: a.id === presetAppointment }, `${a.doctor?.full_name} — ${fmt.short(a.starts_at)}`)));
    const prev = h('div', { class: 'thumbs' });
    const catChips = h('div', { class: 'choices' });
    const labBox = h('div', {});
    const addRow = (v = {}) => rows.append(h('div', { class: `lab-row${v.low_confidence ? ' check' : ''}`, 'data-ocr': v.ocr ? '1' : '' },
      h('input', { type: 'text', placeholder: 'نام آزمایش (مثلاً FBS)', 'data-k': 'name', value: v.name ?? '', dir: v.name ? 'ltr' : 'auto' }),
      h('input', { type: 'text', inputmode: 'decimal', placeholder: 'مقدار', 'data-k': 'value', value: v.value ?? '', dir: 'ltr', title: v.low_confidence ? 'این عدد با اطمینان کم خوانده شد؛ با برگه مقایسه کنید' : '' }),
      h('input', { type: 'text', placeholder: 'واحد', 'data-k': 'unit', value: v.unit ?? '', dir: 'ltr' }), h('input', { type: 'text', placeholder: 'محدوده مرجع (اختیاری)', 'data-k': 'ref', value: v.ref ?? '', dir: 'ltr' }),
      h('button', { type: 'button', class: 'btn small', onclick: (e) => e.currentTarget.parentElement.remove() }, '✕')));
    // Reading values from the photo / PDF (on-server OCR) — the patient must check them.
    let ocrUsed = false;
    const confirmBox = h('input', { type: 'checkbox' });
    const ocrNote = h('div', {});
    const ocrBtn = h('button', { type: 'button', class: 'btn', onclick: guard(async (e) => {
      if (!files.length) throw new Error('ابتدا عکس یا PDF برگه آزمایش را اضافه کنید');
      const btn = e.currentTarget;
      btn.disabled = true; btn.textContent = '⏳ در حال خواندن برگه…';
      try {
        const r = await api('POST', '/v1/records/ocr', { file_ids: files });
        if (!r.rows.length) {
          ocrNote.replaceChildren(h('div', { class: 'banner warn' }, 'مقداری از این فایل خوانده نشد. عکس را صاف، روشن و از نزدیک بگیرید (کل جدول در کادر باشد) یا مقادیر را دستی وارد کنید.'));
          return;
        }
        rows.replaceChildren();
        for (const row of r.rows) addRow({ ...row, ocr: true });
        ocrUsed = true;
        const unsure = r.rows.filter((x) => x.low_confidence).length;
        ocrNote.replaceChildren(h('div', { class: 'banner warn stack' },
          h('b', {}, `${fa(r.rows.length)} مقدار از برگه خوانده شد${unsure ? ` — ${fa(unsure)} مورد زرد را حتماً بررسی کنید` : ''}.`),
          h('span', {}, 'خواندن خودکار ممکن است خطا داشته باشد (مثلاً جا افتادن ممیز). هر عدد را با برگه آزمایش مقایسه و در صورت نیاز اصلاح کنید؛ آزمایش‌هایی که خوانده نشده‌اند را با «+ ردیف» اضافه کنید.'),
          h('label', { class: 'check' }, confirmBox, h('span', {}, 'مقادیر را با برگه آزمایش مقایسه کردم و درست هستند'))));
      } finally {
        btn.disabled = false; btn.textContent = '📷 خواندن خودکار مقادیر از عکس / PDF';
      }
    }) }, '📷 خواندن خودکار مقادیر از عکس / PDF');
    const renderCats = () => {
      catChips.replaceChildren(...cats.map((c) => h('button', { type: 'button', class: `choice${category === c.code ? ' on' : ''}`, onclick: () => { category = c.code; renderCats(); } }, `${RECORD_ICONS[c.code]} ${c.label}`)));
      labBox.replaceChildren(...(category === 'lab' ? [
        h('label', {}, 'مقادیر آزمایش (اختیاری؛ به پزشک برای بررسی سریع‌تر کمک می‌کند)'),
        h('div', { class: 'row' }, ocrBtn, h('span', { class: 'muted small' }, 'پس از افزودن عکس یا PDF برگه آزمایش')),
        ocrNote, rows, h('button', { type: 'button', class: 'btn small', onclick: () => addRow() }, '+ ردیف')] : []));
    };
    addRow();
    renderCats();
    const picker = h('input', { type: 'file', accept: 'image/*,application/pdf', multiple: true, onchange: guard(async (e) => {
      for (const file of [...e.target.files].slice(0, 10 - files.length)) {
        const r = await uploadFile(file, 'medical_record');
        files.push(r.id);
        prev.append(thumb(r));
      }
      e.target.value = '';
    }) });
    const submit = guard(async () => {
      const lab_rows = [...rows.children].map((r) => ({ ...Object.fromEntries([...r.querySelectorAll('input')].map((i) => [i.dataset.k, i.value.trim()])), ocr: r.dataset.ocr === '1' })).filter((r) => r.name && r.value);
      if (category === 'lab' && ocrUsed && lab_rows.some((r) => r.ocr) && !confirmBox.checked) {
        throw new Error('لطفاً مقادیر خوانده‌شده را با برگه آزمایش مقایسه کنید و تیک تأیید را بزنید');
      }
      await api('POST', '/v1/records', { category, title: title.value, note: note.value, file_ids: files, lab_rows: category === 'lab' ? lab_rows : [], appointment_id: apptSel.value || null });
      toast(apptSel.value ? 'مدرک برای پزشک ارسال شد' : 'مدرک ذخیره شد');
      onDone();
    });
    return h('div', { class: 'card stack' }, h('h2', {}, '➕ افزودن / ارسال مدرک پزشکی'),
      h('label', {}, 'نوع مدرک'), catChips,
      h('div', {}, h('label', {}, 'عنوان *'), title),
      h('div', {}, h('label', {}, 'فایل‌ها (عکس یا PDF، حداکثر ۸ مگابایت)'), picker, prev),
      labBox,
      h('div', {}, h('label', {}, 'توضیح'), note),
      h('div', {}, h('label', {}, 'ارسال برای پزشک نوبت'), apptSel),
      h('button', { class: 'btn primary', onclick: submit }, 'ثبت'));
  }
  x.recordForm = recordForm;

  // ---------------------------------------------------------------- visit summary (SOAP)
  const SUMMARY_FIELDS = [
    ['subjective', 'S — شرح حال (گفته‌های بیمار)', 6],
    ['objective', 'O — یافته‌ها (علائم حیاتی، آزمایش، مدارک)', 6],
    ['assessment', 'A — ارزیابی پزشک * (فقط توسط شما نوشته می‌شود)', 3],
    ['plan', 'P — برنامه درمان و نسخه', 4],
    ['advice', 'توصیه‌ها به بیمار', 3],
    ['follow_up', 'پیگیری (مثلاً «دو هفته بعد ویزیت مجدد»)', 1],
  ];
  x.summaryPanel = async (cid, ended) => {
    const card = h('div', { class: 'card stack' });
    const render = (s) => {
      card.replaceChildren(h('div', { class: 'row' }, h('h2', { class: 'grow' }, '📝 خلاصه ویزیت'),
        h('span', { class: `pill ${s.status === 'final' ? 'ok' : 'warn'}` }, s.status === 'final' ? 'نهایی و ارسال‌شده' : s.status === 'draft' ? 'پیش‌نویس' : 'هنوز ایجاد نشده')));
      if (s.status === 'final') {
        for (const [k, label] of SUMMARY_FIELDS) if (s[k]) card.append(h('div', {}, h('label', {}, label.replace(' *', '').replace(/ \(فقط.*\)/, '')), h('div', { class: 'pre' }, s[k])));
        card.append(h('div', {}, h('label', {}, 'متنی که بیمار دریافت کرد'), h('div', { class: 'pre muted' }, s.patient_summary)));
        return;
      }
      if (!ended) {
        // During the visit: only the physician's notes / assessment.
        const a = h('textarea', { rows: 3, placeholder: 'یادداشت و ارزیابی شما؛ پس از پایان ویزیت بقیه خلاصه خودکار ساخته می‌شود' }, s.assessment ?? '');
        card.append(h('p', { class: 'muted' }, 'با پایان ویزیت، پیش‌نویس خلاصه از تریاژ، مدارک، گفتگو و نسخه ساخته می‌شود و شما آن را ویرایش و تأیید می‌کنید.'),
          h('label', {}, 'یادداشت / ارزیابی پزشک'), a,
          h('button', { class: 'btn', onclick: guard(async () => { await api('PUT', `/v1/consultations/${cid}/summary`, { assessment: a.value }); toast('یادداشت ذخیره شد'); }) }, 'ذخیره یادداشت'));
        return;
      }
      const inputs = {};
      card.append(h('div', { class: 'banner info' }, 'پیش‌نویس خودکار از داده‌های ثبت‌شده ساخته شده است. پیش از ارسال بخوانید و اصلاح کنید؛ بخش «ارزیابی» را خودتان بنویسید.',
        s.generator ? h('span', { class: 'muted small' }, ` (${s.generator})`) : null));
      for (const [k, label, rows] of SUMMARY_FIELDS) {
        inputs[k] = rows === 1 ? h('input', { type: 'text', value: s[k] ?? '' }) : h('textarea', { rows }, s[k] ?? '');
        card.append(h('div', {}, h('label', {}, label, s.edited_fields?.includes(k) ? h('span', { class: 'muted small' }, ' · ویرایش‌شده') : null), inputs[k]));
      }
      const share = h('input', { type: 'checkbox', checked: s.share_assessment });
      card.append(h('label', { class: 'check' }, share, h('span', {}, 'ارزیابی من در متن بیمار هم آورده شود')));
      inputs.patient_summary = h('textarea', { rows: 8 }, s.patient_summary ?? '');
      card.append(h('div', {}, h('label', {}, 'متنی که بیمار می‌بیند', s.edited_fields?.includes('patient_summary') ? h('span', { class: 'muted small' }, ' · ویرایش دستی (دیگر خودکار به‌روز نمی‌شود)') : h('span', { class: 'muted small' }, ' · با ذخیره، از روی موارد بالا به‌روز می‌شود')), inputs.patient_summary));
      const body = () => ({ ...Object.fromEntries(Object.entries(inputs).filter(([k, el]) => el.value !== (s[k] ?? '')).map(([k, el]) => [k, el.value])), share_assessment: share.checked });
      const save = async () => render(await api('PUT', `/v1/consultations/${cid}/summary`, body()));
      card.append(h('div', { class: 'row' },
        h('button', { class: 'btn', onclick: guard(async () => { await save(); toast('خلاصه ذخیره شد'); }) }, 'ذخیره'),
        h('button', { class: 'btn', onclick: guard(async () => {
          if (!confirm('پیش‌نویس از داده‌های فعلی دوباره ساخته شود؟ بخش‌هایی که خودتان ویرایش کرده‌اید حفظ می‌شوند.')) return;
          await save();
          render(await api('POST', `/v1/consultations/${cid}/summary/regenerate`, {}));
          toast('پیش‌نویس به‌روز شد');
        }) }, '↻ ساخت دوباره'),
        h('span', { class: 'spacer' }),
        h('button', { class: 'btn primary', onclick: guard(async () => {
          await save();
          let r;
          try {
            r = await api('POST', `/v1/consultations/${cid}/summary/finalize`, {});
          } catch (e) {
            if (e.code !== 'unsigned_prescription' || !confirm(`${e.message}\n\nبدون نسخه امضانشده ثبت شود؟`)) throw e;
            r = await api('POST', `/v1/consultations/${cid}/summary/finalize`, { allow_unsigned: true });
          }
          render(r);
          toast('خلاصه نهایی شد و برای بیمار ارسال شد');
        }) }, '✓ تأیید و ارسال برای بیمار')));
    };
    render(await api('GET', `/v1/consultations/${cid}/summary`));
    return card;
  };

  // Previous finalized summaries of this patient (treating doctor only).
  x.summaryHistory = async (patientId, currentCid) => {
    const r = await api('GET', `/v1/summaries?patient_id=${patientId}`);
    const items = r.items.filter((s) => s.consultation_id !== currentCid);
    if (!items.length) return h('div');
    return h('div', { class: 'card' }, h('h2', {}, '🗂️ خلاصه ویزیت‌های قبلی'),
      h('ul', { class: 'list' }, items.map((s) => h('li', {},
        h('details', {}, h('summary', {}, h('b', {}, s.doctor_name ?? ''), ' ', h('span', { class: 'muted' }, `${s.specialty_label ?? ''} · ${fmt.short(s.finalized_at)}`)),
          s.assessment ? h('div', {}, h('label', {}, 'ارزیابی'), h('div', { class: 'pre' }, s.assessment)) : null,
          s.plan ? h('div', {}, h('label', {}, 'برنامه'), h('div', { class: 'pre' }, s.plan)) : null,
          s.follow_up ? h('div', {}, h('label', {}, 'پیگیری'), h('div', {}, s.follow_up)) : null)))));
  };

  // Patient: the finalized plain-language summary.
  VIEWS.summary = async (cid) => {
    const back = h('button', { class: 'btn small', onclick: () => route('appointments') }, '→ بازگشت');
    let s;
    try {
      s = await api('GET', `/v1/consultations/${cid}/summary`);
    } catch {
      x.$app.append(back, h('div', { class: 'card empty' }, 'خلاصه این ویزیت هنوز توسط پزشک نهایی نشده است.'));
      return;
    }
    x.$app.append(h('div', { class: 'row', style: 'margin-bottom:10px' }, back),
      h('div', { class: 'card stack' }, h('h2', {}, '📝 خلاصه ویزیت'),
        h('p', { class: 'muted' }, `${s.doctor_name ?? ''}${s.specialty_label ? ` · ${s.specialty_label}` : ''} · ${fmt.short(s.finalized_at)}`),
        h('div', { class: 'pre' }, s.patient_summary),
        h('div', { class: 'row' },
          h('button', { class: 'btn', onclick: () => route('prescriptions') }, '💊 نسخه‌ها'),
          h('button', { class: 'btn', onclick: () => window.print() }, '🖨️ چاپ'))));
  };

  // ---------------------------------------------------------------- doctor: records in the visit
  x.doctorRecords = async (appointmentId) => {
    const r = await api('GET', `/v1/records?appointment_id=${appointmentId}`);
    const card = h('div', { class: 'card' }, h('h2', {}, 'مدارک ارسالی بیمار'));
    if (!r.items.length) { card.append(h('p', { class: 'muted' }, 'بیمار هنوز مدرکی ارسال نکرده است.')); return card; }
    for (const rec of r.items) {
      const aiBox = h('div', {}, rec.ai_review ? aiView(rec.ai_review) : null);
      const opinion = h('textarea', { rows: 3, placeholder: 'نظر نهایی شما برای بیمار' }, rec.doctor_opinion ?? '');
      card.append(h('div', { class: 'record' },
        h('div', { class: 'row' }, h('b', { class: 'grow' }, `${RECORD_ICONS[rec.category]} ${rec.category_label}: ${rec.title}`), h('span', { class: 'muted' }, fmt.short(rec.created_at))),
        rec.note ? h('p', {}, rec.note) : null,
        rec.lab_rows.length ? h('table', {}, h('tbody', {}, rec.lab_rows.map((l) => h('tr', {}, h('td', {}, l.name), h('td', { class: 'ltr' }, `${l.value} ${l.unit}`), h('td', { class: 'ltr' }, l.ref))))) : null,
        rec.lab_rows.some((l) => l.ocr) ? h('p', { class: 'muted small' }, '📷 بخشی از مقادیر به‌طور خودکار از عکس برگه خوانده و توسط بیمار تأیید شده است؛ در صورت تردید با تصویر پیوست مقایسه کنید.') : null,
        rec.files.length ? h('div', { class: 'thumbs' }, rec.files.map(thumb)) : null,
        h('button', { class: 'btn small', onclick: guard(async (e) => {
          e.currentTarget.disabled = true;
          const u = await api('POST', `/v1/records/${rec.id}/ai-review`, {});
          aiBox.replaceChildren(aiView(u.ai_review));
        }) }, '🤖 تفسیر اولیه دستیار هوش مصنوعی'),
        aiBox,
        h('label', {}, 'نظر نهایی پزشک'), opinion,
        h('button', { class: 'btn primary small', onclick: guard(async () => { await api('POST', `/v1/records/${rec.id}/opinion`, { opinion: opinion.value }); toast('نظر شما برای بیمار ارسال شد'); }) }, 'ثبت و ارسال نظر')));
    }
    return card;
  };
  const aiView = (rv) => h('div', { class: 'banner warn ai-review' }, h('b', {}, '🤖 پیش‌نویس دستیار (فقط برای پزشک): '), h('div', { style: 'white-space:pre-wrap' }, rv.text), h('p', { class: 'small' }, rv.disclaimer));

}
