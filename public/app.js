// Web client (Next.js in the design doc; dependency-free SPA here). RTL Persian UI for
// patients, doctors and operators/admins against the /v1 REST + SSE API.

import { openTriageWizard, triageResultCard } from './triage-wizard.js';
import { jalaliPicker, formatJalaliDate, todayJalali, isoToJalali, MONTHS } from './jalali.js';

// ---------------- utilities ----------------
const $app = document.getElementById('app');
const $tabs = document.getElementById('tabs');
const $user = document.getElementById('userbox');

function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'class') el.className = v;
    else if (k === 'value') el.value = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat(Infinity)) {
    if (c == null || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

const store = {
  get(k, d = null) { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* private mode */ } },
  del(k) { try { localStorage.removeItem(k); } catch { /* ignore */ } },
};

let toastTimer;
function toast(msg, error = false) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.className = `toast show${error ? ' error' : ''}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.className = 'toast'), 3500);
}

const fa = (n) => String(n).replace(/\d/g, (d) => '۰۱۲۳۴۵۶۷۸۹'[d]);
const fmt = {
  dt: (iso) => new Intl.DateTimeFormat('fa-IR-u-ca-persian', { timeZone: 'Asia/Tehran', weekday: 'short', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' }).format(new Date(iso)),
  day: (iso) => new Intl.DateTimeFormat('fa-IR-u-ca-persian', { timeZone: 'Asia/Tehran', weekday: 'long', day: 'numeric', month: 'long' }).format(new Date(iso)),
  time: (iso) => new Intl.DateTimeFormat('fa-IR-u-ca-persian', { timeZone: 'Asia/Tehran', hour: '2-digit', minute: '2-digit' }).format(new Date(iso)),
  short: (iso) => new Intl.DateTimeFormat('fa-IR-u-ca-persian', { timeZone: 'Asia/Tehran', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(new Date(iso)),
};
const tehranDayKey = (iso) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Tehran' }).format(new Date(iso));

const LABELS = {
  status: { pending: ['در انتظار', 'warn'], confirmed: ['تأییدشده', 'ok'], cancelled: ['لغوشده', ''], completed: ['انجام‌شده', 'info'], no_show: ['عدم حضور', 'danger'] },
  channel: { video: 'ویدیویی', audio: 'صوتی', chat: 'متنی' },
  mode: { INFO_MODE: 'اطلاع‌رسانی', TRIAGE_MODE: 'بررسی علائم', BOOKING_MODE: 'رزرو نوبت', EMERGENCY_MODE: 'اورژانس', FOLLOWUP_MODE: 'پیگیری' },
  urgency: { self_care: ['مراقبت در منزل', 'ok'], routine: ['غیرفوری', 'info'], urgent: ['فوری', 'warn'], emergency: ['اورژانسی', 'danger'] },
  consent: {
    telehealth: ['ویزیت از راه دور', 'برای رزرو و انجام ویزیت آنلاین لازم است.'],
    ai_history_access: ['دسترسی دستیار به سوابق', 'دستیار برای ارزیابی دقیق‌تر علائم، حساسیت‌ها و بیماری‌های زمینه‌ای شما را می‌خواند.'],
    recording: ['ضبط ویزیت', 'ویزیت برای پرونده شما ضبط می‌شود.'],
    ai_training: ['استفاده برای بهبود مدل', 'داده بی‌نام‌شده شما برای بهبود دستیار استفاده شود.'],
  },
  tool: {
    check_availability: 'بررسی زمان‌های آزاد', book_appointment: 'ثبت نوبت', fetch_patient_history: 'خواندن سوابق (با رضایت شما)',
    escalate_to_human: 'ارجاع به اپراتور', 'triage_engine.assess': 'ارزیابی فوریت', create_prescription_draft: 'پیش‌نویس نسخه',
  },
  role: { patient: 'بیمار', doctor: 'پزشک', operator: 'اپراتور', admin: 'مدیر' },
};
const statusPill = (s) => { const [t, c] = LABELS.status[s] ?? [s, '']; return h('span', { class: `pill ${c}` }, t); };
const urgencyPill = (u) => { const [t, c] = LABELS.urgency[u] ?? [u, '']; return h('span', { class: `pill ${c}` }, t); };

// ---------------- API ----------------
// Web: same origin. Native app (Capacitor): the server address comes from the build
// (config.js) or is entered once on the "server" screen and kept on the device.
const IS_NATIVE = !!window.Capacitor?.isNativePlatform?.();
let API_BASE = (store.get('api_base') ?? window.TELEHEALTH_API_BASE ?? '').replace(/\/$/, '');
const apiUrl = (path) => API_BASE + path;
let session = store.get('session');
let config = { dev_mode: false };

class ApiErr extends Error {
  constructor(status, body) { super(body?.message || `HTTP ${status}`); this.status = status; this.code = body?.code; this.body = body; }
}

async function api(method, path, body, headers = {}) {
  const res = await fetch(apiUrl(path), {
    method,
    headers: {
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(session?.access_token ? { Authorization: `Bearer ${session.access_token}` } : {}),
      ...headers,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 204) return null;
  const data = await res.json().catch(() => null);
  if (res.status === 401 && session) { logout(); throw new ApiErr(401, data); }
  if (!res.ok) throw new ApiErr(res.status, data);
  return data;
}

const guard = (fn) => async (...args) => {
  try { return await fn(...args); } catch (e) { toast(e.message || 'خطا', true); console.error(e); }
};

function setSession(s) { session = s; store.set('session', s); }
function logout() { setSession(null); store.del('session'); route('login'); }

// PWA install (Android Chrome fires beforeinstallprompt; iOS needs "Add to Home Screen").
let deferredInstall = null;
window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); deferredInstall = e; });
function installButton() {
  if (window.matchMedia('(display-mode: standalone)').matches) return null;
  const isIos = /iphone|ipad|ipod/i.test(navigator.userAgent);
  return h('button', {
    class: 'btn small', type: 'button', onclick: async () => {
      if (deferredInstall) { deferredInstall.prompt(); deferredInstall = null; return; }
      toast(isIos ? 'در Safari دکمه «اشتراک‌گذاری» و سپس «Add to Home Screen» را بزنید' : 'از منوی مرورگر گزینه «نصب برنامه» یا «Add to Home screen» را انتخاب کنید');
    },
  }, '📲 نصب اپ روی گوشی');
}

// ---------------- router ----------------
let current = { view: null, cleanup: [] };
const TABS = {
  patient: [['assistant', 'دستیار هوشمند'], ['book', 'رزرو نوبت'], ['appointments', 'نوبت‌های من'], ['prescriptions', 'نسخه‌ها'], ['inbox', 'پیام‌ها'], ['profile', 'پروفایل و حریم خصوصی']],
  doctor: [['doctor-appointments', 'نوبت‌ها'], ['calendar', 'تقویم'], ['doctor-rx', 'نسخه‌ها'], ['inbox', 'اعلان‌ها']],
  operator: [['escalations', 'درخواست‌های ارجاع'], ['stats', 'آمار']],
  admin: [['escalations', 'درخواست‌های ارجاع'], ['stats', 'آمار'], ['audit', 'لاگ ممیزی'], ['staff', 'کاربران']],
};

function renderChrome() {
  $user.replaceChildren();
  $tabs.replaceChildren();
  if (!session) return;
  const u = session.user;
  $user.append(h('span', {}, `${u.full_name || fa(u.phone)} · ${LABELS.role[u.role]}`), h('button', { class: 'btn small', onclick: logout }, 'خروج'));
  for (const [id, label] of TABS[u.role] ?? []) {
    $tabs.append(h('button', { 'aria-current': current.view === id ? 'page' : null, onclick: () => route(id) }, label));
  }
}

function route(view, arg) {
  for (const c of current.cleanup) c();
  current = { view, arg, cleanup: [] };
  if (!['login', 'server'].includes(view) && !session) view = current.view = 'login';
  location.hash = ['login', 'server'].includes(view) ? '' : (arg ? `${view}/${arg}` : view);
  renderChrome();
  $app.replaceChildren();
  const fn = VIEWS[view] ?? VIEWS.home;
  Promise.resolve(fn(arg)).catch((e) => { toast(e.message, true); console.error(e); });
}
const onCleanup = (fn) => current.cleanup.push(fn);
const every = (ms, fn) => { const id = setInterval(fn, ms); onCleanup(() => clearInterval(id)); };

// ---------------- views ----------------
const VIEWS = {};

VIEWS.home = async () => {
  if (!session) return route('login');
  const r = session.user.role;
  if (r === 'patient') {
    try { await api('GET', '/v1/patients/me'); } catch (e) { if (e.code === 'profile_incomplete') return route('onboarding'); throw e; }
    return route('assistant');
  }
  route(TABS[r][0][0]);
};

VIEWS.login = () => {
  let phone = '';
  let mfaToken = null;
  const box = h('div', { class: 'card narrow stack' });
  const hint = h('div', { class: 'muted' });
  const showDevCode = (code) => { if (code) hint.replaceChildren(h('div', { class: 'banner info' }, `محیط آزمایشی — کد: ${fa(code)}`)); };

  const stepPhone = () => {
    const input = h('input', { type: 'tel', dir: 'ltr', placeholder: '09121234567', autocomplete: 'tel', inputmode: 'tel' });
    const submit = guard(async (e) => {
      e.preventDefault();
      phone = input.value.trim();
      const r = await api('POST', '/v1/auth/otp/request', { phone });
      stepCode();
      showDevCode(r.dev_code);
    });
    box.replaceChildren(
      h('h2', {}, 'ورود / ثبت‌نام'),
      h('p', { class: 'muted' }, 'شماره موبایل خود را وارد کنید. کد تأیید پیامک می‌شود.'),
      h('form', { onsubmit: submit, class: 'stack' }, h('label', {}, 'شماره موبایل'), input, h('button', { class: 'btn primary block' }, 'دریافت کد')),
      config.dev_mode ? h('div', { class: 'banner info' },
        h('b', {}, 'حساب‌های نمونه: '), 'هر شماره جدید = بیمار · پزشک عمومی ', h('bdi', {}, '09120000001'), ' · پزشک قلب ', h('bdi', {}, '09120000002'),
        ' · اپراتور ', h('bdi', {}, '09120000009'), ' · مدیر ', h('bdi', {}, '09120000010')) : null,
      IS_NATIVE ? h('button', { class: 'btn small', onclick: () => route('server') }, `سرور: ${API_BASE.replace(/^https?:\/\//, '')} — تغییر`) : installButton(),
    );
    input.focus();
  };

  const stepCode = () => {
    const input = h('input', { type: 'text', dir: 'ltr', inputmode: 'numeric', autocomplete: 'one-time-code', maxlength: 6 });
    const submit = guard(async (e) => {
      e.preventDefault();
      const r = await api('POST', '/v1/auth/otp/verify', { phone, code: input.value });
      if (r.mfa_required) { mfaToken = r.mfa_token; stepMfa(); showDevCode(r.dev_code); return; }
      done(r);
    });
    box.replaceChildren(
      h('h2', {}, 'کد تأیید'),
      h('p', { class: 'muted' }, `کد ۶ رقمی ارسال‌شده به ${fa(phone)} را وارد کنید.`),
      hint,
      h('form', { onsubmit: submit, class: 'stack' }, input, h('button', { class: 'btn primary block' }, 'ورود')),
      h('button', { class: 'btn small', onclick: stepPhone }, 'تغییر شماره'),
    );
    input.focus();
  };

  const stepMfa = () => {
    const input = h('input', { type: 'text', dir: 'ltr', inputmode: 'numeric', maxlength: 6 });
    const submit = guard(async (e) => {
      e.preventDefault();
      done(await api('POST', '/v1/auth/mfa/verify', { mfa_token: mfaToken, code: input.value }));
    });
    box.replaceChildren(
      h('h2', {}, 'تأیید دومرحله‌ای'),
      h('p', { class: 'muted' }, 'برای حساب‌های پزشک و کادر، کد دوم به ایمیل شما ارسال شد.'),
      hint,
      h('form', { onsubmit: submit, class: 'stack' }, input, h('button', { class: 'btn primary block' }, 'تأیید')),
    );
    input.focus();
  };

  const done = (r) => { setSession(r); route('home'); };
  stepPhone();
  $app.append(box);
};

