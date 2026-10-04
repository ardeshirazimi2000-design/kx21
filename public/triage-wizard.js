// Visual triage wizard (SOCRATES-structured): who → where (body map) → safety questions →
// pain / onset / duration → optional measured vitals → review. Any "yes" to an emergency
// question interrupts the flow immediately with the 115 screen (no waiting for the last step).
// Body-map sides are the PATIENT's sides and are never mirrored by the RTL layout.

const STEPS = ['بیمار', 'محل مشکل', 'سؤالات ایمنی', 'شدت و زمان', 'علائم حیاتی', 'مرور و ارسال'];
const DURATION_LABELS = { lt_6h: 'کمتر از ۶ ساعت', lt_24h: 'کمتر از یک روز', d1_3: '۱ تا ۳ روز', d4_7: '۴ تا ۷ روز', w1_4: '۱ تا ۴ هفته', gt_month: 'بیش از یک ماه' };
const NRS_ANCHORS = { 0: 'بدون درد', 2: 'خفیف', 5: 'متوسط', 7: 'شدید', 10: 'بدترین درد ممکن' };
const NRS_COLORS = ['#1a7f37', '#2f8f3a', '#4c9a2a', '#7a9a1a', '#a58a00', '#b97a00', '#c96500', '#d24f12', '#c93a1a', '#b42318', '#9b1c12'];

// Body map geometry (viewBox 0 0 200 440). Patient's right is on the viewer's LEFT in the
// front view and on the viewer's RIGHT in the back view.
const SHAPES = {
  front: [
    ['head', 'ellipse', { cx: 100, cy: 36, rx: 26, ry: 30 }],
    ['face_eyes', 'ellipse', { cx: 100, cy: 44, rx: 17, ry: 13 }],
    ['ear', 'ellipse', { cx: 72, cy: 42, rx: 5, ry: 9 }],
    ['ear', 'ellipse', { cx: 128, cy: 42, rx: 5, ry: 9 }],
    ['throat_neck', 'rect', { x: 87, y: 66, width: 26, height: 22, rx: 6 }],
    ['chest', 'path', { d: 'M60 92 Q100 82 140 92 L136 150 L64 150 Z' }],
    ['abdomen_upper', 'rect', { x: 66, y: 150, width: 68, height: 38, rx: 4 }],
    ['abdomen_lower', 'rect', { x: 68, y: 188, width: 64, height: 36, rx: 4 }],
    ['pelvis', 'path', { d: 'M68 224 L132 224 L126 256 L100 262 L74 256 Z' }],
    ['arm_right', 'path', { d: 'M58 94 L46 100 L30 190 L24 250 L38 252 L48 194 L62 140 Z' }],
    ['arm_left', 'path', { d: 'M142 94 L154 100 L170 190 L176 250 L162 252 L152 194 L138 140 Z' }],
    ['leg_right', 'path', { d: 'M74 258 L99 264 L96 340 L92 424 L74 424 L72 340 Z' }],
    ['leg_left', 'path', { d: 'M126 258 L101 264 L104 340 L108 424 L126 424 L128 340 Z' }],
  ],
  back: [
    ['head', 'ellipse', { cx: 100, cy: 38, rx: 26, ry: 30 }],
    ['ear', 'ellipse', { cx: 72, cy: 42, rx: 5, ry: 9 }],
    ['ear', 'ellipse', { cx: 128, cy: 42, rx: 5, ry: 9 }],
    ['throat_neck', 'rect', { x: 87, y: 66, width: 26, height: 22, rx: 6 }],
    ['back_upper', 'path', { d: 'M60 92 Q100 82 140 92 L134 170 L66 170 Z' }],
    ['back_lower', 'path', { d: 'M66 170 L134 170 L130 236 L70 236 Z' }],
    ['pelvis', 'path', { d: 'M70 236 L130 236 L126 258 L100 264 L74 258 Z' }],
    ['arm_left', 'path', { d: 'M58 94 L46 100 L30 190 L24 250 L38 252 L48 194 L62 140 Z' }],
    ['arm_right', 'path', { d: 'M142 94 L154 100 L170 190 L176 250 L162 252 L152 194 L138 140 Z' }],
    ['leg_left', 'path', { d: 'M74 260 L99 266 L96 340 L92 424 L74 424 L72 340 Z' }],
    ['leg_right', 'path', { d: 'M126 260 L101 266 L104 340 L108 424 L126 424 L128 340 Z' }],
  ],
};
const SVGNS = 'http://www.w3.org/2000/svg';

