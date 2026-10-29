import { jalaliPicker, todayJalali, formatJalaliDate, toGregorian } from './jalali.js';
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
  // Documents open inside the app with a back button (in the Android app a plain link replaced the
  // whole app with the picture and left no way back). The phone's back key closes the viewer too.
  // PDFs: system browser in the app (the WebView cannot show them), new tab on the web.
  function openFile(url, mime = '', title = 'مشاهده مدرک') {
    if (mime === 'application/pdf' || /\.pdf($|\?)/i.test(url)) {
      if (IS_NATIVE) location.href = url; else window.open(url, '_blank', 'noopener');
      return;
    }
    const img = h('img', { src: url, alt: title });
    const s = sheet(title, img, { zoom: true });
    img.onclick = () => s.box.classList.toggle('zoomed');
  }
  x.openFile = openFile;

  // Full-screen page over the current view with a back button; the phone's back key closes it.
  // Returns { box, body, back }.
  function sheet(title, content, { zoom = false, cls = '' } = {}) {
    let closed = false;
    const depth = (Number(history.state?.viewer) || 0) + 1; // sheets can open over sheets
    const close = () => {
      if (closed) return;
      closed = true;
      window.removeEventListener('popstate', onPop);
      box.remove();
      if (!document.querySelector('.viewer')) document.body.classList.remove('viewer-open');
    };
    const onPop = () => { if ((Number(history.state?.viewer) || 0) < depth) close(); };
    const back = () => { if (history.state?.viewer === depth) history.back(); else close(); };
    const body = h('div', { class: `viewer-body ${cls}`, onclick: zoom ? (e) => { if (e.target === e.currentTarget) back(); } : null }, content);
    const box = h('div', { class: 'viewer', role: 'dialog', 'aria-modal': 'true', 'aria-label': title },
      h('div', { class: 'viewer-bar' },
        h('button', { class: 'btn small', type: 'button', onclick: back }, '→ بازگشت'),
        h('b', {}, title),
        zoom ? h('button', { class: 'btn small', type: 'button', onclick: () => box.classList.toggle('zoomed') }, 'بزرگ‌نمایی') : h('span', { style: 'width:72px' })),
      body);
    window.addEventListener('popstate', onPop);
    history.pushState({ ...(history.state ?? {}), viewer: depth }, '');
    document.body.classList.add('viewer-open');
    document.body.append(box);
    return { box, body, back };
  }
  x.sheet = sheet;
  const fileLink = (url, mime, title, ...children) => h('a', {
    href: url, target: '_blank', onclick: (e) => { e.preventDefault(); openFile(url, mime, title); },
  }, ...children);
  const thumb = (f) => (f.mime === 'application/pdf'
    ? h('a', { class: 'thumb pdf', href: fileUrl(f.url), target: '_blank', onclick: (e) => { e.preventDefault(); openFile(fileUrl(f.url), f.mime); } }, '📄 PDF')
    : fileLink(fileUrl(f.url), f.mime, 'مشاهده مدرک', h('img', { class: 'thumb', src: fileUrl(f.url), alt: '' })));

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
    const cardPrev = h('div', { class: 'upload-prev' }, d.license_card_url ? fileLink(fileUrl(d.license_card_url), '', 'کارت نظام پزشکی', '✓ کارت نظام پزشکی بارگذاری شده — مشاهده') : 'فایلی انتخاب نشده');
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
      approved: d.contract_required && !d.contract_signed_at
        ? h('div', { class: 'banner warn row' }, h('span', { class: 'grow' }, '✅ مدارک شما تأیید شد. برای فعال شدن نوبت‌دهی و نمایش در فهرست پزشکان، قرارداد همکاری را تکمیل و امضا کنید.'),
          h('button', { class: 'btn primary small', onclick: () => route('doctor-contract') }, 'قرارداد همکاری'))
        : h('div', { class: 'banner info' }, '✅ پروفایل شما تأیید شده و در فهرست پزشکان نمایش داده می‌شود. نام، تخصص، شماره و کارت نظام پزشکی فقط با درخواست به مدیر تغییر می‌کند.'),
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
          approved ? null : h('button', { class: 'btn primary', onclick: guard(async () => { await save(); await api('POST', '/v1/doctors/me/submit', {}); toast('برای بررسی ارسال شد'); route('doctor-profile'); }) }, 'ذخیره و ارسال برای بررسی'))),
      approved ? publicProfileCard(d) : null);
  };

  // Public page on the website (search engines): off until the doctor explicitly turns it on.
  function publicProfileCard(d) {
    const ready = !(d.contract_required && !d.contract_signed_at);
    const enabled = h('input', { type: 'checkbox', checked: d.public_profile, disabled: !ready });
    const license = h('input', { type: 'checkbox', checked: d.public_show_license, disabled: !ready });
    const url = d.public_url ? apiUrl(d.public_url) : null;
    return h('div', { class: 'card stack' },
      h('h3', {}, 'صفحه عمومی در وب‌سایت'),
      h('p', { class: 'muted' }, 'با فعال کردن این گزینه، صفحه‌ای با نام، تخصص، عکس، رزومه، سابقه کار و زمان‌های آزاد شما در وب‌سایت درمان پلاس منتشر می‌شود که موتورهای جست‌وجو هم آن را می‌بینند. شماره موبایل، کد ملی، شماره حساب و اطلاعات بیماران هرگز در این صفحه نمایش داده نمی‌شود. هر زمان بخواهید می‌توانید آن را خاموش کنید.'),
      ready ? null : h('div', { class: 'banner warn' }, 'این گزینه پس از امضای قرارداد همکاری فعال می‌شود.'),
      h('label', { class: 'row' }, enabled, h('span', {}, 'با انتشار صفحه عمومی خود موافقم')),
      h('label', { class: 'row' }, license, h('span', {}, 'شماره نظام پزشکی هم نمایش داده شود')),
      url ? h('p', {}, 'نشانی صفحه شما: ', h('a', { href: url, target: '_blank', rel: 'noopener', dir: 'ltr' }, url)) : null,
      h('div', { class: 'row' }, h('button', { class: 'btn primary', disabled: !ready, onclick: guard(async () => {
        await api('PUT', '/v1/doctors/me/public-profile', { enabled: enabled.checked, show_license: license.checked });
        toast(enabled.checked ? 'صفحه عمومی فعال شد' : 'صفحه عمومی خاموش شد');
        route('doctor-profile');
      }) }, 'ذخیره تنظیمات صفحه عمومی')));
  }

  // ---------------------------------------------------------------- cooperation agreement
  // Signature drawn with finger or mouse; returns { el, isEmpty, toDataURL, clear }.
  function signaturePad() {
    const canvas = h('canvas', { class: 'sig-pad', width: 600, height: 220, 'aria-label': 'کادر امضا' });
    const g = canvas.getContext('2d');
    const reset = () => { g.fillStyle = '#fff'; g.fillRect(0, 0, canvas.width, canvas.height); g.strokeStyle = '#0d2b55'; g.lineWidth = 3.2; g.lineCap = 'round'; g.lineJoin = 'round'; };
    reset();
    let drawing = false; let strokes = 0;
    const pos = (e) => { const r = canvas.getBoundingClientRect(); return [(e.clientX - r.left) * (canvas.width / r.width), (e.clientY - r.top) * (canvas.height / r.height)]; };
    canvas.addEventListener('pointerdown', (e) => { drawing = true; strokes++; canvas.setPointerCapture(e.pointerId); const [px, py] = pos(e); g.beginPath(); g.moveTo(px, py); g.lineTo(px + 0.1, py + 0.1); g.stroke(); });
    canvas.addEventListener('pointermove', (e) => { if (!drawing) return; const [px, py] = pos(e); g.lineTo(px, py); g.stroke(); });
    const stop = () => { drawing = false; };
    canvas.addEventListener('pointerup', stop); canvas.addEventListener('pointercancel', stop);
    const clear = () => { strokes = 0; reset(); };
    const el = h('div', { class: 'sig-wrap' }, canvas, h('div', { class: 'row', style: 'justify-content:space-between' },
      h('span', { class: 'muted small' }, 'امضای خود را با انگشت یا ماوس در کادر بالا رسم کنید.'),
      h('button', { class: 'btn small', type: 'button', onclick: clear }, 'پاک کردن امضا')));
    return { el, clear, isEmpty: () => strokes === 0, toDataURL: () => canvas.toDataURL('image/png') };
  }

  // The agreement text with both signature boxes.
  function contractDoc(c, { address = null } = {}) {
    const k = c.contract;
    const sigBox = (title, name, img, at) => h('div', { class: 'sig-box' }, h('b', {}, title), h('div', {}, name || '—'),
      img ? h('img', { src: img, alt: `امضای ${title}` }) : h('div', { class: 'sig-empty' }, 'امضا نشده'),
      h('div', { class: 'muted small' }, at ? `تاریخ امضا: ${fmt.dt(at)}` : ''));
    const doctorName = /دکتر\s+(.+?)،/.exec(k.preamble[2])?.[1];
    return h('article', { class: 'contract-doc legal' },
      h('h2', { style: 'text-align:center' }, k.title),
      k.preamble.map((p, i) => h('p', {}, i === 2 && address ? p.replace(/نشانی حرفه‌ای …………… /, `نشانی حرفه‌ای ${address} `) : p)),
      k.articles.map((a) => h('section', {}, h('h3', {}, a.h), a.items.map((it) => h('p', {}, it)))),
      h('section', {}, h('h3', {}, k.annex.h), h('ul', {}, k.annex.items.map((it) => h('li', {}, it)))),
      h('p', {}, k.closing),
      h('div', { class: 'sig-row' },
        sigBox('طرف اول — پلتفرم', `شرکت رایان افزار پژوه${c.platform_signer ? ` (${c.platform_signer})` : ''}`, c.platform_signature, c.platform_signed_at),
        sigBox('طرف دوم — پزشک', doctorName ? `دکتر ${doctorName}` : '', c.doctor_signature, c.doctor_signed_at)),
      h('p', { class: 'muted small' }, `نسخه متن قرارداد: ${fa(k.version)}`));
  }
  const CONTRACT_STATUS = { awaiting_doctor: ['منتظر امضای پزشک', 'warn'], optional: ['امضا نشده', 'warn'], pending_platform: ['امضای پزشک ثبت شد — منتظر امضای پلتفرم', 'info'], active: ['امضاشده توسط طرفین', 'ok'], not_available: ['پس از تأیید مدارک', ''] };
  const printContract = () => { document.body.classList.add('print-contract'); window.print(); setTimeout(() => document.body.classList.remove('print-contract'), 500); };

  VIEWS['doctor-contract'] = async () => {
    const c = await api('GET', '/v1/doctors/me/contract');
    const [label, tone] = CONTRACT_STATUS[c.status] ?? [c.status, ''];
    const head = h('div', { class: 'card' }, h('div', { class: 'row' }, h('h2', { class: 'grow' }, 'قرارداد همکاری با درمان پلاس'), h('span', { class: `pill ${tone}` }, label)));
    if (c.status === 'not_available') {
      head.append(h('p', { class: 'muted' }, 'قرارداد همکاری پس از تأیید مدارک شما توسط مدیر سامانه در این بخش در دسترس قرار می‌گیرد.'));
      x.$app.append(head);
      return;
    }
    if (['pending_platform', 'active'].includes(c.status)) {
      head.append(h('p', { class: 'muted' }, c.status === 'active' ? 'قرارداد به امضای هر دو طرف رسیده است.' : 'امضای شما ثبت شد و نوبت‌دهی شما فعال است. پس از امضای نماینده پلتفرم به شما اعلان می‌شود.'),
        h('button', { class: 'btn small', onclick: printContract }, '🖨 چاپ / ذخیره PDF'));
      x.$app.append(head, h('div', { class: 'card' }, contractDoc(c)));
      return;
    }
    // Fill in, read, sign.
    const address = h('input', { type: 'text', maxlength: 300, placeholder: 'مثلاً تهران، خیابان ولیعصر، ساختمان پزشکان، طبقه ۳، واحد ۱۲' });
    const accept = h('input', { type: 'checkbox' });
    const pad = signaturePad();
    const docBox = h('div', {}, contractDoc(c));
    address.oninput = () => docBox.replaceChildren(contractDoc(c, { address: address.value.trim() || null }));
    head.append(h('div', { class: 'banner info' }, 'مدارک شما تأیید شده است. لطفاً قرارداد را مطالعه کنید، نشانی حرفه‌ای را وارد و قرارداد را امضا کنید. پس از امضا، نوبت‌دهی شما فعال می‌شود.'));
    x.$app.append(head,
      h('div', { class: 'card' }, docBox),
      h('div', { class: 'card stack' },
        h('h3', {}, 'تکمیل و امضای قرارداد'),
        h('div', {}, h('label', {}, 'نشانی حرفه‌ای (مطب یا مرکز درمانی) *'), address),
        h('label', { class: 'check' }, accept, h('span', {}, 'متن کامل قرارداد و پیوست مالی را مطالعه کرده‌ام و با امضای الکترونیکی زیر، مفاد آن را می‌پذیرم.')),
        h('label', {}, 'امضای پزشک *'), pad.el,
        h('button', { class: 'btn primary', onclick: guard(async (e) => {
          if (address.value.trim().length < 10) return toast('نشانی حرفه‌ای را کامل بنویسید', true);
          if (!accept.checked) return toast('پذیرش متن قرارداد را تأیید کنید', true);
          if (pad.isEmpty()) return toast('امضای خود را در کادر رسم کنید', true);
          e.currentTarget.disabled = true;
          try {
            await api('POST', '/v1/doctors/me/contract/sign', { address: address.value.trim(), accept: true, signature: pad.toDataURL() });
          } finally { e.currentTarget.disabled = false; }
          const s = x.getSession();
          x.setSession({ ...s, user: { ...s.user, doctor_contract_pending: false } });
          toast('قرارداد امضا شد؛ نوبت‌دهی شما فعال است');
          route('doctor-contract');
        }) }, 'امضا و ارسال قرارداد')));
  };

  // Credential reviewer: the doctor's agreement and the platform's signature.
  async function adminContractCard(id) {
    const c = await api('GET', `/v1/admin/doctors/${id}/contract`).catch(() => null);
    if (!c || c.status === 'not_available') return null;
    const [label, tone] = CONTRACT_STATUS[c.status] ?? [c.status, ''];
    const card = h('div', { class: 'card stack' }, h('div', { class: 'row' }, h('h2', { class: 'grow' }, 'قرارداد همکاری'), h('span', { class: `pill ${tone}` }, label)));
    if (!['pending_platform', 'active'].includes(c.status)) {
      card.append(h('p', { class: 'muted' }, 'پزشک هنوز قرارداد را امضا نکرده است.'));
      return card;
    }
    card.append(h('details', {}, h('summary', {}, 'مشاهده متن قرارداد امضاشده'), contractDoc(c)),
      h('p', { class: 'muted small' }, `امضای پزشک: ${fmt.dt(c.doctor_signed_at)}${c.doctor_sign_ip ? ` — IP ${c.doctor_sign_ip}` : ''}`));
    if (c.status === 'pending_platform') {
      const pad = signaturePad();
      card.append(h('label', {}, 'امضای نماینده پلتفرم'), pad.el,
        h('button', { class: 'btn primary', onclick: guard(async () => {
          if (pad.isEmpty()) return toast('امضا را در کادر رسم کنید', true);
          await api('POST', `/v1/admin/doctors/${id}/contract/countersign`, { signature: pad.toDataURL() });
          toast('قرارداد به امضای پلتفرم رسید'); route('admin-doctors', id);
        }) }, 'امضای قرارداد از طرف پلتفرم'));
    } else {
      card.append(h('button', { class: 'btn small', onclick: () => { card.querySelector('details').open = true; printContract(); } }, '🖨 چاپ / ذخیره PDF'));
    }
    return card;
  }

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
        d.license_card_url ? fileLink(fileUrl(d.license_card_url), '', 'کارت نظام پزشکی', h('img', { class: 'card-img', src: fileUrl(d.license_card_url), alt: 'کارت نظام پزشکی', onerror: (e) => { e.target.replaceWith('📄 مشاهده فایل PDF'); } })) : h('p', {}, '—'),
        h('p', { class: 'muted' }, 'شماره نظام پزشکی را با سامانه سازمان نظام پزشکی تطبیق دهید.')),
      d.status === 'pending_review' || d.status === 'approved' ? h('div', { class: 'card stack' },
        d.status === 'pending_review' ? h('button', { class: 'btn primary', onclick: guard(async () => { await api('POST', `/v1/admin/doctors/${id}/approve`, {}); toast('پزشک تأیید شد'); route('admin-doctors'); }) }, '✅ تأیید و افزودن به فهرست پزشکان') : null,
        reason,
        h('button', { class: 'btn danger', onclick: guard(async () => { await api('POST', `/v1/admin/doctors/${id}/reject`, { reason: reason.value }); toast('نتیجه برای پزشک ارسال شد'); route('admin-doctors'); }) }, d.status === 'approved' ? 'لغو تأیید با ذکر دلیل' : 'رد با ذکر دلیل')) : null);
    if (d.status === 'approved') { const cc = await adminContractCard(id); if (cc) x.$app.append(cc); }
  }

  // ---------------------------------------------------------------- admin: settings & payments
  VIEWS.settings = async () => {
    const s = await api('GET', '/v1/admin/settings');
    // Visit length: the durations doctors may pick when publishing their calendar.
    const DUR_CHOICES = [10, 15, 20, 25, 30, 40, 45, 60, 90];
    const durBoxes = DUR_CHOICES.map((m) => h('input', { type: 'checkbox', value: m, checked: s.visit.durations.includes(m) }));
    const durDefault = h('select');
    const syncDefault = () => {
      const on = durBoxes.filter((b) => b.checked).map((b) => Number(b.value));
      const cur = Number(durDefault.value || s.visit.default);
      durDefault.replaceChildren(...on.map((m) => h('option', { value: m, selected: m === cur }, `${fa(m)} دقیقه`)));
    };
    durBoxes.forEach((b) => { b.onchange = syncDefault; });
    const joinEarly = h('select', {}, [0, 5, 10, 15, 20, 30].map((m) => h('option', { value: m, selected: m === (s.visit.join_early_min ?? 10) }, m ? `${fa(m)} دقیقه قبل` : 'سر ساعت')));
    const supportAlert = h('select', {}, [...new Set([0, 10, 15, 30, 60, 120, s.support?.alert_minutes ?? 30])].sort((a, b) => a - b)
      .map((n) => h('option', { value: n, selected: n === (s.support?.alert_minutes ?? 30) }, n ? `پس از ${fa(n)} دقیقه بی‌پاسخ ماندن` : 'هشدار نده')));
    const refundHours = h('select', {}, [...new Set([0, 2, 6, 12, 24, 48, 72, s.visit.cancel_refund_hours ?? 24])].sort((a, b) => a - b)
      .map((n) => h('option', { value: n, selected: n === (s.visit.cancel_refund_hours ?? 24) }, n ? `تا ${fa(n)} ساعت قبل از ویزیت` : 'تا زمان شروع ویزیت')));
    syncDefault();
    x.$app.append(h('div', { class: 'card stack' },
      h('h2', {}, 'مدت زمان ویزیت'),
      h('p', { class: 'muted' }, 'پزشکان هنگام انتشار تقویم فقط از مدت‌های انتخاب‌شده می‌توانند استفاده کنند. اگر فقط یک مدت انتخاب کنید، همه نوبت‌ها با همان مدت ساخته می‌شوند. نوبت‌های قبلاً منتشرشده تغییر نمی‌کنند.'),
      h('div', { class: 'row', style: 'flex-wrap:wrap;gap:6px 16px' }, durBoxes.map((b) => h('label', { class: 'row', style: 'gap:6px;align-items:center' }, b, `${fa(b.value)} دقیقه`))),
      h('div', {}, h('label', {}, 'مدت پیش‌فرض'), durDefault),
      h('div', {}, h('label', {}, 'باز شدن اتاق ویزیت (نسبت به ساعت نوبت)'), joinEarly,
        h('p', { class: 'muted small' }, 'بیمار و پزشک از این زمان تا ۳۰ دقیقه بعد از پایان نوبت می‌توانند وارد اتاق ویزیت شوند. در همین زمان برای هر دو اعلان «اتاق ویزیت باز شد» ارسال می‌شود؛ یک ساعت قبل هم یادآوری ارسال می‌شود.')),
      h('div', {}, h('label', {}, 'هشدار تأخیر پشتیبانی'), supportAlert,
        h('p', { class: 'muted small' }, 'گفتگوی پشتیبانی که این مدت بی‌پاسخ بماند، به سرپرستان پشتیبانی (دارای دسترسی «گزارش عملکرد پشتیبانی») و کارشناس مسئول اعلان می‌شود.')),
      h('div', {}, h('label', {}, 'مهلت لغو یا جابه‌جایی با بازگشت وجه'), refundHours,
        h('p', { class: 'muted small' }, 'اگر بیمار تا این زمان نوبت پرداخت‌شده را لغو کند، هزینه بازگردانده می‌شود؛ بعد از آن بازگردانده نمی‌شود. اگر پزشک یا کلینیک نوبت را لغو کند، بیمار بین انتخاب زمان دیگر (بدون پرداخت مجدد) و بازگشت کامل وجه انتخاب می‌کند.')),
      h('button', { class: 'btn primary', onclick: guard(async () => {
        const durations = durBoxes.filter((b) => b.checked).map((b) => Number(b.value));
        if (!durations.length) { toast('حداقل یک مدت را انتخاب کنید'); return; }
        await api('PUT', '/v1/admin/settings', { visit: { durations, default: Number(durDefault.value), join_early_min: Number(joinEarly.value), cancel_refund_hours: Number(refundHours.value) }, support: { alert_minutes: Number(supportAlert.value) } });
        toast('مدت زمان ویزیت ذخیره شد');
      }) }, 'ذخیره مدت ویزیت')));
    const inputs = Object.fromEntries(Object.keys(s.tariffs).map((k) => [k, h('input', { type: 'number', min: 0, step: 1000, value: Math.round(s.tariffs[k] / 10) })]));
    const enabled = h('input', { type: 'checkbox', checked: s.payments_enabled });
    const commission = h('input', { type: 'number', min: 0, max: 100, step: 0.5, value: s.commission_percent ?? 0, dir: 'ltr' });
    const commissionHint = h('p', { class: 'muted small' });
    const showSplit = () => {
      const v = Number(inputs.visit_video?.value || 0);
      const pc = Number(commission.value || 0);
      commissionHint.textContent = v ? `مثال: از ویزیت تصویری ${fa(v.toLocaleString('en-US'))} تومانی، سهم پلتفرم ${fa(Math.round(v * pc / 100).toLocaleString('en-US'))} و سهم پزشک ${fa(Math.round(v - v * pc / 100).toLocaleString('en-US'))} تومان.` : '';
    };
    commission.oninput = showSplit;
    const note = h('div', { class: 'banner warn' }, 'حالت آزمایشی: از بیماران هیچ هزینه‌ای گرفته نمی‌شود؛ نوبت‌ها بلافاصله قطعی و تریاژ رایگان است. مبالغ زیر حفظ می‌شوند.');
    const sync = () => { note.style.display = enabled.checked ? 'none' : ''; };
    queueMicrotask(showSplit);
    enabled.onchange = sync; sync();
    x.$app.append(h('div', { class: 'card stack' },
      h('h2', {}, 'تعرفه خدمات'),
      h('label', { class: 'row', style: 'gap:8px;align-items:center;font-weight:700' }, enabled, 'دریافت هزینه از بیماران فعال است'),
      note,
      h('p', { class: 'muted' }, 'مبالغ به تومان. صفر یعنی خدمت رایگان است. حداقل مبلغ قابل پرداخت در درگاه ۱٬۰۰۰ تومان است.'),
      h('div', { class: 'grid2' }, Object.entries(inputs).map(([k, el]) => h('div', {}, h('label', {}, s.labels[k]), el))),
      h('div', {}, h('label', {}, 'سهم پلتفرم از هزینه ویزیت (درصد)'), commission, commissionHint,
        h('p', { class: 'muted small' }, 'سهم پلتفرم و پزشک هنگام ایجاد هر پرداخت ثبت می‌شود؛ تغییر درصد روی پرداخت‌های قبلی اثری ندارد. هزینه تریاژ کامل به پلتفرم تعلق دارد.')),
      h('div', { class: `banner ${s.gateway === 'zarinpal' ? 'info' : 'warn'}` },
        s.gateway === 'zarinpal' ? `درگاه: زرین‌پال${s.sandbox ? ' (محیط آزمایشی sandbox)' : ''}` : 'درگاه زرین‌پال تنظیم نشده؛ پرداخت‌ها با درگاه آزمایشی شبیه‌سازی می‌شوند (ZARINPAL_MERCHANT_ID را روی سرور تنظیم کنید).'),
      h('button', { class: 'btn primary', onclick: guard(async () => {
        const tariffs = Object.fromEntries(Object.entries(inputs).map(([k, el]) => [k, Math.round(Number(el.value || 0)) * 10]));
        await api('PUT', '/v1/admin/settings', { tariffs, payments_enabled: enabled.checked, commission_percent: Number(commission.value || 0) });
        toast(enabled.checked ? 'تعرفه‌ها ذخیره شد' : 'ذخیره شد — پرداخت بیماران غیرفعال است');
      }) }, 'ذخیره تعرفه‌ها')));
  };

  // ---------------------------------------------------------------- accounting (clinic + doctor)
  const T = (rial) => `${toman(rial ?? 0)} تومان`;
  const STATE_FA = { earned: ['انجام‌شده', 'ok'], pending: ['در انتظار ویزیت', 'warn'], refund: ['بازگشت وجه', 'danger'] };
  const CH_FA = { video: 'تصویری', audio: 'صوتی', chat: 'متنی' };
  const tile = (label, value, cls = '') => h('div', { class: `card stat-tile ${cls}` }, h('div', { class: 'muted small' }, label), h('div', { class: 'stat' }, value));
  const isoDay = (d) => d.toISOString().slice(0, 10);
  // Period presets in Jalali months (start of the current Jalali month etc.).
  function periodPicker(onChange, initial = 'month') {
    const today = new Date();
    const j = todayJalali();
    const jStart = (jy, jm) => { const g = toGregorian(jy, jm, 1); return new Date(Date.UTC(g.gy, g.gm - 1, g.gd)); };
    const prev = j.jm === 1 ? [j.jy - 1, 12] : [j.jy, j.jm - 1];
    const presets = {
      month: ['این ماه', isoDay(jStart(j.jy, j.jm)), isoDay(today)],
      last: ['ماه قبل', isoDay(jStart(...prev)), isoDay(new Date(jStart(j.jy, j.jm) - 864e5))],
      year: ['امسال', isoDay(jStart(j.jy, 1)), isoDay(today)],
      all: ['همه', '', ''],
    };
    const box = h('div', { class: 'choices' });
    const pick = (k) => {
      box.querySelectorAll('.choice').forEach((b) => b.classList.toggle('on', b.dataset.k === k));
      onChange({ from: presets[k][1], to: presets[k][2], label: presets[k][0] });
    };
    for (const [k, [label]] of Object.entries(presets)) box.append(h('button', { type: 'button', class: 'choice', 'data-k': k, onclick: () => pick(k) }, label));
    queueMicrotask(() => pick(initial));
    return box;
  }
  const qs = (p) => new URLSearchParams(Object.entries(p).filter(([, v]) => v)).toString();

  VIEWS.accounting = async () => {
    const me = x.getSession().user;
    const canPay = (me.permissions ?? []).includes('accounting.payout');
    const body = h('div', { class: 'stack' });
    let period = { from: '', to: '' };
    const load = guard(async () => {
      const r = await api('GET', `/v1/admin/accounting?${qs({ from: period.from, to: period.to })}`);
      const t = r.totals;
      body.replaceChildren(
        h('div', { class: 'grid2' },
          tile('کل دریافتی (ویزیت + تریاژ)', T(t.gross_received)),
          tile('درآمد پلتفرم (کمیسیون + تریاژ)', T(t.platform_income), 'ok'),
          tile('سهم پزشکان از ویزیت‌های انجام‌شده', T(t.doctors_share_earned)),
          tile('سهم پزشکان — ویزیت‌های پیش رو', T(t.doctors_share_pending)),
          tile('تسویه‌شده با پزشکان در این بازه', T(t.payouts)),
          tile('مانده بدهی به پزشکان (کل)', T(t.doctors_balance_all_time), t.doctors_balance_all_time ? 'warn' : ''),
          tile(`بازگشت وجه در انتظار (${fa(t.refunds_due.count)} مورد)`, T(t.refunds_due.amount), t.refunds_due.count ? 'danger' : '')),
        h('div', { class: 'card' }, h('h3', {}, 'ماهانه (تقویم شمسی)'),
          r.months.length ? h('div', { style: 'overflow-x:auto' }, h('table', { class: 'nowrap' },
            h('thead', {}, h('tr', {}, ['ماه', 'دریافتی', 'کمیسیون', 'تریاژ', 'سهم پزشکان', 'تسویه'].map((c) => h('th', {}, c)))),
            h('tbody', {}, r.months.map((m) => h('tr', {}, h('td', {}, fa(m.month)), h('td', {}, toman(m.gross)), h('td', {}, toman(m.platform)), h('td', {}, toman(m.triage)), h('td', {}, toman(m.doctors)), h('td', {}, toman(m.payouts))))))) : h('div', { class: 'empty' }, '—')),
        h('div', { class: 'card' }, h('h3', {}, 'حساب پزشکان (کل دوره)'),
          r.doctors.length ? h('ul', { class: 'list' }, r.doctors.map((d) => h('li', { class: 'stack' },
            h('div', { class: 'row' }, h('b', { class: 'grow' }, d.full_name), h('span', { class: `pill ${d.balance > 0 ? 'warn' : 'ok'}` }, `مانده: ${T(d.balance)}`)),
            h('div', { class: 'muted small' }, `کارکرد: ${T(d.earned)} · در انتظار ویزیت: ${T(d.pending)} · تسویه‌شده: ${T(d.paid_out)} · شبا: ${d.sheba ?? 'ثبت نشده'}`),
            h('div', { class: 'row' },
              h('button', { class: 'btn small', onclick: () => doctorDetail(d) }, 'جزئیات'),
              canPay && d.balance > 0 ? h('button', { class: 'btn small primary', onclick: () => payoutForm(d) }, 'ثبت تسویه') : null)))) : h('div', { class: 'empty' }, 'هنوز ویزیت پرداخت‌شده‌ای ثبت نشده است.')),
        h('div', { class: 'row' }, h('button', { class: 'btn', onclick: guard(async () => {
          const res = await fetch(apiUrl(`/v1/admin/accounting/export?${qs({ from: period.from, to: period.to })}`), { headers: { Authorization: `Bearer ${x.getSession().access_token}` } });
          if (!res.ok) throw new Error('دریافت فایل ناموفق بود');
          const a = h('a', { href: URL.createObjectURL(await res.blob()), download: `accounting-${period.from || 'all'}.csv` });
          document.body.append(a); a.click(); a.remove();
        }) }, '⬇️ خروجی اکسل (CSV)')));
    });
    const detailBox = h('div');
    async function doctorDetail(d) {
      const r = await api('GET', `/v1/admin/accounting/doctors/${d.doctor_id}?${qs({ from: period.from, to: period.to })}`);
      detailBox.replaceChildren(h('div', { class: 'card stack' }, h('div', { class: 'row' }, h('h3', { class: 'grow' }, `جزئیات: ${r.full_name}`), h('button', { class: 'btn small', onclick: () => detailBox.replaceChildren() }, '✕')),
        h('p', { class: 'small' }, `شبا: `, h('span', { class: 'ltr' }, r.sheba ?? 'ثبت نشده')),
        visitsTable(r.items), payoutsList(r.payouts)));
      detailBox.scrollIntoView({ behavior: 'smooth' });
    }
    function payoutForm(d) {
      const amount = h('input', { type: 'number', min: 1, step: 1, value: Math.floor(d.balance / 10), dir: 'ltr' });
      const ref = h('input', { type: 'text', dir: 'ltr', placeholder: 'شماره پیگیری پایا/ساتنا' });
      const note = h('input', { type: 'text', placeholder: 'توضیح (اختیاری)' });
      detailBox.replaceChildren(h('div', { class: 'card stack' }, h('h3', {}, `ثبت تسویه با ${d.full_name}`),
        h('p', { class: 'muted small' }, `مانده قابل تسویه: ${T(d.balance)} · شبا: ${d.sheba ?? 'ثبت نشده'}. واریز را از طریق بانک انجام دهید و اینجا ثبت کنید.`),
        h('div', { class: 'grid2' }, h('div', {}, h('label', {}, 'مبلغ (تومان)'), amount), h('div', {}, h('label', {}, 'مرجع واریز'), ref)), note,
        h('div', { class: 'row' }, h('button', { class: 'btn primary', onclick: guard(async () => {
          await api('POST', '/v1/admin/accounting/payouts', { doctor_id: d.doctor_id, amount: Math.round(Number(amount.value) * 10), reference: ref.value, note: note.value });
          toast('تسویه ثبت شد و به پزشک اطلاع داده شد'); detailBox.replaceChildren(); load();
        }) }, 'ثبت تسویه'), h('button', { class: 'btn', onclick: () => detailBox.replaceChildren() }, 'انصراف'))));
      detailBox.scrollIntoView({ behavior: 'smooth' });
    }
    x.$app.append(h('div', { class: 'card stack' }, h('h2', {}, '💰 حسابداری کلینیک'),
      periodPicker((p) => { period = p; load(); }),
      h('p', { class: 'muted small' }, 'سهم پلتفرم و پزشک هنگام هر پرداخت ثبت شده است. سهم پزشک پس از انجام ویزیت «کارکرد» محسوب می‌شود؛ ویزیت لغوشده پس از پرداخت در «بازگشت وجه» می‌آید.')),
    body, detailBox);
  };

  const visitsTable = (items) => (items.length ? h('div', { style: 'overflow-x:auto' }, h('table', { class: 'nowrap' },
    h('thead', {}, h('tr', {}, ['ویزیت', 'بیمار', 'نوع', 'مبلغ', 'کمیسیون', 'سهم پزشک', 'وضعیت'].map((c) => h('th', {}, c)))),
    h('tbody', {}, items.map((i) => h('tr', {}, h('td', {}, fmt.short(i.visit_at)), h('td', {}, i.patient_name ?? '—'), h('td', {}, CH_FA[i.channel] ?? i.channel),
      h('td', {}, toman(i.amount)), h('td', {}, `${fa(i.commission_percent)}٪`), h('td', {}, toman(i.doctor_amount)),
      h('td', {}, h('span', { class: `pill ${STATE_FA[i.state][1]}` }, STATE_FA[i.state][0]))))))) : h('div', { class: 'empty' }, 'ویزیت پرداخت‌شده‌ای در این بازه نیست.'));
  const payoutsList = (list) => h('div', {}, h('h3', {}, 'تسویه‌ها'), list.length ? h('ul', { class: 'list' }, list.map((p) => h('li', { class: 'row' },
    h('span', { class: 'grow' }, `${fmt.short(p.paid_at)} — ${T(p.amount)}`), h('span', { class: 'muted small ltr' }, p.reference ?? '')))) : h('div', { class: 'empty' }, '—'));

  VIEWS['doctor-accounting'] = async () => {
    const body = h('div', { class: 'stack' });
    let period = {};
    const sheba = h('input', { type: 'text', dir: 'ltr', placeholder: 'IR000000000000000000000000' });
    const load = guard(async () => {
      const r = await api('GET', `/v1/doctors/me/accounting?${qs({ from: period.from, to: period.to })}`);
      sheba.value = r.sheba ?? '';
      const o = r.overall;
      body.replaceChildren(
        h('div', { class: 'grid2' },
          tile('مانده قابل تسویه', T(o.balance), o.balance ? 'warn' : 'ok'),
          tile(`کارکرد ${period.label ?? ''} (سهم شما)`, T(r.period.net)),
          tile('ویزیت‌های انجام‌شده در این بازه', fa(r.period.visits)),
          tile('کمیسیون پلتفرم در این بازه', T(r.period.commission)),
          tile(`ویزیت‌های پیش رو (${fa(r.period.pending_visits)} ویزیت پرداخت‌شده)`, T(r.period.pending_net)),
          tile('کل تسویه‌شده', T(o.paid_out))),
        h('div', { class: 'card' }, h('h3', {}, 'ویزیت‌ها'), visitsTable(r.items)),
        h('div', { class: 'card' }, payoutsList(r.payouts)));
    });
    x.$app.append(
      h('div', { class: 'card stack' }, h('h2', {}, '💰 حسابداری من'), periodPicker((p) => { period = p; load(); })),
      body,
      h('div', { class: 'card stack' }, h('h3', {}, 'حساب بانکی برای تسویه'),
        h('div', { class: 'row' }, h('div', { class: 'grow' }, h('label', {}, 'شماره شبا (به نام خودتان)'), sheba),
          h('button', { class: 'btn', onclick: guard(async () => { await api('PUT', '/v1/doctors/me/sheba', { sheba: sheba.value }); toast('شماره شبا ذخیره شد'); }) }, 'ذخیره'))));
  };

  // ---------------------------------------------------------------- users, roles & permissions
  const ROLE_FA = { patient: 'بیمار', doctor: 'پزشک', operator: 'اپراتور', admin: 'مدیر' };
  VIEWS.staff = async () => {
    const [perms, roles] = await Promise.all([api('GET', '/v1/admin/permissions'), api('GET', '/v1/admin/roles')]);
    const PERM_FA = Object.fromEntries(perms.items.map((p) => [p.key, p.label]));
    const listBox = h('div', { class: 'stack' });
    const q = h('input', { type: 'search', placeholder: 'جستجوی نام یا موبایل' });
    const roleSel = h('select', {}, h('option', { value: '' }, 'همه'), Object.entries(ROLE_FA).map(([k, v]) => h('option', { value: k }, v)));
    const loadUsers = guard(async () => {
      const r = await api('GET', `/v1/admin/users?${qs({ q: q.value.trim(), role: roleSel.value })}`);
      listBox.replaceChildren(h('p', { class: 'muted small' }, `${fa(r.total)} کاربر`), h('ul', { class: 'list' }, r.items.map((u) => {
        const sr = ['admin', 'operator'].includes(u.role) ? h('select', { onchange: guard(async (e) => {
          await api('PUT', `/v1/admin/users/${u.id}/staff-role`, { staff_role_id: e.target.value || null }); toast('نقش سازمانی به‌روز شد'); loadUsers();
        }) }, h('option', { value: '' }, u.role === 'admin' ? 'مدیر کل (همه دسترسی‌ها)' : 'اپراتور (پیش‌فرض)'),
        roles.items.map((r2) => h('option', { value: r2.id, selected: u.staff_role?.id === r2.id }, r2.name))) : null;
        return h('li', { class: 'stack' },
          h('div', { class: 'row' }, h('b', { class: 'grow' }, u.full_name ?? '—', ' ', h('span', { class: 'muted small ltr' }, u.phone)),
            h('span', { class: 'pill' }, ROLE_FA[u.role]), u.disabled ? h('span', { class: 'pill danger' }, 'غیرفعال') : null),
          h('div', { class: 'muted small' }, `آخرین ورود: ${u.last_login_at ? fmt.short(u.last_login_at) : '—'}${u.last_login_ip ? ` (${u.last_login_ip})` : ''} · عضویت: ${fmt.short(u.created_at)}`),
          h('div', { class: 'row' }, sr,
            u.role === 'patient' && supportRole ? h('button', { class: 'btn small', onclick: guard(() => convert(u)) }, 'تبدیل به کارشناس پشتیبانی') : null,
            h('button', { class: 'btn small', onclick: () => route('activity', u.id) }, 'سابقه ورود و فعالیت'),
            u.disabled
              ? h('button', { class: 'btn small', onclick: guard(async () => { await api('POST', `/v1/admin/users/${u.id}/enable`, {}); toast('فعال شد'); loadUsers(); }) }, 'فعال‌سازی')
              : h('button', { class: 'btn small danger', onclick: guard(async () => {
                const reason = prompt('دلیل غیرفعال‌سازی (اختیاری):');
                if (reason === null) return;
                await api('POST', `/v1/admin/users/${u.id}/disable`, { reason }); toast('غیرفعال شد؛ دسترسی فوراً قطع شد'); loadUsers();
              }) }, 'غیرفعال‌سازی')));
      })));
    });
    // A patient account becomes a support agent on the same number (patient history is kept).
    const supportRole = roles.items.find((r2) => r2.name === 'کارشناس پشتیبانی');
    async function convert(u, confirmHistory = false) {
      if (!confirmHistory && !confirm(`حساب «${u.full_name ?? u.phone}» از بیمار به «کارشناس پشتیبانی» تبدیل شود؟\nپس از آن با همین شماره از گزینه «ورود پزشکان» وارد می‌شود و فقط به دستیار پشتیبان دسترسی دارد.`)) return;
      try {
        await api('POST', `/v1/admin/users/${u.id}/convert-to-staff`, { role: 'operator', staff_role_id: supportRole.id, confirm: confirmHistory });
      } catch (e) {
        if (e.code === 'patient_has_history' && confirm(e.message)) return convert(u, true);
        if (e.code === 'patient_has_history') return;
        throw e;
      }
      toast('حساب به کارشناس پشتیبانی تبدیل شد'); loadUsers();
    }
    q.oninput = () => { clearTimeout(q.t); q.t = setTimeout(loadUsers, 300); };
    roleSel.onchange = loadUsers;

    const roleForm = (r = null) => {
      const name = h('input', { type: 'text', value: r?.name ?? '', placeholder: 'مثلاً حسابدار، کارشناس پذیرش' });
      const checks = perms.items.map((p) => h('label', { class: 'check' }, h('input', { type: 'checkbox', value: p.key, checked: r?.permissions.includes(p.key) }), h('span', {}, p.label)));
      return h('div', { class: 'card stack' }, h('h3', {}, r ? `ویرایش نقش «${r.name}»` : 'نقش جدید'), name, ...checks,
        h('div', { class: 'row' }, h('button', { class: 'btn primary', onclick: guard(async () => {
          const permissions = checks.map((c) => c.querySelector('input')).filter((i) => i.checked).map((i) => i.value);
          if (r) await api('PUT', `/v1/admin/roles/${r.id}`, { name: name.value, permissions });
          else await api('POST', '/v1/admin/roles', { name: name.value, permissions });
          toast('نقش ذخیره شد'); route('staff');
        }) }, 'ذخیره'), r ? h('button', { class: 'btn danger', onclick: guard(async () => {
          if (!confirm('این نقش حذف شود؟')) return;
          await api('DELETE', `/v1/admin/roles/${r.id}`); toast('حذف شد'); route('staff');
        }) }, 'حذف') : null));
    };
    const editBox = h('div');
    x.$app.append(
      h('div', { class: 'card stack' }, h('div', { class: 'row' }, h('h2', { class: 'grow' }, '👥 کاربران'), h('button', { class: 'btn small primary', onclick: () => route('staff-create') }, '+ افزودن پزشک/کادر')),
        h('div', { class: 'row' }, h('div', { class: 'grow' }, q), roleSel), listBox),
      h('div', { class: 'card stack' }, h('div', { class: 'row' }, h('h2', { class: 'grow' }, '🔐 نقش‌ها و دسترسی‌ها'), h('button', { class: 'btn small', onclick: () => editBox.replaceChildren(roleForm()) }, '+ نقش جدید')),
        h('p', { class: 'muted small' }, 'مدیرِ بدون نقش سازمانی «مدیر کل» است و همه دسترسی‌ها را دارد. با دادن نقش به مدیر یا اپراتور، فقط بخش‌های همان نقش برایش نمایش داده می‌شود.'),
        roles.items.length ? h('ul', { class: 'list' }, roles.items.map((r) => h('li', { class: 'stack' },
          h('div', { class: 'row' }, h('b', { class: 'grow' }, r.name), h('span', { class: 'muted small' }, `${fa(r.users)} کاربر`), h('button', { class: 'btn small', onclick: () => editBox.replaceChildren(roleForm(r)) }, 'ویرایش')),
          h('div', { class: 'muted small' }, r.permissions.map((p) => PERM_FA[p] ?? p).join('، '))))) : h('div', { class: 'empty' }, 'هنوز نقشی تعریف نشده است.'),
        editBox));
    loadUsers();
  };

  // ---------------------------------------------------------------- login history & activity
  const ACTION_FA = {
    'auth.login': 'ورود', 'auth.otp_requested': 'درخواست کد ورود', 'auth.mfa_challenge': 'تأیید دومرحله‌ای', 'patient.create': 'ثبت پروفایل',
    'patient.update': 'ویرایش پروفایل', 'appointment.book': 'رزرو نوبت', 'appointment.cancel': 'لغو نوبت', 'payment.paid': 'پرداخت',
    'prescription.issue': 'صدور نسخه', 'prescription.draft': 'پیش‌نویس نسخه', 'record.create': 'ارسال مدرک', 'record.opinion': 'نظر پزشک روی مدرک',
    'consultation.end': 'پایان ویزیت', 'summary.finalize': 'نهایی‌کردن خلاصه ویزیت', 'user.disable': 'غیرفعال‌سازی کاربر', 'user.enable': 'فعال‌سازی کاربر',
    'user.staff_role': 'تغییر نقش', 'role.create': 'ایجاد نقش', 'role.update': 'ویرایش نقش', 'accounting.payout': 'ثبت تسویه', 'settings.tariffs': 'تغییر تعرفه‌ها',
    'settings.commission': 'تغییر کمیسیون', 'doctor.approve': 'تأیید پزشک', 'doctor.reject': 'رد مدارک پزشک', 'drug_catalog.activate': 'فعال‌سازی فهرست داروها',
  };
  const REASON_FA = { wrong_code: 'کد نادرست', account_disabled: 'حساب غیرفعال' };
  const device = (ua) => (!ua ? '—' : /Android/i.test(ua) ? 'اندروید' : /iPhone|iPad/i.test(ua) ? 'iOS' : /Windows/i.test(ua) ? 'ویندوز' : /Mac OS/i.test(ua) ? 'مک' : /Linux/i.test(ua) ? 'لینوکس' : 'سایر');
  const loginsTable = (items, showUser) => (items.length ? h('div', { style: 'overflow-x:auto' }, h('table', { class: 'nowrap' },
    h('thead', {}, h('tr', {}, [...(showUser ? ['کاربر'] : []), 'زمان', 'نتیجه', 'روش', 'IP', 'دستگاه'].map((c) => h('th', {}, c)))),
    h('tbody', {}, items.map((e) => h('tr', {}, ...(showUser ? [h('td', {}, e.user ? `${e.user.full_name ?? ''} ${e.user.phone}` : (e.phone ?? '—'))] : []),
      h('td', {}, fmt.short(e.at)), h('td', {}, h('span', { class: `pill ${e.success ? 'ok' : 'danger'}` }, e.success ? 'موفق' : `ناموفق${e.reason ? ` (${REASON_FA[e.reason] ?? e.reason})` : ''}`)),
      h('td', {}, e.method === 'mfa' ? 'دومرحله‌ای' : 'کد پیامکی'), h('td', { class: 'ltr' }, e.ip ?? '—'), h('td', {}, device(e.user_agent)))))))
    : h('div', { class: 'empty' }, '—'));
  const actionsTable = (items, showUser) => (items.length ? h('div', { style: 'overflow-x:auto' }, h('table', { class: 'nowrap' },
    h('thead', {}, h('tr', {}, [...(showUser ? ['کاربر'] : []), 'زمان', 'فعالیت', 'مورد', 'IP'].map((c) => h('th', {}, c)))),
    h('tbody', {}, items.map((a) => h('tr', {}, ...(showUser ? [h('td', {}, a.user ? `${a.user.full_name ?? ''} ${a.user.phone}` : '—')] : []),
      h('td', {}, fmt.short(a.at)), h('td', {}, ACTION_FA[a.action] ?? h('span', { class: 'ltr' }, a.action)), h('td', { class: 'ltr small' }, a.resource), h('td', { class: 'ltr' }, a.ip ?? '—'))))))
    : h('div', { class: 'empty' }, '—'));

  VIEWS['my-activity'] = async () => {
    const r = await api('GET', '/v1/me/activity');
    x.$app.append(
      h('div', { class: 'card stack' }, h('h2', {}, '🕘 سابقه ورود من'), h('p', { class: 'muted small' }, 'اگر ورودی را نمی‌شناسید، فوراً با پشتیبانی تماس بگیرید.'), loginsTable(r.logins, false)),
      h('div', { class: 'card stack' }, h('h2', {}, 'فعالیت‌های من'), actionsTable(r.actions, false)));
  };

  VIEWS.activity = async (userId) => {
    const kind = h('select', {}, h('option', { value: 'logins' }, 'ورودها'), h('option', { value: 'actions' }, 'فعالیت‌ها'));
    const failed = h('input', { type: 'checkbox' });
    const body = h('div', { class: 'stack' });
    let period = {};
    const load = guard(async () => {
      const r = await api('GET', `/v1/admin/activity?${qs({ kind: kind.value, user_id: userId, failed: failed.checked && kind.value === 'logins' ? '1' : '', from: period.from, to: period.to })}`);
      body.replaceChildren(
        h('div', { class: 'grid2' }, tile('ورود موفق', fa(r.summary.successful_logins), 'ok'), tile('ورود ناموفق', fa(r.summary.failed_logins), r.summary.failed_logins ? 'danger' : ''), tile('کاربران فعال', fa(r.summary.users))),
        h('div', { class: 'card' }, r.kind === 'logins' ? loginsTable(r.items, !userId) : actionsTable(r.items, !userId)));
    });
    kind.onchange = load; failed.onchange = load;
    x.$app.append(h('div', { class: 'card stack' },
      h('div', { class: 'row' }, h('h2', { class: 'grow' }, userId ? '🕘 سابقه ورود و فعالیت کاربر' : '🕘 سابقه ورود و فعالیت همه کاربران'),
        userId ? h('button', { class: 'btn small', onclick: () => route('activity') }, 'همه کاربران') : null),
      periodPicker((p) => { period = p; load(); }, 'all'),
      h('div', { class: 'row' }, kind, h('label', { class: 'check' }, failed, h('span', {}, 'فقط ورودهای ناموفق')))), body);
  };

  // ---------------------------------------------------------------- admin: national drug coding (eRx-IRC)
  VIEWS['drug-catalog'] = async () => {
    const r = await api('GET', '/v1/admin/drug-catalog');
    const st = { active: ['فعال', 'ok'], staged: ['آماده فعال‌سازی', 'warn'], archived: ['بایگانی', ''] };
    const preview = h('div', { class: 'stack' });
    const summaryView = (c) => {
      const s = c.summary;
      return h('div', { class: 'stack' },
        h('div', { class: 'grid2' },
          h('div', {}, h('label', {}, 'داروهای نسخه‌نویسی (کد eRx)'), fa(s.prescribing_rows ?? 0)),
          h('div', {}, h('label', {}, 'نام ژنریک'), fa(s.generic_names ?? 0)),
          h('div', {}, h('label', {}, 'ردیف‌های نسخه‌پیچی (IRC)'), fa(s.dispensing_rows ?? 0)),
          h('div', {}, h('label', {}, 'کدهای حذف‌شده'), fa(s.deleted ?? 0)),
          h('div', {}, h('label', {}, 'تغییرات این نسخه'), Object.entries(s.actions ?? {}).map(([k, v]) => `${k}: ${fa(v)}`).join(' · ') || '—'),
          h('div', {}, h('label', {}, 'ژنریک‌های تحت بررسی ایمنی'), `${fa(s.safety_covered_generics ?? 0)} از ${fa(s.generic_names ?? 0)}`)),
        c.issues?.length ? h('div', { class: 'banner warn small' }, `${fa(c.issues.length)} ردیف نامعتبر کنار گذاشته شد: `, c.issues.slice(0, 5).join('؛ ')) : null,
        s.duplicates ? h('p', { class: 'muted small' }, `${fa(s.duplicates)} کد تکراری نادیده گرفته شد.`) : null);
    };
    const input = h('input', { type: 'file', accept: '.xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
    input.onchange = guard(async () => {
      const file = input.files[0];
      if (!file) return;
      preview.replaceChildren(h('p', { class: 'muted' }, '⏳ در حال خواندن و بررسی فایل…'));
      const s = x.getSession();
      const res = await fetch(apiUrl(`/v1/admin/drug-catalog?filename=${encodeURIComponent(file.name)}`), {
        method: 'POST', headers: { Authorization: `Bearer ${s.access_token}`, 'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }, body: file,
      });
      const c = await res.json().catch(() => ({}));
      input.value = '';
      if (!res.ok) { preview.replaceChildren(h('div', { class: 'banner danger' }, c.message ?? 'بارگذاری ناموفق بود')); return; }
      preview.replaceChildren(h('div', { class: 'card stack' }, h('h3', {}, `پیش‌نمایش: ${c.filename}`), summaryView(c),
        h('details', {}, h('summary', {}, 'نمونه ردیف‌ها'), h('div', { style: 'overflow-x:auto' }, h('table', {}, h('tbody', {}, c.sample.map((x) => h('tr', {}, h('td', { class: 'ltr' }, x.erx_code), h('td', { class: 'ltr' }, x.title))))))),
        h('div', { class: 'row' }, h('button', { class: 'btn primary', onclick: guard(async () => {
          await api('POST', `/v1/admin/drug-catalog/${c.id}/activate`, {});
          toast('فهرست داروها فعال شد'); route('drug-catalog');
        }) }, '✓ فعال‌سازی این فهرست'), h('span', { class: 'muted small' }, 'تا فعال‌سازی، فهرست قبلی استفاده می‌شود.'))));
    });
    const activeOne = r.items.find((c) => c.status === 'active');
    x.$app.append(
      h('div', { class: 'card stack' }, h('h2', {}, '💊 فهرست رسمی داروها (کدینگ eRx-IRC سازمان غذا و دارو)'),
        h('p', { class: 'muted' }, 'فایل اکسل «کدینگ نسخه نویسی و نسخه پیچی داروهای شیمیایی» ابلاغی را (پس از باز کردن فایل فشرده) بارگذاری کنید. پزشکان داروها را با کد رسمی eRx انتخاب می‌کنند و کدهای حذف‌شده با کد جایگزین رد می‌شوند. داده فقط روی همین سرور نگهداری می‌شود.'),
        activeOne ? h('div', { class: 'banner info' }, `فهرست فعال: ${activeOne.filename} — ${fmt.short(activeOne.activated_at)}`) : h('div', { class: 'banner warn' }, 'هنوز فهرستی فعال نشده است؛ پزشکان فعلاً نام دارو را آزاد می‌نویسند.'),
        activeOne ? summaryView(activeOne) : null,
        h('div', {}, h('label', {}, 'بارگذاری نسخه جدید (xlsx)'), input), preview),
      h('div', { class: 'card' }, h('h2', {}, 'نسخه‌ها'),
        r.items.length ? h('ul', { class: 'list' }, r.items.map((c) => h('li', { class: 'row' },
          h('span', { class: `pill ${st[c.status][1]}` }, st[c.status][0]), h('span', { class: 'grow' }, c.filename, h('br'), h('span', { class: 'muted small' }, `${fmt.short(c.created_at)} · ${fa(c.summary.prescribing_rows ?? 0)} دارو`)),
          c.status !== 'active' ? h('button', { class: 'btn small', onclick: guard(async () => {
            if (!confirm(c.status === 'archived' ? 'به این نسخه برگردیم؟' : 'این نسخه فعال شود؟')) return;
            await api('POST', `/v1/admin/drug-catalog/${c.id}/activate`, {}); toast('فعال شد'); route('drug-catalog');
          }) }, c.status === 'archived' ? 'بازگشت به این نسخه' : 'فعال‌سازی') : null))) : h('div', { class: 'empty' }, '—')));
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
        d.photo_url ? h('img', { class: 'avatar-lg', src: fileUrl(d.photo_url), alt: '' }) : h('span', { class: 'avatar-lg ph' }, x.illus('doctor', 88)),
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
        d.photo_url ? h('img', { class: 'avatar-xl', src: fileUrl(d.photo_url), alt: '' }) : h('span', { class: 'avatar-xl ph' }, x.illus('doctor', 128)),
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

  // ---------------------------------------------------------------- prescribing (phase 1 aids)
  const SEV = { high: ['جدی', 'danger'], moderate: ['احتیاط', 'warn'] };
  const safetyList = (s) => h('div', { class: 'stack' },
    ...(s?.warnings ?? []).map((w) => h('div', { class: `banner ${SEV[w.severity][1]} small` }, h('b', {}, `⚠️ ${SEV[w.severity][0]}: `), w.message)),
    s?.unrecognised?.length ? h('p', { class: 'muted small' }, `این داروها در فهرست بررسی ایمنی نیستند (بررسی دستی): ${s.unrecognised.join('، ')}`) : null,
    s && !s.warnings?.length && !s.unrecognised?.length ? h('p', { class: 'muted small' }, '✓ هشداری در بررسی ایمنی (حساسیت، تکرار، تداخل‌های مهم) یافت نشد.') : null);

  x.rxPanel = async (cid, { endButton = null } = {}) => {
    const drugsMeta = await api('GET', '/v1/drugs').catch(() => ({ items: [], directory: false }));
    const drugNames = drugsMeta.items;
    const dl = h('datalist', { id: 'drug-names' }, drugNames.map((n) => h('option', { value: n })));
    // Suggestions from the Iranian drug directory while typing (only the drug name is sent).
    let sugTimer = null;
    // Official national coding (eRx) when the admin has activated it; title → code.
    const erxByTitle = new Map();
    const suggest = (q) => {
      clearTimeout(sugTimer);
      sugTimer = setTimeout(async () => {
        if (q.trim().length < 2) return;
        const [cat, dir] = await Promise.all([
          api('GET', `/v1/drug-catalog/search?q=${encodeURIComponent(q.trim())}`).catch(() => null),
          drugsMeta.directory ? api('GET', `/v1/drugs?q=${encodeURIComponent(q.trim())}`).catch(() => null) : null,
        ]);
        for (const it of cat?.items ?? []) erxByTitle.set(it.title, it);
        const opts = [...(cat?.items ?? []).map((it) => [it.title, `eRx ${it.erx_code}${it.safety_checked ? '' : ' · خارج از بررسی ایمنی'}`])];
        for (const n of [...(dir?.items ?? []), ...(dir?.directory_items ?? []).map((d) => d.title)]) if (!opts.some(([v]) => v === n)) opts.push([n, '']);
        if (opts.length) dl.replaceChildren(...opts.slice(0, 25).map(([v, l]) => h('option', { value: v, label: l || v })));
      }, 300);
    };
    const infoBox = h('div', { class: 'stack' });
    const showInfo = guard(async (name) => {
      if (!name) throw new Error('ابتدا نام دارو را بنویسید');
      infoBox.replaceChildren(h('p', { class: 'muted small' }, '⏳ جستجو در فهرست داروها…'));
      const r = await api('GET', `/v1/drugs?q=${encodeURIComponent(name)}`);
      const items = (r.directory_items ?? []).filter((d) => d.url);
      if (!items.length) {
        infoBox.replaceChildren(h('p', { class: 'muted small' }, r.directory_error ?? `برای «${name}» موردی در فهرست داروها پیدا نشد.`));
        return;
      }
      const detail = h('div', { class: 'stack' });
      const open = guard(async (it) => {
        detail.replaceChildren(h('p', { class: 'muted small' }, '⏳ دریافت اطلاعات…'));
        const d = await api('GET', `/v1/drugs/info?url=${encodeURIComponent(it.url)}`);
        detail.replaceChildren(
          h('div', { class: 'row' }, h('b', { class: 'grow' }, it.title, it.title_en ? h('span', { class: 'muted small ltr' }, ` ${it.title_en}`) : null),
            h('span', { class: `pill ${it.safety_checked ? 'ok' : ''}` }, it.safety_checked ? 'در بررسی ایمنی خودکار' : 'خارج از بررسی ایمنی خودکار')),
          ...d.sections.map((sec, i) => h('details', i < 2 ? { open: true } : {}, h('summary', {}, sec.label), h('div', { class: 'pre small' }, sec.text))),
          h('p', { class: 'muted small' }, `منبع: ${d.source}. ${d.disclaimer}`));
      });
      infoBox.replaceChildren(h('div', { class: 'ai-box stack' },
        h('div', { class: 'row' }, h('b', { class: 'grow' }, `ℹ️ اطلاعات دارو: ${name}`), h('button', { class: 'btn small', type: 'button', onclick: () => infoBox.replaceChildren() }, '✕')),
        h('div', { class: 'choices' }, items.slice(0, 8).map((it) => h('button', { type: 'button', class: 'choice', onclick: () => open(it) }, it.title))),
        detail));
      if (items.length === 1) open(items[0]);
    });
    let dx = [];
    const rows = h('div');
    const notes = h('textarea', { rows: 2, placeholder: 'توضیحات نسخه' });
    const safetyBox = h('div');
    const existing = h('div', { class: 'stack' });
    let rxKey = crypto.randomUUID();
    let timer = null;
    const current = () => [...rows.children].map((r) => {
      const d = Object.fromEntries([...r.querySelectorAll('input')].map((i) => [i.dataset.k, i.value.trim()]));
      const erx = erxByTitle.get(d.name)?.erx_code ?? r.dataset.erx;
      return erx && (erxByTitle.get(d.name) || r.dataset.erxTitle === d.name) ? { ...d, erx_code: erx } : d;
    }).filter((d) => d.name);
    const recheck = () => {
      clearTimeout(timer);
      timer = setTimeout(async () => {
        const drugs = current();
        if (!drugs.length) { safetyBox.replaceChildren(); return; }
        const r = await api('POST', '/v1/prescriptions/check', { consultation_id: cid, drugs }).catch(() => null);
        if (r) safetyBox.replaceChildren(safetyList(r));
      }, 500);
    };
    const addRow = (d = {}) => {
      const tag = h('span', { class: 'muted small erx-tag ltr' }, d.erx_code ? `eRx ${d.erx_code}` : '');
      rows.append(h('div', { class: 'drug-row', 'data-erx': d.erx_code ?? '', 'data-erx-title': d.erx_code ? d.name ?? '' : '' },
        h('input', { type: 'text', placeholder: 'نام یا کد eRx دارو', 'data-k': 'name', list: 'drug-names', value: d.name ?? '', dir: 'auto', oninput: (e) => {
          recheck(); suggest(e.target.value);
          const it = erxByTitle.get(e.target.value.trim());
          tag.textContent = it ? `eRx ${it.erx_code}` : '';
        } }),
        h('input', { type: 'text', placeholder: 'دوز', 'data-k': 'dose', value: d.dose ?? '' }),
        h('input', { type: 'text', placeholder: 'دفعات مصرف', 'data-k': 'frequency', value: d.frequency ?? '' }),
        h('input', { type: 'text', placeholder: 'مدت', 'data-k': 'duration', value: d.duration ?? '' }),
        drugsMeta.directory ? h('button', { class: 'btn small', type: 'button', title: 'اطلاعات دارو', onclick: (e) => showInfo(e.currentTarget.parentElement.querySelector('[data-k=name]').value.trim()) }, 'ℹ️') : null,
        h('button', { class: 'btn small', type: 'button', onclick: (e) => { e.currentTarget.parentElement.remove(); recheck(); } }, '✕'),
        tag));
    };
    addRow();

    // diagnosis (ICD-10)
    const dxChips = h('div', { class: 'choices' });
    const dxInput = h('input', { type: 'search', placeholder: 'جستجوی تشخیص (فارسی، انگلیسی یا کد)، مثلاً «گلودرد» یا J02' });
    const dxResults = h('div', { class: 'choices' });
    const renderDx = () => {
      dxChips.replaceChildren(...dx.map((d) => h('button', { type: 'button', class: 'choice on', title: 'حذف', onclick: () => { dx = dx.filter((x) => x.code !== d.code); renderDx(); loadTemplates(); } }, `${d.code} ${d.label_fa} ✕`)));
    };
    let dxTimer = null;
    dxInput.oninput = () => {
      clearTimeout(dxTimer);
      dxTimer = setTimeout(async () => {
        const q = dxInput.value.trim();
        if (!q) { dxResults.replaceChildren(); return; }
        const r = await api('GET', `/v1/icd10?q=${encodeURIComponent(q)}`).catch(() => ({ items: [] }));
        dxResults.replaceChildren(...r.items.map((it) => h('button', { type: 'button', class: 'choice', onclick: () => {
          if (!dx.some((d) => d.code === it.code) && dx.length < 5) dx.push(it);
          dxInput.value = ''; dxResults.replaceChildren(); renderDx(); loadTemplates();
        } }, h('b', { class: 'ltr' }, it.code), ` ${it.label_fa}`)));
      }, 250);
    };

    // personal templates
    const tplSel = h('select', {}, h('option', { value: '' }, 'الگوهای من…'));
    let templates = [];
    async function loadTemplates() {
      const r = await api('GET', `/v1/doctors/me/rx-templates${dx[0] ? `?diagnosis_code=${encodeURIComponent(dx[0].code)}` : ''}`).catch(() => ({ items: [] }));
      templates = r.items;
      tplSel.replaceChildren(h('option', { value: '' }, templates.length ? 'الگوهای من…' : 'هنوز الگویی ذخیره نکرده‌اید'),
        ...templates.map((t) => h('option', { value: t.id }, `${t.name}${t.diagnosis_code ? ` (${t.diagnosis_code})` : ''}`)));
    }
    tplSel.onchange = guard(async () => {
      const t = templates.find((x) => x.id === tplSel.value);
      if (!t) return;
      rows.replaceChildren(); t.drugs.forEach(addRow);
      if (t.notes) notes.value = t.notes;
      if (t.diagnosis_code && !dx.some((d) => d.code === t.diagnosis_code)) { dx.push({ code: t.diagnosis_code, label_fa: t.diagnosis_label }); renderDx(); }
      api('POST', `/v1/doctors/me/rx-templates/${t.id}/use`, {}).catch(() => {});
      tplSel.value = '';
      recheck();
      toast(`الگوی «${t.name}» اعمال شد؛ پیش از ذخیره بررسی کنید`);
    });
    const saveTpl = guard(async () => {
      const drugs = current();
      if (!drugs.length) throw new Error('ابتدا داروها را وارد کنید');
      const name = prompt('نام الگو (مثلاً «فارنژیت بزرگسال»):');
      if (!name) return;
      await api('POST', '/v1/doctors/me/rx-templates', { name, diagnosis_code: dx[0]?.code ?? null, drugs, notes: notes.value });
      toast('الگو ذخیره شد'); loadTemplates();
    });

    // "From my formulary": the physician's own templates / earlier prescriptions for the chosen diagnosis.
    const sugBox = h('div', { class: 'stack' });
    const applySuggestion = (it, dxUsed) => {
      if (current().length && !confirm('داروهای فعلی فرم با این پیشنهاد جایگزین شوند؟')) return;
      rows.replaceChildren(); it.drugs.forEach(addRow);
      if (it.notes) notes.value = it.notes;
      sugBox.replaceChildren(h('p', { class: 'muted small' }, `✓ «${it.label}» در فرم قرار گرفت؛ پیش از ذخیره دوز، مدت و مناسب بودن برای این بیمار را بررسی کنید.`));
      recheck();
      api('POST', '/v1/prescriptions/suggest/applied', { consultation_id: cid, sources: it.sources, diagnosis_code: it.diagnosis_code ?? dxUsed, had_warnings: it.warnings.length > 0 }).catch(() => {});
    };
    const suggestRx = guard(async () => {
      sugBox.replaceChildren(h('p', { class: 'muted small' }, '⏳ جستجو در نسخه‌ها و الگوهای خودتان…'));
      const r = await api('POST', '/v1/prescriptions/suggest', { consultation_id: cid, diagnoses: dx.map((d) => d.code) });
      const fromA = r.from_assessment.length ? h('div', { class: 'stack' },
        h('span', { class: 'small' }, 'کدهای یافت‌شده در «ارزیابی» شما — برای استفاده تأیید کنید:'),
        h('div', { class: 'choices' }, r.from_assessment.map((it) => h('button', { type: 'button', class: 'choice', onclick: () => {
          if (!dx.some((d) => d.code === it.code)) dx.push(it);
          renderDx(); loadTemplates(); suggestRx();
        } }, h('b', { class: 'ltr' }, it.code), ` ${it.label_fa} +`)))) : null;
      sugBox.replaceChildren(h('div', { class: 'ai-box stack' },
        h('div', { class: 'row' }, h('b', { class: 'grow' }, `💡 پیشنهاد از نسخه‌های خودتان${r.diagnoses.length ? ` برای ${r.diagnoses.map((d) => d.code).join('، ')}` : ''}`),
          h('button', { class: 'btn small', type: 'button', onclick: () => sugBox.replaceChildren() }, '✕')),
        fromA,
        r.hint ? h('p', { class: 'muted small' }, r.hint) : null,
        ...r.items.map((it) => h('div', { class: `banner ${it.blocked ? 'danger' : 'info'} stack` },
          h('div', { class: 'row' }, h('b', { class: 'grow' }, it.label),
            h('span', { class: 'muted small' }, `${it.sources.includes('template') ? 'الگوی شما' : 'نسخه‌های قبلی شما'} · ${it.times_used ? `${fa(it.times_used)} بار` : 'هنوز استفاده نشده'}`)),
          h('div', { class: 'small ltr', style: 'white-space:pre-line' }, it.drugs.map((d) => [d.name, d.dose, d.frequency, d.duration].filter(Boolean).join(' — ')).join('\n')),
          ...it.warnings.map((w) => h('div', { class: 'small' }, `⚠️ ${w.message}`)),
          h('div', {}, h('button', { class: `btn small ${it.blocked ? '' : 'primary'}`, type: 'button', onclick: () => applySuggestion(it, r.diagnoses[0]?.code) },
            it.blocked ? 'اعمال (با وجود هشدار جدی)' : 'اعمال در فرم')))),
        h('p', { class: 'muted small' }, 'پیشنهادها فقط از الگوها و نسخه‌های صادرشده خود شما برای همین تشخیص است و برای این بیمار از نظر حساسیت، تکرار و تداخل‌های مهم بررسی شده؛ تصمیم و ویرایش نهایی با شماست.')));
    });

    const loadRx = async () => {
      const r = await api('GET', `/v1/prescriptions?consultation_id=${cid}`);
      existing.replaceChildren(...r.items.map((rx) => h('div', { class: `banner ${rx.status === 'issued' ? 'info' : 'warn'} stack` },
        h('div', {}, rx.status === 'issued' ? '✅ نسخه صادر و امضا شد' : '📝 پیش‌نویس (تا امضا نامعتبر است)', ' — ', rx.drugs.map((d) => `${d.name} ${d.dose ?? ''}${d.erx_code ? ` (eRx ${d.erx_code})` : ''}`).join('، ')),
        rx.diagnoses?.length ? h('div', { class: 'small' }, 'تشخیص: ', rx.diagnoses.map((d) => `${d.code} ${d.label_fa}`).join('، ')) : null,
        rx.status === 'draft' ? safetyList(rx.safety) : rx.safety?.override_reason ? h('div', { class: 'small' }, `صدور با وجود هشدار؛ دلیل پزشک: ${rx.safety.override_reason}`) : null,
        h('div', {}, rx.status === 'draft' ? h('button', { class: 'btn primary small', onclick: guard(async () => {
          try {
            await api('POST', `/v1/prescriptions/${rx.id}/sign`, {});
          } catch (e) {
            if (e.code !== 'safety_override_required') throw e;
            const list = (e.body?.warnings ?? []).filter((w) => w.severity === 'high').map((w) => `• ${w.message}`).join('\n');
            const reason = prompt(`هشدار ایمنی جدی:\n${list}\n\nاگر با آگاهی از این هشدار صدور را لازم می‌دانید، دلیل را بنویسید (در پرونده ثبت می‌شود):`);
            if (!reason) return;
            await api('POST', `/v1/prescriptions/${rx.id}/sign`, { override_reason: reason });
          }
          toast('نسخه امضا و صادر شد'); loadRx();
        }) }, 'امضا و صدور') : h('a', { href: apiUrl(`/v1/prescriptions/${rx.id}/verify`), target: '_blank' }, 'بررسی اعتبار')))));
    };
    const saveDraft = guard(async () => {
      const drugs = current();
      if (!drugs.length) throw new Error('حداقل یک دارو وارد کنید');
      await api('POST', '/v1/prescriptions', { consultation_id: cid, drugs, notes: notes.value, diagnoses: dx.map((d) => d.code) }, { 'Idempotency-Key': rxKey });
      rxKey = crypto.randomUUID();
      rows.replaceChildren(); addRow(); notes.value = ''; safetyBox.replaceChildren();
      toast('پیش‌نویس ذخیره شد'); loadRx();
    });
    loadTemplates();
    loadRx();
    return h('div', { class: 'card stack' }, dl, h('h2', {}, 'نسخه الکترونیک'), existing,
      h('div', {}, h('label', {}, 'تشخیص (ICD-10)'), dxChips, dxInput, dxResults),
      h('div', { class: 'row' }, h('button', { class: 'btn small', type: 'button', onclick: suggestRx }, '💡 پیشنهاد از نسخه‌های من'), tplSel, h('button', { class: 'btn small', type: 'button', onclick: saveTpl }, '💾 ذخیره به‌عنوان الگو')),
      sugBox,
      h('div', {}, rows, h('button', { class: 'btn small', onclick: () => addRow() }, '+ دارو')),
      infoBox, safetyBox, notes,
      h('p', { class: 'muted small' }, 'بررسی ایمنی (حساسیت ثبت‌شده، داروی تکراری، چند تداخل مهم) کمکی و محدود است و جای قضاوت پزشک را نمی‌گیرد.'),
      h('div', { class: 'row' }, h('button', { class: 'btn', onclick: saveDraft }, 'ذخیره پیش‌نویس'), h('span', { class: 'spacer' }), endButton ?? ''));
  };

  // ---------------------------------------------------------------- visit summary (SOAP)
  const SUMMARY_FIELDS = [
    ['subjective', 'S — شرح حال (گفته‌های بیمار)', 6],
    ['objective', 'O — یافته‌ها (علائم حیاتی، آزمایش، مدارک)', 6],
    ['assessment', 'A — ارزیابی پزشک * (شما می‌نویسید؛ دستیار فقط پیش‌نویس پیشنهاد می‌دهد)', 5],
    ['plan', 'P — برنامه درمان و نسخه', 4],
    ['advice', 'توصیه‌ها به بیمار', 3],
    ['follow_up', 'پیگیری (مثلاً «دو هفته بعد ویزیت مجدد»)', 1],
  ];
  // 🎤 Dictation into a text field (browser speech recognition, Persian). Chrome sends the audio
  // to Google for recognition, so the physician is told once and agrees before first use.
  const Speech = window.SpeechRecognition || window.webkitSpeechRecognition;
  const micButton = (target) => {
    if (!Speech) return null;
    let rec = null;
    const btn = h('button', { class: 'btn small mic', type: 'button', title: 'تایپ با صدا' }, '🎤');
    const stop = () => { try { rec?.stop(); } catch { /* already stopped */ } };
    btn.onclick = () => {
      if (rec) return stop();
      let ok = false;
      try { ok = localStorage.getItem('stt_consent') === '1'; } catch { /* private mode */ }
      if (!ok) {
        if (!confirm('تایپ با صدا از سرویس تشخیص گفتار مرورگر استفاده می‌کند و صدای شما برای تبدیل به متن به سرویس گوگل فرستاده می‌شود. نام و مشخصات بیمار را بلند نگویید.\n\nادامه می‌دهید؟')) return;
        try { localStorage.setItem('stt_consent', '1'); } catch { /* private mode */ }
      }
      rec = new Speech();
      rec.lang = 'fa-IR'; rec.continuous = true; rec.interimResults = false;
      rec.onresult = (e) => {
        for (let i = e.resultIndex; i < e.results.length; i++) {
          if (!e.results[i].isFinal) continue;
          const said = e.results[i][0].transcript.trim();
          if (said) { target.value = `${target.value}${target.value && !/\s$/.test(target.value) ? ' ' : ''}${said}`; target.dispatchEvent(new Event('input')); }
        }
      };
      rec.onerror = (e) => { if (e.error !== 'no-speech' && e.error !== 'aborted') toast(e.error === 'not-allowed' ? 'اجازه دسترسی به میکروفون داده نشد' : 'تشخیص گفتار ناموفق بود', true); };
      rec.onend = () => { rec = null; btn.classList.remove('rec'); btn.textContent = '🎤'; };
      rec.start();
      btn.classList.add('rec'); btn.textContent = '⏹';
      toast('در حال شنیدن… دوباره بزنید تا متوقف شود');
    };
    onCleanup(stop);
    return btn;
  };
  // 💡 The assistant's assessment draft (rules, on the server): findings, ICD-10 codes to consider
  // and background. Inserted into the assessment for the physician to review and complete.
  const draftHelper = (cid, target) => {
    const box = h('div');
    const btn = h('button', { class: 'btn small', type: 'button', onclick: guard(async () => {
      const d = await api('GET', `/v1/consultations/${cid}/summary/assessment-draft`);
      const insert = () => {
        target.value = target.value.trim() ? `${target.value.trim()}\n\n${d.text}` : d.text;
        target.dispatchEvent(new Event('input'));
        box.replaceChildren();
        toast('پیش‌نویس درج شد؛ بازبینی و «ارزیابی نهایی» را کامل کنید');
        target.focus();
      };
      box.replaceChildren(h('div', { class: 'draft-box' },
        h('div', { class: 'row' }, h('b', { class: 'grow' }, '💡 پیشنهاد دستیار — نیازمند بررسی پزشک'),
          h('button', { class: 'btn small', type: 'button', onclick: () => box.replaceChildren() }, 'بستن')),
        h('p', { class: 'muted small' }, 'از داده‌های ثبت‌شده (تریاژ، علائم حیاتی، آزمایش‌ها، رادیوگرافی، سابقه) با قواعد ساخته شده است؛ تشخیص نیست. پس از درج، آن را اصلاح و تکمیل کنید.'),
        h('div', { class: 'pre' }, d.text),
        d.icd.length ? h('div', {}, h('label', {}, 'کدهای ICD-10 پیشنهادی (برای افزودن بزنید)'),
          h('div', { class: 'chips' }, d.icd.map((c) => h('button', { class: 'chip', type: 'button', title: c.reason, onclick: (ev) => {
            target.value = `${target.value.trim()}${target.value.trim() ? '\n' : ''}${c.code} ${c.label_fa}`;
            target.dispatchEvent(new Event('input'));
            ev.currentTarget.disabled = true;
          } }, `${c.code} ${c.label_fa}`)))) : null,
        h('div', { class: 'row' }, h('button', { class: 'btn primary small', type: 'button', onclick: insert }, 'درج در ارزیابی'))));
    }) }, '💡 پیش‌نویس دستیار');
    return { btn, box };
  };
  // Label row of a summary field: title + tools (assistant draft / dictation).
  const fieldHead = (label, ...tools) => h('div', { class: 'row field-head' }, h('label', { class: 'grow' }, label), ...tools.filter(Boolean));

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
        const dh = draftHelper(cid, a);
        card.append(h('p', { class: 'muted' }, 'با پایان ویزیت، پیش‌نویس خلاصه از تریاژ، مدارک، گفتگو و نسخه ساخته می‌شود و شما آن را ویرایش و تأیید می‌کنید.'),
          fieldHead('یادداشت / ارزیابی پزشک', dh.btn, micButton(a)), dh.box, a,
          h('button', { class: 'btn', onclick: guard(async () => { await api('PUT', `/v1/consultations/${cid}/summary`, { assessment: a.value }); toast('یادداشت ذخیره شد'); }) }, 'ذخیره یادداشت'));
        return;
      }
      const inputs = {};
      card.append(h('div', { class: 'banner info' }, 'پیش‌نویس خودکار از داده‌های ثبت‌شده ساخته شده است. پیش از ارسال بخوانید و اصلاح کنید؛ بخش «ارزیابی» را خودتان بنویسید یا از «💡 پیش‌نویس دستیار» کمک بگیرید و آن را کامل کنید.',
        s.generator ? h('span', { class: 'muted small' }, ` (${s.generator})`) : null));
      for (const [k, label, rows] of SUMMARY_FIELDS) {
        inputs[k] = rows === 1 ? h('input', { type: 'text', value: s[k] ?? '' }) : h('textarea', { rows }, s[k] ?? '');
        const dh = k === 'assessment' ? draftHelper(cid, inputs[k]) : null;
        card.append(h('div', {}, fieldHead([label, s.edited_fields?.includes(k) ? h('span', { class: 'muted small' }, ' · ویرایش‌شده') : null], dh?.btn, ['assessment', 'plan', 'advice', 'subjective'].includes(k) ? micButton(inputs[k]) : null),
          dh?.box, inputs[k]));
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
  // ---------------------------------------------------------------- chest X-ray pattern flags (research aid)
  const TIER_FA = { strong: ['قابل توجه', 'danger'], moderate: ['احتمالی', 'warn'] };
  function cxrView(a) {
    const flagged = a.findings.filter((f) => f.tier !== 'none');
    const imgBox = h('div', { class: 'cxr-img' });
    const show = (f) => imgBox.replaceChildren(f?.overlay_url ? h('figure', {}, h('img', { src: fileUrl(f.overlay_url), alt: f.label }), h('figcaption', { class: 'muted small' }, `ناحیه‌ای که مدل برای «${f.label}» به آن توجه کرده (نقشه فعال‌سازی، نه مرز ضایعه)`)) : '');
    const verdicts = {};
    const fbBox = h('div', { class: 'stack' });
    const renderFeedback = () => {
      if (a.feedback) {
        fbBox.replaceChildren(h('p', { class: 'muted small' }, `✓ نظر شما ثبت شد (${fmt.short(a.feedback_at)}). با تشکر؛ این نظرها دقت واقعی ابزار را مشخص می‌کند.`));
        return;
      }
      const missed = new Set();
      const others = a.findings.filter((f) => f.tier === 'none');
      const useful = h('select', {}, h('option', { value: '' }, '—'), h('option', { value: 'useful' }, 'مفید بود'), h('option', { value: 'not_useful' }, 'مفید نبود'));
      const note = h('input', { type: 'text', placeholder: 'یادداشت (اختیاری)' });
      fbBox.replaceChildren(
        h('b', {}, 'نظر شما (برای ارزیابی دقت ابزار در فاز آزمایشی)'),
        ...flagged.map((f) => h('div', { class: 'row' }, h('span', { class: 'grow' }, f.label),
          ...[['agree', 'موافقم'], ['disagree', 'مخالفم'], ['unsure', 'مطمئن نیستم']].map(([v, l]) => h('button', { type: 'button', class: 'choice', onclick: (e) => {
            verdicts[f.key] = v;
            e.currentTarget.parentElement.querySelectorAll('.choice').forEach((b) => b.classList.remove('on'));
            e.currentTarget.classList.add('on');
          } }, l)))),
        h('details', {}, h('summary', { class: 'small' }, 'الگویی که مدل علامت نزد ولی شما در تصویر می‌بینید'),
          h('div', { class: 'choices' }, others.map((f) => h('button', { type: 'button', class: 'choice', onclick: (e) => {
            if (missed.has(f.key)) missed.delete(f.key); else missed.add(f.key);
            e.currentTarget.classList.toggle('on');
          } }, f.label)))),
        h('div', { class: 'row' }, h('label', {}, 'در مجموع:'), useful, note),
        h('button', { class: 'btn small', onclick: guard(async () => {
          a = await api('POST', `/v1/cxr/${a.id}/feedback`, { verdicts, missed: [...missed], overall: useful.value || null, note: note.value });
          renderFeedback();
          toast('نظر شما ثبت شد');
        }) }, 'ثبت نظر'));
    };
    renderFeedback();
    show(flagged.find((f) => f.overlay_url));
    return h('div', { class: 'ai-box stack' },
      h('div', { class: 'banner warn small' }, '⚠️ ', a.disclaimer),
      ...a.quality.map((q) => h('div', { class: 'banner danger small' }, q.message)),
      flagged.length
        ? h('div', {}, h('b', {}, 'الگوهای علامت‌خورده برای بررسی شما:'),
          h('ul', { class: 'list' }, flagged.map((f) => h('li', { class: 'row' },
            h('span', { class: `pill ${TIER_FA[f.tier][1]}` }, TIER_FA[f.tier][0]), h('span', { class: 'grow' }, f.label, h('span', { class: 'muted small ltr' }, ` ${f.key}`)),
            h('span', { class: 'muted small' }, `امتیاز ${fa(Math.round(f.score * 100))}٪`),
            f.overlay_url ? h('button', { class: 'btn small', onclick: () => show(f) }, 'نمایش ناحیه') : null))))
        : h('p', {}, 'مدل الگوی برجسته‌ای علامت نزد. این به معنی طبیعی بودن تصویر نیست.'),
      imgBox,
      h('details', {}, h('summary', { class: 'small' }, 'امتیاز همه الگوها'),
        h('table', {}, h('tbody', {}, a.findings.map((f) => h('tr', {}, h('td', {}, f.label), h('td', { class: 'ltr' }, f.score.toFixed(2))))))),
      h('p', { class: 'muted small' }, `مدل: ${a.model} · ${fmt.short(a.created_at)}`),
      fbBox);
  }
  function cxrBox(rec) {
    const box = h('div', { class: 'stack' });
    const images = rec.files.filter((f) => f.mime.startsWith('image/'));
    if (!images.length) return null;
    const list = h('div', { class: 'stack' });
    api('GET', `/v1/records/${rec.id}/cxr`).then((r) => list.replaceChildren(...r.items.slice(0, 3).map(cxrView))).catch(() => {});
    box.append(h('div', { class: 'row' }, ...images.map((f, i) => h('button', { class: 'btn small', onclick: guard(async (e) => {
      if (!confirm('این تصویر، رادیوگرافی روبه‌روی (PA یا AP) قفسه سینه است؟\nنتیجه فقط یک ابزار کمکی پژوهشی برای شماست و به بیمار نمایش داده نمی‌شود.')) return;
      const btn = e.currentTarget; btn.disabled = true; btn.textContent = '⏳ در حال تحلیل…';
      try {
        list.prepend(cxrView(await api('POST', `/v1/records/${rec.id}/cxr`, { file_id: f.id, confirm_frontal_cxr: true })));
      } finally { btn.disabled = false; btn.textContent = `🫁 تحلیل الگوی قفسه سینه${images.length > 1 ? ` (تصویر ${fa(i + 1)})` : ''} — پژوهشی`; }
    }) }, `🫁 تحلیل الگوی قفسه سینه${images.length > 1 ? ` (تصویر ${fa(i + 1)})` : ''} — پژوهشی`))), list);
    return box;
  }
  // Admin: pilot accuracy of the chest X-ray aid, from physicians' agree/disagree feedback.
  x.cxrStats = async () => {
    const s = await api('GET', '/v1/admin/cxr-stats');
    if (!s.enabled && !s.analyses) return h('div');
    return h('div', { class: 'card stack' }, h('h2', {}, '🫁 فاز آزمایشی تحلیل عکس قفسه سینه'),
      h('p', { class: 'muted' }, `${fa(s.analyses)} تحلیل · ${fa(s.reviewed)} مورد با نظر پزشک · «مفید بود»: ${fa(s.useful)}`),
      s.items.length ? h('div', { style: 'overflow-x:auto' }, h('table', {},
        h('thead', {}, h('tr', {}, ['الگو', 'علامت‌خورده', 'موافق', 'مخالف', 'نامطمئن', 'جاافتاده', 'توافق پزشک'].map((c) => h('th', {}, c)))),
        h('tbody', {}, s.items.map((r) => h('tr', {}, h('td', {}, r.label), h('td', {}, fa(r.flagged)), h('td', {}, fa(r.agree)), h('td', {}, fa(r.disagree)),
          h('td', {}, fa(r.unsure)), h('td', {}, fa(r.missed)), h('td', {}, r.agreement == null ? '—' : `${fa(r.agreement)}٪`)))))) : h('div', { class: 'empty' }, 'هنوز داده‌ای ثبت نشده است.'),
      h('p', { class: 'muted small' }, '«توافق پزشک» = موافق ÷ (موافق + مخالف) برای الگوهای علامت‌خورده؛ «جاافتاده» = الگوهایی که پزشک دید و مدل علامت نزد. این اعداد برای تصمیم درباره ادامه استفاده و مستندات مجوز به کار می‌رود.'));
  };
  let cxrEnabled = null;
  const cxrOn = async () => (cxrEnabled ??= (await api('GET', '/v1/config').catch(() => ({}))).cxr === true);

  x.doctorRecords = async (appointmentId) => {
    const r = await api('GET', `/v1/records?appointment_id=${appointmentId}`);
    const cxrAvailable = await cxrOn();
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
        cxrAvailable && rec.category === 'imaging' ? cxrBox(rec) : null,
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