VIEWS.onboarding = () => {
  const f = {
    full_name: h('input', { type: 'text', autocomplete: 'name' }),
    national_id: h('input', { type: 'text', dir: 'ltr', inputmode: 'numeric', maxlength: 10 }),
    dob: { value: null }, // Gregorian ISO from the Jalali picker
    gender: h('select', {}, h('option', { value: '' }, '—'), h('option', { value: 'female' }, 'زن'), h('option', { value: 'male' }, 'مرد'), h('option', { value: 'other' }, 'سایر')),
    allergies: h('input', { type: 'text', placeholder: 'مثلاً پنی‌سیلین، بادام زمینی' }),
    chronic: h('input', { type: 'text', placeholder: 'مثلاً دیابت، فشار خون' }),
  };
  const consents = Object.fromEntries(Object.keys(LABELS.consent).map((k) => [k, h('input', { type: 'checkbox', checked: k === 'telehealth' })]));
  const split = (s) => s.split(/[،,]/).map((x) => x.trim()).filter(Boolean);
  const submit = guard(async (e) => {
    e.preventDefault();
    if (!consents.telehealth.checked) return toast('برای استفاده از ویزیت آنلاین، پذیرش رضایت‌نامه ویزیت از راه دور لازم است', true);
    if (!f.dob.value) return toast('تاریخ تولد را کامل انتخاب کنید (روز، ماه و سال)', true);
    await api('PUT', '/v1/patients/me', {
      full_name: f.full_name.value, national_id: f.national_id.value, dob: f.dob.value,
      gender: f.gender.value || null, allergies: split(f.allergies.value), chronic_conditions: split(f.chronic.value),
    });
    for (const [type, cb] of Object.entries(consents)) if (cb.checked) await api('POST', '/v1/patients/me/consents', { type });
    setSession(await api('POST', '/v1/auth/refresh'));
    toast('پروفایل ثبت شد');
    route('assistant');
  });
  $app.append(h('form', { class: 'card stack', onsubmit: submit },
    h('h2', {}, 'تکمیل پروفایل'),
    h('p', { class: 'muted' }, 'کد ملی به‌صورت رمزنگاری‌شده و در داخل کشور نگهداری می‌شود.'),
    h('div', { class: 'grid2' },
      h('div', {}, h('label', {}, 'نام و نام خانوادگی *'), f.full_name),
      h('div', {}, h('label', {}, 'کد ملی *'), f.national_id),
      h('div', {}, h('label', { for: 'dob-d' }, 'تاریخ تولد (شمسی) *'), jalaliPicker(h, { id: 'dob', label: 'تاریخ تولد', minYear: todayJalali().jy - 120, onchange: (iso) => { f.dob.value = iso; } })),
      h('div', {}, h('label', {}, 'جنسیت'), f.gender),
      h('div', {}, h('label', {}, 'حساسیت‌ها (با ویرگول جدا کنید)'), f.allergies),
      h('div', {}, h('label', {}, 'بیماری‌های زمینه‌ای'), f.chronic)),
    h('h3', {}, 'رضایت‌نامه‌ها'),
    Object.entries(LABELS.consent).map(([k, [title, desc]]) =>
      h('label', { class: 'check' }, consents[k], h('span', {}, h('b', {}, title), k === 'telehealth' ? ' (الزامی)' : '', h('br'), h('span', { class: 'muted' }, desc)))),
    h('button', { class: 'btn primary' }, 'ثبت و ادامه')));
};