export async function openTriageWizard({ h, api, toast, fa, onSubmit }) {
  const cat = await api('GET', '/v1/ai/triage/catalog');
  const regionLabel = Object.fromEntries(cat.regions.map((r) => [r.id, r.label]));
  const symptomLabel = Object.fromEntries(cat.symptoms.map((s) => [s.id, s.label]));
  let profile = null;
  try { profile = await api('GET', '/v1/patients/me'); } catch { /* profile optional */ }
  const ageFromDob = (dob) => (dob ? Math.floor((Date.now() - Date.parse(dob)) / (365.25 * 864e5)) : null);

  const form = {
    who: 'self', age_years: ageFromDob(profile?.dob), sex: profile?.gender ?? null, may_be_pregnant: false,
    regions: [], symptoms: [], answers: {}, severity: null, onset: null, duration: null, vitals: {}, note: '',
  };
  let step = 0;
  let view = 'front';

  const overlay = h('div', { class: 'wizard-overlay', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'بررسی علائم' });
  const sheet = h('div', { class: 'wizard' });
  overlay.append(sheet);
  document.body.append(overlay);
  const close = () => { overlay.remove(); document.removeEventListener('keydown', onKey); };
  const onKey = (e) => { if (e.key === 'Escape') close(); };
  document.addEventListener('keydown', onKey);

  const questions = () => cat.questions.filter((q) => {
    const groups = new Set(['always', ...form.regions.map((r) => cat.regions.find((x) => x.id === r).group), ...form.symptoms.map((s) => cat.symptoms.find((x) => x.id === s).group)]);
    return q.groups.some((g) => groups.has(g)) && (!q.when || (q.when === 'may_be_pregnant' && form.may_be_pregnant));
  });

  const chip = (label, active, onclick, extra = {}) =>
    h('button', { type: 'button', class: `choice${active ? ' on' : ''}`, 'aria-pressed': String(!!active), onclick, ...extra }, label);

  const submit = async (emergency = false) => {
    const payload = { ...form, answers: Object.fromEntries(Object.entries(form.answers).filter(([k]) => questions().some((q) => q.id === k))) };
    if (!emergency) close(); // the emergency screen stays up until the patient closes it
    await onSubmit(payload, { emergency });
  };

  function emergencyScreen(q) {
    sheet.replaceChildren(h('div', { class: 'wizard-emergency' },
      h('div', { class: 'big' }, '⚠️'),
      h('h2', {}, 'این علامت ممکن است اورژانسی باشد'),
      h('p', {}, q.flag ?? q.text),
      h('a', { class: 'btn call', href: 'tel:115' }, '📞 همین حالا با اورژانس ۱۱۵ تماس بگیرید'),
      h('p', { class: 'small' }, 'اگر تنها هستید در را باز بگذارید و از کسی کمک بخواهید. اطلاعات شما برای اپراتور انسانی ارسال شد تا با شما تماس بگیرد.'),
      h('button', { class: 'btn', onclick: close }, 'بستن و مشاهده گفتگو')));
    // Escalate right away; the server re-checks the same rules and records the triage.
    submit(true).catch(() => toast('ارسال به اپراتور ناموفق بود؛ لطفاً با ۱۱۵ تماس بگیرید', true));
  }

  function bodyMap() {
    const svg = document.createElementNS(SVGNS, 'svg');
    svg.setAttribute('viewBox', '0 0 200 440');
    svg.setAttribute('class', 'bodymap');
    svg.setAttribute('role', 'group');
    svg.setAttribute('aria-label', view === 'front' ? 'نقشه بدن از جلو' : 'نقشه بدن از پشت');
    for (const [id, tag, attrs] of SHAPES[view]) {
      const el = document.createElementNS(SVGNS, tag);
      for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
      const on = form.regions.includes(id);
      el.setAttribute('class', `region${on ? ' on' : ''}`);
      el.setAttribute('tabindex', '0');
      el.setAttribute('role', 'button');
      el.setAttribute('aria-pressed', String(on));
      el.setAttribute('aria-label', regionLabel[id]);
      const title = document.createElementNS(SVGNS, 'title');
      title.textContent = regionLabel[id];
      el.append(title);
      const toggle = () => { form.regions = on ? form.regions.filter((r) => r !== id) : [...form.regions, id]; render(); };
      el.addEventListener('click', toggle);
      el.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); } });
      svg.append(el);
    }
    // side labels (patient's perspective)
    const side = (x, text) => { const t = document.createElementNS(SVGNS, 'text'); t.setAttribute('x', x); t.setAttribute('y', 300); t.setAttribute('class', 'side'); t.setAttribute('text-anchor', 'middle'); t.textContent = text; return t; };
    svg.append(side(12, view === 'front' ? 'راست' : 'چپ'), side(188, view === 'front' ? 'چپ' : 'راست'));
    return h('div', { class: 'bodymap-wrap', dir: 'ltr' }, svg);
  }

  const STEP_VIEWS = [
    // 0 — who
    () => [
      h('h3', {}, 'این ارزیابی برای چه کسی است؟'),
      h('div', { class: 'choices' }, [['self', 'خودم'], ['child', 'کودکم'], ['other', 'شخص دیگر']].map(([v, l]) => chip(l, form.who === v, () => {
        form.who = v;
        if (v === 'self') { form.age_years = ageFromDob(profile?.dob); form.sex = profile?.gender ?? null; } else { form.age_years = null; form.sex = null; }
        render();
      }))),
      h('label', { for: 'tw-age' }, form.who === 'child' ? 'سن کودک (سال؛ برای زیر یک سال مثلاً ۰٫۵)' : 'سن (سال)'),
      h('input', { id: 'tw-age', type: 'number', inputmode: 'decimal', min: 0, max: 120, step: 'any', value: form.age_years ?? '', oninput: (e) => { form.age_years = e.target.value === '' ? null : Number(e.target.value); refreshFoot(); } }),
      h('label', {}, 'جنسیت'),
      h('div', { class: 'choices' }, [['female', 'زن'], ['male', 'مرد'], ['other', 'سایر']].map(([v, l]) => chip(l, form.sex === v, () => { form.sex = v; if (v !== 'female') form.may_be_pregnant = false; render(); }))),
      form.sex === 'female' && (form.age_years == null || (form.age_years >= 12 && form.age_years <= 55))
        ? h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: form.may_be_pregnant, onchange: (e) => { form.may_be_pregnant = e.target.checked; } }), 'باردار هستم یا ممکن است باردار باشم') : null,
    ],
    // 1 — where
    () => [
      h('h3', {}, 'کجای بدن مشکل دارد؟'),
      h('p', { class: 'muted' }, 'روی نقشه بزنید؛ می‌توانید چند ناحیه را انتخاب کنید. راست و چپ از دید خود بیمار است.'),
      h('div', { class: 'choices center' }, chip('جلو', view === 'front', () => { view = 'front'; render(); }), chip('پشت', view === 'back', () => { view = 'back'; render(); })),
      bodyMap(),
      h('h3', {}, 'یا علائم عمومی'),
      h('div', { class: 'choices' }, cat.symptoms.map((s) => chip(s.label, form.symptoms.includes(s.id), () => {
        form.symptoms = form.symptoms.includes(s.id) ? form.symptoms.filter((x) => x !== s.id) : [...form.symptoms, s.id]; render();
      }))),
      form.regions.length || form.symptoms.length ? h('div', { class: 'selected' }, 'انتخاب‌شده: ',
        [...form.regions.map((r) => [r, regionLabel[r], 'regions']), ...form.symptoms.map((s) => [s, symptomLabel[s], 'symptoms'])].map(([id, l, key]) =>
          h('span', { class: 'tag' }, l, h('button', { type: 'button', 'aria-label': `حذف ${l}`, onclick: () => { form[key] = form[key].filter((x) => x !== id); render(); } }, '✕')))) : null,
    ],
    // 2 — safety questions
    () => [
      h('h3', {}, 'چند سؤال کوتاه برای ایمنی شما'),
      h('p', { class: 'muted' }, 'اگر مطمئن نیستید، «مطمئن نیستم» را بزنید.'),
      questions().map((q) => h('div', { class: `question${q.level === 'emergency' ? ' red' : ''}` },
        h('p', {}, q.text),
        h('div', { class: 'choices' }, [['yes', 'بله'], ['no', 'خیر'], ['unsure', 'مطمئن نیستم']].map(([v, l]) => chip(l, form.answers[q.id] === v, () => {
          form.answers[q.id] = v;
          if (v === 'yes' && q.level === 'emergency') return emergencyScreen(q);
          render();
        }))))),
    ],
    // 3 — severity / onset / duration
    () => [
      h('h3', {}, 'شدت درد یا ناراحتی (۰ تا ۱۰)'),
      h('div', { class: 'nrs', dir: 'ltr', role: 'radiogroup', 'aria-label': 'شدت از صفر تا ده' }, Array.from({ length: 11 }, (_, i) =>
        h('button', { type: 'button', role: 'radio', 'aria-checked': String(form.severity === i), class: `nrs-btn${form.severity === i ? ' on' : ''}`, style: `--c:${NRS_COLORS[i]}`, onclick: () => { form.severity = i; render(); } }, fa(i)))),
      h('div', { class: 'nrs-anchors', dir: 'ltr' }, Object.entries(NRS_ANCHORS).map(([i, l]) => h('span', { style: `left:${(Number(i) / 10) * 100}%` }, l))),
      form.severity != null ? h('p', { class: 'nrs-current' }, `انتخاب شما: ${fa(form.severity)} از ۱۰`) : null,
      h('h3', {}, 'شروع علائم'),
      h('div', { class: 'choices' }, [['sudden', 'ناگهانی (در چند ثانیه یا دقیقه)'], ['gradual', 'تدریجی'], ['unknown', 'نمی‌دانم']].map(([v, l]) => chip(l, form.onset === v, () => { form.onset = v; render(); }))),
      h('h3', {}, 'از چه زمانی؟'),
      h('div', { class: 'choices' }, Object.entries(DURATION_LABELS).map(([v, l]) => chip(l, form.duration === v, () => { form.duration = v; render(); }))),
    ],
    // 4 — vitals (optional)
    () => {
      const inp = (key, label, unit, ph) => h('div', {}, h('label', { for: `tw-${key}` }, `${label} (${unit})`),
        h('input', { id: `tw-${key}`, type: 'number', inputmode: 'decimal', step: 'any', placeholder: ph, value: form.vitals[key] ?? '',
          min: cat.vital_ranges[key][0], max: cat.vital_ranges[key][1],
          oninput: (e) => { if (e.target.value === '') delete form.vitals[key]; else form.vitals[key] = Number(e.target.value); refreshFoot(); } }));
      return [
        h('h3', {}, 'علائم حیاتی (اختیاری)'),
        h('div', { class: 'banner info' }, 'فقط اعدادی را وارد کنید که همین حالا با دستگاه (دماسنج، فشارسنج یا پالس‌اکسیمتر) اندازه گرفته‌اید. گوشی نمی‌تواند این مقادیر را اندازه بگیرد. اگر دستگاه ندارید، این مرحله را رد کنید.'),
        h('div', { class: 'grid2' }, inp('temp_c', 'دمای بدن', '°C', 'مثلاً 37.5'), inp('spo2', 'اکسیژن خون', '%', 'مثلاً 97'),
          inp('sys', 'فشار خون بالا (سیستولیک)', 'mmHg', 'مثلاً 120'), inp('dia', 'فشار خون پایین (دیاستولیک)', 'mmHg', 'مثلاً 80'), inp('hr', 'ضربان قلب', 'در دقیقه', 'مثلاً 75')),
      ];
    },
    // 5 — review
    () => [
      h('h3', {}, 'مرور اطلاعات'),
      h('ul', { class: 'review' },
        h('li', {}, h('b', {}, 'بیمار: '), { self: 'خودم', child: 'کودکم', other: 'شخص دیگر' }[form.who], form.age_years != null ? `، ${fa(form.age_years)} ساله` : ''),
        h('li', {}, h('b', {}, 'محل/علائم: '), [...form.regions.map((r) => regionLabel[r]), ...form.symptoms.map((s) => symptomLabel[s])].join('، ') || '—'),
        h('li', {}, h('b', {}, 'شدت: '), form.severity != null ? `${fa(form.severity)} از ۱۰` : '—', ' · ', h('b', {}, 'مدت: '), DURATION_LABELS[form.duration] ?? '—'),
        Object.keys(form.vitals).length ? h('li', {}, h('b', {}, 'علائم حیاتی: '), Object.entries(form.vitals).map(([k, v]) => `${k}: ${fa(v)}`).join('، ')) : null),
      h('label', { for: 'tw-note' }, 'توضیح بیشتر (اختیاری)'),
      h('textarea', { id: 'tw-note', rows: 3, maxlength: 500, placeholder: 'مثلاً «بعد از غذا بدتر می‌شود»', oninput: (e) => { form.note = e.target.value; } }, form.note),
      h('p', { class: 'muted' }, 'این ارزیابی اولیه است و تشخیص پزشکی نیست. نتیجه برای پزشک معالج شما قابل مشاهده است.'),
    ],
  ];

  const canNext = () => {
    if (step === 0) return form.age_years != null && form.age_years >= 0;
    if (step === 1) return form.regions.length + form.symptoms.length > 0;
    if (step === 2) return questions().every((q) => form.answers[q.id]);
    if (step === 3) return form.duration != null && form.onset != null;
    if (step === 4) {
      return Object.entries(form.vitals).every(([k, v]) => v >= cat.vital_ranges[k][0] && v <= cat.vital_ranges[k][1]);
    }
    return true;
  };
  const hint = ['سن را وارد کنید', 'حداقل یک ناحیه یا علامت را انتخاب کنید', 'به همه سؤال‌ها پاسخ دهید', 'شروع و مدت علائم را انتخاب کنید', 'مقادیر واردشده خارج از محدوده معقول است', ''];

  let footEl = null;
  let body = null;
  const foot = () => h('div', { class: 'wizard-foot' },
    step > 0 ? h('button', { class: 'btn', onclick: () => { step--; render(); } }, 'قبلی') : h('span'),
    h('span', { class: 'muted small', role: 'status' }, canNext() ? '' : hint[step]),
    step < STEPS.length - 1
      ? h('button', { class: 'btn primary', disabled: !canNext(), onclick: () => { step++; render(); body.scrollTop = 0; } }, step === 4 && !Object.keys(form.vitals).length ? 'رد شدن' : 'بعدی')
      : h('button', { class: 'btn primary', onclick: () => submit(false) }, 'ارسال برای ارزیابی'));
  // Text inputs update the footer only, so the field keeps focus while typing.
  function refreshFoot() { const f = foot(); footEl.replaceWith(f); footEl = f; }

  function render() {
    body = h('div', { class: 'wizard-body' }, STEP_VIEWS[step]());
    footEl = foot();
    sheet.replaceChildren(
      h('div', { class: 'wizard-head' },
        h('button', { class: 'btn small', 'aria-label': 'بستن', onclick: close }, '✕'),
        h('b', {}, 'بررسی علائم'),
        h('span', { class: 'muted' }, `مرحله ${fa(step + 1)} از ${fa(STEPS.length)}`)),
      h('ol', { class: 'stepper' }, STEPS.map((s, i) => h('li', { class: i < step ? 'done' : i === step ? 'current' : '', 'aria-current': i === step ? 'step' : null }, h('span', {}, i < step ? '✓' : fa(i + 1)), h('small', {}, s)))),
      body,
      footEl);
  }
  render();
}

// Result card rendered in the chat after the server's triage_result event.
export function triageResultCard(h, data) {
  const a = data.acuity;
  return h('div', { class: `triage-card ${a.color}` },
    h('div', { class: 'triage-level' }, h('span', { class: 'dot' }), `سطح فوریت: ${a.label}`, h('span', { class: 'tf' }, a.timeframe)),
    h('p', {}, a.action),
    data.red_flags?.length ? h('p', { class: 'flags' }, 'علائم هشدار: ', data.red_flags.join('؛ ')) : null,
    data.safety_net?.length ? h('details', { open: a.color !== 'blue' ? true : null }, h('summary', {}, 'چه زمانی فوراً کمک بگیرم؟'), h('ul', {}, data.safety_net.map((s) => h('li', {}, s)))) : null,
    h('p', { class: 'small' }, 'ارزیابی اولیه بر اساس قواعد تأییدشده؛ تشخیص پزشکی نیست.'));
}