// ---------- assistant ----------
VIEWS.assistant = async () => {
  const sidKey = `ai_session:${session.user.id}`;
  let sid = store.get(sidKey);
  if (!sid) { sid = crypto.randomUUID(); store.set(sidKey, sid); }
  let lastTs = '';
  let busy = false;

  const modeBadge = h('span', { class: 'pill mode INFO_MODE' }, LABELS.mode.INFO_MODE);
  const banner = h('div');
  const log = h('div', { class: 'chat-log', 'aria-live': 'polite' });
  const quick = h('div', { class: 'quick' });
  const input = h('input', { type: 'text', placeholder: 'پیام خود را بنویسید…', maxlength: 2000, 'aria-label': 'پیام' });
  const sendBtn = h('button', { class: 'btn primary' }, 'ارسال');

  let curMode = null;
  const setMode = (m) => {
    curMode = m;
    modeBadge.className = `pill mode ${m}`;
    modeBadge.textContent = LABELS.mode[m] ?? m;
    banner.replaceChildren(m === 'EMERGENCY_MODE'
      ? h('div', { class: 'banner danger' }, '⚠️ وضعیت اورژانسی: همین حالا با ', h('a', { href: 'tel:115' }, 'اورژانس ۱۱۵'), ' تماس بگیرید. اپراتور انسانی در جریان است.')
      : m === 'FOLLOWUP_MODE' ? h('div', { class: 'banner info' }, 'دوره پیگیری پس از ویزیت فعال است.') : '');
    setQuick(m);
  };
  const setQuick = (m, options) => {
    quick.replaceChildren();
    const qs = options?.length
      ? options.map((o) => [`${fa(o.option)}. ${o.doctor_name} — ${fmt.short(o.starts_at)}`, String(o.option)])
      : m === 'INFO_MODE' ? [['🩺 بررسی علائم با نقشه بدن', null], ['می‌خواهم نوبت بگیرم', 'می‌خواهم نوبت بگیرم'], ['نسخه چطور صادر می‌شود؟', 'نسخه الکترونیک چطور صادر میشه؟'], ['صحبت با اپراتور', 'می‌خواهم با اپراتور صحبت کنم']]
      : m === 'FOLLOWUP_MODE' ? [['نوبت پیگیری', 'نوبت پیگیری می‌خواهم']] : [];
    for (const [label, text] of qs) quick.append(h('button', { class: `btn small${text === null ? ' primary' : ''}`, onclick: () => (text === null ? startWizard() : send(text)) }, label));
  };

  const bubble = (role, text, extra = {}) => {
    const cls = role === 'patient' ? 'me' : role === 'assistant' ? 'bot' : role;
    const who = { patient: 'شما', assistant: 'دستیار', operator: 'اپراتور', system: '' }[role] ?? role;
    const el = h('div', { class: `msg ${cls}` }, who ? h('span', { class: 'who' }, who) : null, h('span', { class: 'body' }, text));
    if (extra.citations?.length) el.append(h('div', { class: 'cites' }, 'منبع: ', extra.citations.join('، ')));
    log.append(el);
    log.scrollTop = log.scrollHeight;
    return el;
  };

  const loadHistory = async () => {
    const r = await api('GET', `/v1/ai/sessions/${sid}/messages?after=${encodeURIComponent(lastTs)}`);
    if (!r.items.length && !lastTs) {
      if (!log.childElementCount) bubble('assistant', 'سلام! من دستیار هوشمند کلینیک هستم. می‌توانم علائم شما را بررسی کنم، به پرسش‌های عمومی پاسخ بدهم و برایتان نوبت بگیرم. تشخیص و تجویز فقط با پزشک است.');
      setMode('INFO_MODE');
      return;
    }
    for (const m of r.items) {
      if (busy && m.sender_role !== 'operator' && m.sender_role !== 'system') continue;
      bubble(m.sender_role, m.content, { citations: m.citations });
      lastTs = m.created_at;
    }
    // Only touch the mode/quick replies when something changed, so polling keeps slot options.
    const lastOptions = [...r.items].reverse().find((m) => m.sender_role === 'assistant')?.options;
    if (!busy && (r.mode !== curMode || lastOptions)) {
      setMode(r.mode);
      if (lastOptions && r.mode === 'BOOKING_MODE') setQuick(r.mode, lastOptions);
    }
  };

  const startWizard = guard(() => openTriageWizard({ h, api, toast, fa, onSubmit: (form) => send('📋 فرم بررسی علائم ارسال شد', form) }));

  async function send(text, form = null) {
    text = (text ?? input.value).trim();
    if (!text || busy) return;
    busy = true; sendBtn.disabled = true; if (!form) input.value = '';
    bubble('patient', text);
    const botEl = bubble('assistant', '');
    const body = botEl.querySelector('.body');
    const chips = h('div', { class: 'chips' });
    log.insertBefore(chips, botEl);
    const typing = h('div', { class: 'typing' }, 'در حال نوشتن…');
    log.append(typing);
    const cites = [];
    let options = null;
    try {
      const res = await fetch(apiUrl('/v1/ai/chat'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session.access_token}` },
        body: JSON.stringify({ session_id: sid, message: form ? { type: 'triage_form', form } : { type: 'text', content: text }, locale: 'fa-IR' }),
      });
      if (!res.ok) { const j = await res.json().catch(() => ({})); throw new ApiErr(res.status, j); }
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = '';
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let i;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const block = buf.slice(0, i); buf = buf.slice(i + 2);
          const ev = /^event: (.+)$/m.exec(block)?.[1];
          const data = JSON.parse(/^data: (.+)$/m.exec(block)?.[1] ?? 'null');
          if (ev === 'token') { body.textContent += data.text; log.scrollTop = log.scrollHeight; }
          else if (ev === 'tool_call' && data.status !== 'started') chips.append(h('span', { class: 'chip' }, `${data.status === 'ok' ? '✓' : '✗'} ${LABELS.tool[data.name] ?? data.name}`));
          else if (ev === 'mode_change') setMode(data.to);
          else if (ev === 'triage_result') log.insertBefore(triageResultCard(h, data), chips);
          else if (ev === 'citation') cites.push(data.title);
          else if (ev === 'options') options = data.items;
          else if (ev === 'escalation') chips.append(h('span', { class: 'chip' }, data.kind === 'emergency' ? '🚨 اپراتور مطلع شد' : '👤 به اپراتور ارجاع شد'));
          else if (ev === 'error') throw new ApiErr(500, data);
          else if (ev === 'done') {
            setMode(data.mode);
            if (options) setQuick(data.mode, options);
            if (data.booked_appointment_id) toast('نوبت ثبت شد ✅');
          }
        }
      }
      if (cites.length) botEl.append(h('div', { class: 'cites' }, 'منبع: ', cites.join('، ')));
      if (!chips.childElementCount) chips.remove();
    } catch (e) {
      botEl.remove(); chips.remove();
      toast(e.message || 'خطا در ارتباط با دستیار', true);
    } finally {
      typing.remove();
      busy = false; sendBtn.disabled = false; input.focus();
      // Catch up the timestamp so polling only brings operator/system messages.
      const r = await api('GET', `/v1/ai/sessions/${sid}/messages?after=${encodeURIComponent(lastTs)}`).catch(() => null);
      if (r?.items.length) lastTs = r.items[r.items.length - 1].created_at;
    }
  }

  sendBtn.onclick = () => send();
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.isComposing) send(); });
  const newChat = () => { store.set(sidKey, crypto.randomUUID()); route('assistant'); };

  $app.append(banner, h('div', { class: 'card chat' },
    h('div', { class: 'chat-head' }, h('b', {}, 'دستیار هوشمند'), modeBadge, h('span', { class: 'spacer' }), h('button', { class: 'btn small', onclick: () => startWizard() }, '🩺 بررسی علائم'), h('button', { class: 'btn small', onclick: newChat }, 'گفتگوی جدید')),
    log, quick, h('div', { class: 'chat-input' }, input, sendBtn)),
    h('p', { class: 'muted' }, 'دستیار تشخیص نمی‌دهد و دارو تجویز نمی‌کند. در موارد اورژانسی با ۱۱۵ تماس بگیرید.'));
  await loadHistory();
  input.focus();
  every(5000, () => { if (!busy) loadHistory().catch(() => {}); });
};

// ---------- booking ----------
VIEWS.book = async () => {
  const specs = (await api('GET', '/v1/specialties')).items;
  const sel = h('select', {}, h('option', { value: '' }, 'همه تخصص‌ها'), specs.map((s) => h('option', { value: s.code }, s.label)));
  const channel = h('select', {}, Object.entries(LABELS.channel).map(([k, v]) => h('option', { value: k }, v)));
  const out = h('div');
  const confirmBox = h('div');
  let chosen = null;

  const load = guard(async () => {
    chosen = null; confirmBox.replaceChildren();
    const r = await api('GET', `/v1/slots?limit=120${sel.value ? `&specialty=${sel.value}` : ''}`);
    out.replaceChildren();
    if (!r.items.length) return out.append(h('div', { class: 'empty' }, 'زمان آزادی یافت نشد.'));
    const byDoctor = new Map();
    for (const s of r.items) {
      if (!byDoctor.has(s.doctor_id)) byDoctor.set(s.doctor_id, { name: s.doctor_name, label: s.specialty_label, slots: [] });
      byDoctor.get(s.doctor_id).slots.push(s);
    }
    for (const d of byDoctor.values()) {
      const card = h('div', { class: 'card' }, h('h3', {}, d.name, ' ', h('span', { class: 'pill primary' }, d.label)));
      const days = new Map();
      for (const s of d.slots.slice(0, 18)) {
        const k = tehranDayKey(s.starts_at);
        if (!days.has(k)) days.set(k, []);
        days.get(k).push(s);
      }
      for (const slots of days.values()) {
        card.append(h('div', { class: 'day-title' }, fmt.day(slots[0].starts_at)));
        card.append(h('div', { class: 'slots' }, slots.map((s) => h('button', {
          class: 'slot', onclick: (e) => {
            out.querySelectorAll('.slot').forEach((b) => b.setAttribute('aria-pressed', 'false'));
            e.currentTarget.setAttribute('aria-pressed', 'true');
            chosen = s; showConfirm();
          },
        }, fmt.time(s.starts_at)))));
      }
      out.append(card);
    }
  });

  const showConfirm = () => {
    const key = crypto.randomUUID(); // one key per confirmation → retries are idempotent
    const submit = guard(async (e) => {
      const btn = e.currentTarget;
      btn.disabled = true;
      try {
        await api('POST', '/v1/appointments', { doctor_id: chosen.doctor_id, slot_id: chosen.id, channel: channel.value }, { 'Idempotency-Key': key });
        toast('نوبت شما ثبت شد ✅');
        route('appointments');
      } catch (err) {
        if (err.code === 'slot_taken') { toast('این زمان همین الان رزرو شد؛ زمان دیگری انتخاب کنید', true); load(); return; }
        throw err;
      } finally { btn.disabled = false; }
    });
    confirmBox.replaceChildren(h('div', { class: 'card row' },
      h('div', { class: 'grow' }, h('b', {}, chosen.doctor_name), ' — ', fmt.dt(chosen.starts_at)),
      h('div', {}, channel), h('button', { class: 'btn primary', onclick: submit }, 'تأیید و رزرو')));
    confirmBox.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  };

  sel.onchange = load;
  $app.append(h('div', { class: 'card row' }, h('div', { class: 'grow' }, h('label', {}, 'تخصص'), sel),
    h('p', { class: 'muted grow' }, 'نمی‌دانید کدام تخصص؟ از «دستیار هوشمند» بخواهید علائم‌تان را بررسی کند.')), confirmBox, out);
  load();
};

// ---------- appointments ----------
function appointmentItem(a, role) {
  const actions = [];
  if (a.status === 'confirmed') {
    actions.push(h('button', { class: 'btn primary small', onclick: () => route('room', a.consultation.id) }, 'ورود به اتاق ویزیت'));
    actions.push(h('button', {
      class: 'btn danger small', onclick: guard(async () => {
        if (!confirm('نوبت لغو شود؟')) return;
        await api('POST', `/v1/appointments/${a.id}/cancel`, {});
        toast('نوبت لغو شد'); route(current.view);
      }),
    }, 'لغو'));
  }
  if (a.status === 'completed' && role === 'doctor') actions.push(h('button', { class: 'btn small', onclick: () => route('room', a.consultation.id) }, 'پرونده ویزیت'));
  return h('li', {}, h('div', { class: 'row' },
    h('div', { class: 'grow' },
      h('b', {}, role === 'doctor' ? (a.patient?.full_name ?? 'بیمار') : a.doctor?.full_name), ' ',
      h('span', { class: 'muted' }, role === 'doctor' ? '' : a.doctor?.specialty_label), h('br'),
      h('span', {}, fmt.dt(a.starts_at)), ' · ', h('span', { class: 'muted' }, LABELS.channel[a.channel]),
      a.booked_via === 'ai_assistant' ? h('span', { class: 'pill info', style: 'margin-inline-start:6px' }, 'رزرو با دستیار') : null,
      a.triage ? h('span', { style: 'margin-inline-start:6px' }, urgencyPill(a.triage.urgency_level)) : null),
    statusPill(a.status), ...actions));
}

VIEWS.appointments = async () => {
  const r = await api('GET', '/v1/appointments?limit=50');
  $app.append(h('div', { class: 'card' }, h('h2', {}, 'نوبت‌های من'),
    r.items.length ? h('ul', { class: 'list' }, r.items.map((a) => appointmentItem(a, 'patient')))
      : h('div', { class: 'empty' }, 'هنوز نوبتی ندارید. ', h('a', { href: '#book', onclick: (e) => { e.preventDefault(); route('book'); } }, 'رزرو نوبت'))));
};

VIEWS['doctor-appointments'] = async () => {
  const r = await api('GET', '/v1/appointments?limit=100');
  const upcoming = r.items.filter((a) => a.status === 'confirmed').sort((a, b) => a.starts_at.localeCompare(b.starts_at));
  const past = r.items.filter((a) => a.status !== 'confirmed');
  $app.append(
    h('div', { class: 'card' }, h('h2', {}, 'نوبت‌های پیش رو'),
      upcoming.length ? h('ul', { class: 'list' }, upcoming.map((a) => appointmentItem(a, 'doctor'))) : h('div', { class: 'empty' }, 'نوبت فعالی ندارید.')),
    h('div', { class: 'card' }, h('h2', {}, 'سابقه'),
      past.length ? h('ul', { class: 'list' }, past.map((a) => appointmentItem(a, 'doctor'))) : h('div', { class: 'empty' }, '—')));
};

// ---------- visit room ----------
VIEWS.room = async (cid) => {
  const isDoctor = session.user.role === 'doctor';
  const join = await api('POST', `/v1/consultations/${cid}/join`, {}).catch((e) => (e.code === 'appointment_not_active' ? null : Promise.reject(e)));
  const info = await api('GET', `/v1/consultations/${cid}`);
  let ended = !!info.ended_at;
  let lastTs = '';
  const log = h('div', { class: 'chat-log', style: 'min-height:280px' });
  const input = h('input', { type: 'text', placeholder: 'پیام به ' + (isDoctor ? 'بیمار' : 'پزشک'), maxlength: 4000 });
  const sendBtn = h('button', { class: 'btn primary' }, 'ارسال');

  const poll = async () => {
    const r = await api('GET', `/v1/consultations/${cid}/messages?after=${encodeURIComponent(lastTs)}`);
    for (const m of r.items) {
      const mine = m.sender_role === session.user.role;
      log.append(h('div', { class: `msg ${mine ? 'me' : 'bot'}` }, h('span', { class: 'who' }, m.sender_role === 'doctor' ? 'پزشک' : 'بیمار'), m.content));
      lastTs = m.created_at;
      log.scrollTop = log.scrollHeight;
    }
    if (r.ended_at && !ended) { ended = true; route('room', cid); }
  };
  const send = guard(async () => {
    const t = input.value.trim(); if (!t) return;
    input.value = '';
    await api('POST', `/v1/consultations/${cid}/messages`, { content: t });
    await poll();
  });
  sendBtn.onclick = send;
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.isComposing) send(); });

  const media = join?.media_url
    ? h('div', { class: 'banner info' }, `اتاق ${join.room_id} آماده است (LiveKit: ${join.media_url}). ترتیب fallback: ${join.fallback.map((c) => LABELS.channel[c]).join(' ← ')}`)
    : h('div', { class: 'banner warn' }, `سرور رسانه (LiveKit) در این محیط پیکربندی نشده است؛ ویزیت از طریق چت متنی انجام می‌شود. نوع نوبت: ${LABELS.channel[info.channel]}`);

  $app.append(
    h('div', { class: 'row', style: 'margin-bottom:10px' }, h('button', { class: 'btn small', onclick: () => route(isDoctor ? 'doctor-appointments' : 'appointments') }, '→ بازگشت'),
      h('b', {}, 'اتاق ویزیت'), ended ? h('span', { class: 'pill' }, 'پایان‌یافته') : h('span', { class: 'pill ok' }, 'فعال')),
    ended ? null : media,
    h('div', { class: 'card chat', style: 'height:auto' }, log, ended ? null : h('div', { class: 'chat-input' }, input, sendBtn)),
  );
  await poll();
  if (!ended) every(3000, () => poll().catch(() => {}));

  if (isDoctor) await doctorPanel(cid, info, ended);
};

async function doctorPanel(cid, info, ended) {
  const patient = await api('GET', `/v1/patients/${info.patient_id}`).catch(() => null);
  if (patient) {
    $app.append(h('div', { class: 'card' }, h('h2', {}, 'پرونده بیمار'),
      h('div', { class: 'grid2' },
        h('div', {}, h('label', {}, 'نام'), patient.full_name),
        h('div', {}, h('label', {}, 'تاریخ تولد'), formatJalaliDate(patient.dob)),
        h('div', {}, h('label', {}, 'حساسیت‌ها'), patient.allergies.join('، ') || '—'),
        h('div', {}, h('label', {}, 'بیماری‌های زمینه‌ای'), patient.chronic_conditions.join('، ') || '—')),
      patient.triage_results.length ? h('div', {}, h('h3', { style: 'margin-top:12px' }, 'نتایج triage'),
        h('ul', { class: 'list' }, patient.triage_results.slice(0, 3).map((t) => h('li', {},
          urgencyPill(t.urgency_level), ' ', t.symptoms.map((s) => s.name).join(' | '), h('br'),
          h('span', { class: 'muted' }, `${fmt.short(t.created_at)} · ${t.rule_version}${t.reviewed_by ? ' · بازبینی‌شده' : ''}`), ' ',
          t.reviewed_by ? null : h('button', {
            class: 'btn small', onclick: guard(async (e) => {
              await api('POST', `/v1/triage/${t.id}/review`, { agreed: true });
              e.target.replaceWith(h('span', { class: 'pill ok' }, 'تأیید شد'));
            }),
          }, 'تأیید ارزیابی'))))) : null));
  }

  // Prescription
  const rows = h('div');
  const addRow = () => rows.append(h('div', { class: 'drug-row' },
    h('input', { type: 'text', placeholder: 'نام دارو', 'data-k': 'name' }), h('input', { type: 'text', placeholder: 'دوز', 'data-k': 'dose' }),
    h('input', { type: 'text', placeholder: 'دفعات مصرف', 'data-k': 'frequency' }), h('input', { type: 'text', placeholder: 'مدت', 'data-k': 'duration' }),
    h('button', { class: 'btn small', type: 'button', onclick: (e) => e.currentTarget.parentElement.remove() }, '✕')));
  addRow();
  const notes = h('textarea', { rows: 2, placeholder: 'توضیحات' });
  const existing = h('div');
  const rxKey = crypto.randomUUID();
  const loadRx = async () => {
    const r = await api('GET', `/v1/prescriptions?consultation_id=${cid}`);
    existing.replaceChildren(...r.items.map((rx) => h('div', { class: 'banner ' + (rx.status === 'issued' ? 'info' : 'warn') },
      rx.status === 'issued' ? '✅ نسخه صادر و امضا شد' : '📝 پیش‌نویس (تا امضا نامعتبر است)', ' — ',
      rx.drugs.map((d) => `${d.name} ${d.dose ?? ''}`).join('، '), ' ',
      rx.status === 'draft' ? h('button', {
        class: 'btn primary small', onclick: guard(async () => { await api('POST', `/v1/prescriptions/${rx.id}/sign`, {}); toast('نسخه امضا و صادر شد'); loadRx(); }),
      }, 'امضا و صدور') : h('a', { href: apiUrl(`/v1/prescriptions/${rx.id}/verify`), target: '_blank' }, 'بررسی اعتبار'))));
  };
  const saveDraft = guard(async () => {
    const drugs = [...rows.children].map((r) => Object.fromEntries([...r.querySelectorAll('input')].map((i) => [i.dataset.k, i.value.trim()]))).filter((d) => d.name);
    if (!drugs.length) return toast('حداقل یک دارو وارد کنید', true);
    await api('POST', '/v1/prescriptions', { consultation_id: cid, drugs, notes: notes.value }, { 'Idempotency-Key': rxKey });
    toast('پیش‌نویس ذخیره شد'); loadRx();
  });
  $app.append(h('div', { class: 'card stack' }, h('h2', {}, 'نسخه الکترونیک'), existing,
    h('div', {}, rows, h('button', { class: 'btn small', onclick: addRow }, '+ دارو')), notes,
    h('div', { class: 'row' }, h('button', { class: 'btn', onclick: saveDraft }, 'ذخیره پیش‌نویس'), h('span', { class: 'spacer' }),
      ended ? null : h('button', {
        class: 'btn danger', onclick: guard(async () => {
          if (!confirm('ویزیت پایان یابد؟')) return;
          await api('POST', `/v1/consultations/${cid}/end`, {});
          toast('ویزیت پایان یافت؛ دستیار برای بیمار وارد حالت پیگیری شد'); route('room', cid);
        }),
      }, 'پایان ویزیت'))));
  loadRx();
}

// ---------- prescriptions ----------
VIEWS.prescriptions = async () => {
  const r = await api('GET', '/v1/prescriptions');
  $app.append(h('div', { class: 'card' }, h('h2', {}, 'نسخه‌های من'),
    r.items.length ? h('ul', { class: 'list' }, r.items.map((rx) => h('li', {},
      h('div', { class: 'row' }, h('b', { class: 'grow' }, rx.doctor_name, ' ', h('span', { class: 'muted' }, `نظام پزشکی ${rx.doctor_license_no}`)),
        h('span', { class: 'muted' }, fmt.dt(rx.issued_at)), h('a', { class: 'btn small', href: apiUrl(`/v1/prescriptions/${rx.id}/verify`), target: '_blank' }, 'بررسی اعتبار')),
      h('table', {}, h('thead', {}, h('tr', {}, h('th', {}, 'دارو'), h('th', {}, 'دوز'), h('th', {}, 'دفعات'), h('th', {}, 'مدت'))),
        h('tbody', {}, rx.drugs.map((d) => h('tr', {}, h('td', {}, d.name), h('td', {}, d.dose ?? '—'), h('td', {}, d.frequency ?? '—'), h('td', {}, d.duration ?? '—'))))),
      rx.notes ? h('p', { class: 'muted' }, rx.notes) : null)))
      : h('div', { class: 'empty' }, 'نسخه‌ای صادر نشده است.')));
};

VIEWS['doctor-rx'] = async () => {
  const r = await api('GET', '/v1/prescriptions');
  $app.append(h('div', { class: 'card' }, h('h2', {}, 'نسخه‌ها'),
    r.items.length ? h('ul', { class: 'list' }, r.items.map((rx) => h('li', { class: 'row' },
      h('span', { class: 'grow' }, rx.drugs.map((d) => d.name).join('، ')),
      h('span', { class: `pill ${rx.status === 'issued' ? 'ok' : 'warn'}` }, rx.status === 'issued' ? 'صادرشده' : 'پیش‌نویس'),
      h('span', { class: 'muted' }, fmt.short(rx.created_at)),
      h('button', { class: 'btn small', onclick: () => route('room', rx.consultation_id) }, 'ویزیت'))))
      : h('div', { class: 'empty' }, '—')));
};

// ---------- inbox ----------
VIEWS.inbox = async () => {
  const r = await api('GET', '/v1/notifications');
  const icon = { sms: '✉️ پیامک', email: '📧 ایمیل', push: '🔔 اعلان' };
  $app.append(h('div', { class: 'card' }, h('h2', {}, 'پیام‌ها و اعلان‌ها'),
    h('p', { class: 'muted' }, 'در محیط آزمایشی، پیامک‌ها به‌جای ارسال واقعی اینجا نمایش داده می‌شوند.'),
    r.items.length ? h('ul', { class: 'list' }, r.items.map((n) => h('li', {}, h('span', { class: 'pill' }, icon[n.channel]), ' ', n.body, h('br'), h('span', { class: 'muted' }, fmt.short(n.created_at)))))
      : h('div', { class: 'empty' }, 'پیامی نیست.')));
};

// "2026-10-v1" → "نسخه ۱ — مهر ۱۴۰۵"
function consentVersionLabel(v) {
  const m = /^(\d{4})-(\d{2})-v(\d+)$/.exec(v ?? '');
  if (!m) return v;
  const j = isoToJalali(`${m[1]}-${m[2]}-15`);
  return `نسخه ${fa(m[3])} — ${MONTHS[j.jm - 1]} ${fa(j.jy)}`;
}

// ---------- profile & privacy ----------
VIEWS.profile = async () => {
  const p = await api('GET', '/v1/patients/me');
  const c = await api('GET', '/v1/patients/me/consents');
  const toggle = (item) => {
    const cb = h('input', { type: 'checkbox', checked: item.accepted });
    cb.onchange = guard(async () => {
      if (cb.checked) await api('POST', '/v1/patients/me/consents', { type: item.type });
      else await api('DELETE', `/v1/patients/me/consents/${item.type}`);
      toast(cb.checked ? 'رضایت ثبت شد' : 'رضایت لغو شد');
    });
    const [title, desc] = LABELS.consent[item.type];
    return h('label', { class: 'check' }, cb, h('span', {}, h('b', {}, title), h('br'), h('span', { class: 'muted' }, desc)));
  };
  const exportData = guard(async () => {
    const data = await api('GET', '/v1/patients/me/export');
    const a = h('a', { href: URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' })), download: 'my-health-data.json' });
    a.click();
  });
  const erase = guard(async () => {
    if (!confirm('حساب و اطلاعات شما حذف می‌شود. ادامه می‌دهید؟')) return;
    await api('DELETE', '/v1/patients/me');
    toast('حساب حذف شد'); logout();
  });
  $app.append(
    h('div', { class: 'card' }, h('h2', {}, 'پروفایل'),
      h('div', { class: 'grid2' },
        h('div', {}, h('label', {}, 'نام'), p.full_name), h('div', {}, h('label', {}, 'موبایل'), h('bdi', {}, p.phone)),
        h('div', {}, h('label', {}, 'کد ملی'), h('bdi', {}, p.national_id)), h('div', {}, h('label', {}, 'تاریخ تولد'), formatJalaliDate(p.dob)),
        h('div', {}, h('label', {}, 'حساسیت‌ها'), p.allergies.join('، ') || '—'), h('div', {}, h('label', {}, 'بیماری‌های زمینه‌ای'), p.chronic_conditions.join('، ') || '—'))),
    h('div', { class: 'card' }, h('h2', {}, 'رضایت‌نامه‌ها'), h('p', { class: 'muted' }, `نسخه فعلی: ${consentVersionLabel(c.current_version)}`), c.items.map(toggle)),
    h('div', { class: 'card row' }, h('div', { class: 'grow' }, h('h3', {}, 'داده‌های من'), h('span', { class: 'muted' }, 'دریافت نسخه کامل داده‌ها یا حذف حساب.')),
      h('button', { class: 'btn', onclick: exportData }, 'دریافت داده‌ها'), h('button', { class: 'btn danger', onclick: erase }, 'حذف حساب')));
};

// ---------- doctor calendar ----------
VIEWS.calendar = async () => {
  // Next 60 days in Tehran, labelled with the Jalali date (value stays Gregorian ISO).
  const date = h('select', {}, Array.from({ length: 60 }, (_, i) => {
    const d = new Date(Date.now() + i * 864e5);
    return h('option', { value: tehranDayKey(d) }, `${i === 0 ? 'امروز — ' : i === 1 ? 'فردا — ' : ''}${fmt.day(d)}`);
  }));
  // 24-hour Persian time selects (native time inputs show English AM/PM on many phones).
  const timeSelect = (def) => h('select', {}, Array.from({ length: (24 - 6) * 4 }, (_, i) => {
    const mins = 6 * 60 + i * 15;
    const v = `${String(Math.floor(mins / 60) % 24).padStart(2, '0')}:${String(mins % 60).padStart(2, '0')}`;
    return h('option', { value: v, selected: v === def }, fa(v));
  }));
  const from = timeSelect('16:00');
  const to = timeSelect('19:00');
  const dur = h('select', {}, [15, 20, 30, 45, 60].map((m) => h('option', { value: m, selected: m === 30 }, `${fa(m)} دقیقه`)));
  const list = h('div');
  // Wall-clock time in Tehran (UTC+03:30) → ISO.
  const toIso = (d, t) => { const [y, m, dd] = d.split('-').map(Number); const [hh, mm] = t.split(':').map(Number); return new Date(Date.UTC(y, m - 1, dd, hh, mm) - 210 * 60000).toISOString(); };
  const load = async () => {
    const r = await api('GET', '/v1/doctors/me/slots');
    const days = new Map();
    for (const s of r.items) { const k = tehranDayKey(s.starts_at); if (!days.has(k)) days.set(k, []); days.get(k).push(s); }
    list.replaceChildren(...[...days.values()].map((slots) => h('div', {}, h('div', { class: 'day-title' }, fmt.day(slots[0].starts_at)),
      h('div', { class: 'slots' }, slots.map((s) => h('div', { class: 'slot', style: s.booked ? 'border-color:var(--primary)' : '' },
        fmt.time(s.starts_at), h('small', {}, s.booked ? 'رزروشده' : h('button', {
          class: 'btn small', onclick: guard(async () => { await api('DELETE', `/v1/doctors/me/slots/${s.id}`); load(); }),
        }, 'حذف'))))))));
    if (!r.items.length) list.append(h('div', { class: 'empty' }, 'زمانی منتشر نشده است.'));
  };
  const publish = guard(async (e) => {
    e.preventDefault();
    const r = await api('POST', '/v1/doctors/me/slots', { starts_at: toIso(date.value, from.value), ends_at: toIso(date.value, to.value), duration_min: Number(dur.value) });
    toast(`${fa(r.created)} نوبت منتشر شد${r.skipped_overlapping ? ` (${fa(r.skipped_overlapping)} مورد تکراری رد شد)` : ''}`);
    load();
  });
  $app.append(h('form', { class: 'card', onsubmit: publish }, h('h2', {}, 'انتشار تقویم'),
    h('div', { class: 'grid2' }, h('div', {}, h('label', {}, 'تاریخ'), date), h('div', {}, h('label', {}, 'از ساعت (تهران)'), from),
      h('div', {}, h('label', {}, 'تا ساعت'), to), h('div', {}, h('label', {}, 'مدت هر نوبت'), dur)),
    h('div', { style: 'margin-top:12px' }, h('button', { class: 'btn primary' }, 'انتشار'))),
  h('div', { class: 'card' }, h('h2', {}, 'زمان‌های من'), list));
  load();
};

// ---------- operator console ----------
VIEWS.escalations = async (id) => {
  if (id) return escalationDetail(id);
  const tabsBox = h('div', { class: 'row', style: 'margin-bottom:10px' });
  const list = h('div', { class: 'card' });
  let status = 'open';
  const kindPill = (k) => ({ emergency: h('span', { class: 'pill danger' }, 'اورژانس'), human_request: h('span', { class: 'pill info' }, 'درخواست انسان'), low_confidence: h('span', { class: 'pill warn' }, 'پاسخ نامطمئن'), guardrail: h('span', { class: 'pill' }, 'guardrail') }[k]);
  const load = async () => {
    const r = await api('GET', `/v1/escalations?status=${status}`);
    tabsBox.replaceChildren(
      h('button', { class: `btn small ${status === 'open' ? 'primary' : ''}`, onclick: () => { status = 'open'; load(); } }, 'باز'),
      h('button', { class: `btn small ${status === 'resolved' ? 'primary' : ''}`, onclick: () => { status = 'resolved'; load(); } }, 'بسته‌شده'));
    list.replaceChildren(h('h2', {}, 'درخواست‌های ارجاع از دستیار'),
      r.items.length ? h('ul', { class: 'list' }, r.items.map((e) => h('li', { class: 'row' },
        kindPill(e.kind), h('span', { class: 'grow' }, h('b', {}, e.full_name || h('bdi', {}, e.phone)), h('br'), h('span', { class: 'muted' }, e.reason)),
        h('span', { class: 'muted' }, fmt.short(e.created_at)), h('button', { class: 'btn small', onclick: () => route('escalations', e.id) }, 'بررسی'))))
        : h('div', { class: 'empty' }, 'موردی نیست.'));
  };
  $app.append(tabsBox, list);
  await load();
  every(5000, () => load().catch(() => {}));
};

async function escalationDetail(id) {
  const box = h('div');
  const input = h('input', { type: 'text', placeholder: 'پاسخ به بیمار…' });
  const load = async () => {
    const e = await api('GET', `/v1/escalations/${id}`);
    box.replaceChildren(
      h('div', { class: 'card' }, h('div', { class: 'row' }, h('h2', { class: 'grow' }, e.user?.full_name || 'بیمار', ' ', h('bdi', { class: 'muted' }, e.user?.phone)),
        h('span', { class: `pill mode ${e.mode}` }, LABELS.mode[e.mode]), h('span', { class: `pill ${e.status === 'open' ? 'warn' : 'ok'}` }, e.status === 'open' ? 'باز' : 'بسته')),
      h('p', { class: 'muted' }, `دلیل: ${e.reason}`)),
      h('div', { class: 'card chat', style: 'height:auto' }, h('div', { class: 'chat-log', style: 'max-height:420px' },
        e.messages.map((m) => h('div', { class: `msg ${m.sender_role === 'patient' ? 'me' : m.sender_role === 'assistant' ? 'bot' : m.sender_role}` },
          h('span', { class: 'who' }, { patient: 'بیمار', assistant: 'دستیار', operator: 'اپراتور', system: '' }[m.sender_role]), m.content))),
      e.status === 'open' ? h('div', { class: 'chat-input' }, input, h('button', { class: 'btn primary', onclick: reply }, 'ارسال')) : null),
      e.status === 'open' ? h('button', { class: 'btn', onclick: resolve }, e.mode === 'EMERGENCY_MODE' ? 'بستن مورد و خروج از حالت اورژانس' : 'بستن مورد') : null);
  };
  const reply = guard(async () => { if (!input.value.trim()) return; await api('POST', `/v1/escalations/${id}/messages`, { content: input.value }); input.value = ''; load(); });
  const resolve = guard(async () => { await api('POST', `/v1/escalations/${id}/resolve`, {}); toast('مورد بسته شد'); route('escalations'); });
  $app.append(h('button', { class: 'btn small', style: 'margin-bottom:10px', onclick: () => route('escalations') }, '→ بازگشت'), box);
  await load();
}

VIEWS.stats = async () => {
  const s = await api('GET', '/v1/admin/stats');
  const tile = (label, v) => h('div', { class: 'card' }, h('div', { class: 'muted' }, label), h('div', { class: 'stat' }, fa(v)));
  $app.append(h('div', { class: 'grid2' }, tile('بیماران', s.patients), tile('پزشکان', s.doctors), tile('نوبت‌های فعال', s.appointments_active),
    tile('رزرو با دستیار', s.appointments_by_ai), tile('ارجاع‌های باز', s.escalations_open)),
  h('div', { class: 'card' }, h('h2', {}, 'triage بر اساس سطح فوریت'),
    s.triage_by_level.length ? h('ul', { class: 'list' }, s.triage_by_level.map((t) => h('li', { class: 'row' }, urgencyPill(t.urgency_level), h('span', { class: 'spacer' }), fa(t.n)))) : h('div', { class: 'empty' }, '—')));
};

VIEWS.audit = async () => {
  const r = await api('GET', '/v1/admin/audit');
  $app.append(h('div', { class: 'card' }, h('h2', {}, 'لاگ ممیزی (append-only)'),
    h('div', { style: 'overflow-x:auto' }, h('table', {}, h('thead', {}, h('tr', {}, ['زمان', 'عمل', 'منبع', 'trace_id', 'جزئیات'].map((x) => h('th', {}, x)))),
      h('tbody', {}, r.items.map((a) => h('tr', {}, h('td', {}, fmt.short(a.ts)), h('td', { class: 'ltr' }, a.action), h('td', { class: 'ltr' }, a.resource),
        h('td', { class: 'ltr' }, (a.trace_id || '').slice(0, 10)), h('td', { class: 'ltr' }, a.detail ? JSON.stringify(a.detail).slice(0, 160) : ''))))))));
};

VIEWS.staff = async () => {
  const specs = (await api('GET', '/v1/specialties')).items;
  const f = { full_name: h('input', { type: 'text' }), phone: h('input', { type: 'tel', dir: 'ltr' }), email: h('input', { type: 'email', dir: 'ltr' }),
    specialty: h('select', {}, specs.map((s) => h('option', { value: s.code }, s.label))), license_no: h('input', { type: 'text', dir: 'ltr' }) };
  const role = h('select', {}, h('option', { value: 'doctor' }, 'پزشک'), h('option', { value: 'operator' }, 'اپراتور'), h('option', { value: 'admin' }, 'مدیر'));
  const submit = guard(async (e) => {
    e.preventDefault();
    const base = { full_name: f.full_name.value, phone: f.phone.value, email: f.email.value || null };
    if (role.value === 'doctor') await api('POST', '/v1/admin/doctors', { ...base, specialty: f.specialty.value, license_no: f.license_no.value });
    else await api('POST', '/v1/admin/staff', { ...base, role: role.value });
    toast('کاربر ایجاد شد'); e.target.reset();
  });
  $app.append(h('form', { class: 'card', onsubmit: submit }, h('h2', {}, 'افزودن کاربر'),
    h('div', { class: 'grid2' }, h('div', {}, h('label', {}, 'نقش'), role), h('div', {}, h('label', {}, 'نام'), f.full_name),
      h('div', {}, h('label', {}, 'موبایل'), f.phone), h('div', {}, h('label', {}, 'ایمیل'), f.email),
      h('div', {}, h('label', {}, 'تخصص (پزشک)'), f.specialty), h('div', {}, h('label', {}, 'شماره نظام پزشکی'), f.license_no)),
    h('div', { style: 'margin-top:12px' }, h('button', { class: 'btn primary' }, 'ایجاد'))));
};

VIEWS.server = () => {
  const input = h('input', { type: 'url', dir: 'ltr', placeholder: 'https://clinic.example.ir', value: API_BASE });
  const status = h('div');
  const save = guard(async (e) => {
    e.preventDefault();
    let url = input.value.trim().replace(/\/$/, '');
    if (!/^https?:\/\//.test(url)) url = `https://${url}`;
    status.replaceChildren(h('div', { class: 'muted' }, 'در حال بررسی اتصال…'));
    try {
      const r = await fetch(`${url}/healthz`, { signal: AbortSignal.timeout(8000) });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
    } catch (err) {
      status.replaceChildren(h('div', { class: 'banner danger' }, `اتصال به سرور برقرار نشد (${err.message}). آدرس را بررسی کنید.`));
      return;
    }
    API_BASE = url;
    store.set('api_base', url);
    setSession(null);
    await loadConfig();
    toast('سرور ذخیره شد');
    route('login');
  });
  $app.append(h('form', { class: 'card narrow stack', onsubmit: save },
    h('h2', {}, 'آدرس سرور کلینیک'),
    h('p', { class: 'muted' }, 'آدرسی که کلینیک در اختیار شما گذاشته است را وارد کنید.'),
    input, status, h('button', { class: 'btn primary block' }, 'ذخیره و ادامه')));
  input.focus();
};

// ---------------- boot ----------------
async function loadConfig() {
  config = await fetch(apiUrl('/v1/config')).then((r) => r.json()).catch(() => config);
}

(async () => {
  if (!IS_NATIVE && 'serviceWorker' in navigator && location.protocol !== 'file:') {
    navigator.serviceWorker.register('/sw.js').catch(() => {});
  }
  if (IS_NATIVE && !API_BASE) return route('server');
  await loadConfig();
  const [view, arg] = location.hash.slice(1).split('/');
  if (!session) return route('login');
  route(view && VIEWS[view] && !['login', 'server'].includes(view) ? view : 'home', arg);
})();
