// Web client (Next.js in the design doc; dependency-free SPA here). RTL Persian UI for
// patients, doctors and operators/admins against the /v1 REST + SSE API.

import { openTriageWizard, triageResultCard } from './triage-wizard.js';
import { mediaSupported, startCall } from './video-call.js';
import { installV2 } from './views-v2.js';
import { icon } from './icons.js';
import { jalaliPicker, formatJalaliDate, todayJalali, isoToJalali, MONTHS } from './jalali.js';

// ---------------- utilities ----------------
// Optional parts are written as `cond ? node : null`. The DOM would print a null/undefined/false
// child as the text "null" etc., so these methods skip them everywhere.
for (const proto of [Element.prototype, DocumentFragment.prototype]) {
  for (const m of ['append', 'prepend', 'replaceChildren', 'before', 'after']) {
    const orig = proto[m];
    if (typeof orig !== 'function') continue;
    proto[m] = function (...nodes) { return orig.apply(this, nodes.filter((n) => n != null && n !== false)); };
  }
}
const $app = document.getElementById('app');
const $tabs = document.getElementById('tabs');
// The menus sit right under the header, whose height varies (notch, font size).
{
  const header = document.querySelector('.topbar');
  const setH = () => document.documentElement.style.setProperty('--header-h', `${header.offsetHeight}px`);
  if (header) { setH(); new ResizeObserver(setH).observe(header); }
}
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
  status: { pending: ['در انتظار پرداخت', 'warn'], confirmed: ['تأییدشده', 'ok'], cancelled: ['لغوشده', ''], completed: ['انجام‌شده', 'info'], no_show: ['عدم حضور', 'danger'] },
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
// A build with the server address built in always uses it (an older install may have saved the old IP).
let API_BASE = (window.TELEHEALTH_API_BASE || store.get('api_base') || '').replace(/\/$/, '');
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
// Form submit that runs once at a time: the submit button is disabled until the request returns
// (a second tap would otherwise send — and pay for — another SMS code).
const once = (fn) => {
  let running = false;
  return guard(async (e) => {
    e?.preventDefault?.();
    if (running) return;
    running = true;
    const btn = e?.target?.querySelector?.('button:not([type=button])');
    const label = btn?.textContent;
    if (btn) { btn.disabled = true; btn.textContent = 'لطفاً صبر کنید…'; }
    try { await fn(e); } finally { running = false; if (btn?.isConnected) { btn.disabled = false; btn.textContent = label; } }
  });
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
  patient: [['assistant', 'دستیار هوشمند'], ['doctors', 'پزشکان'], ['book', 'رزرو نوبت'], ['appointments', 'نوبت‌های من'], ['records', 'مدارک پزشکی'], ['prescriptions', 'نسخه‌ها'], ['inbox', 'پیام‌ها'], ['profile', 'پروفایل و حریم خصوصی']],
  doctor: [['doctor-appointments', 'نوبت‌ها'], ['calendar', 'تقویم'], ['doctor-rx', 'نسخه‌ها'], ['doctor-profile', 'پروفایل و مدارک'], ['inbox', 'اعلان‌ها']],
  doctor_pending: [['doctor-profile', 'پروفایل و مدارک'], ['inbox', 'اعلان‌ها']],
  // Staff tabs are shown by permission (see TAB_PERMS); operator and admin share the same list.
  operator: [['escalations', 'درخواست‌های ارجاع'], ['stats', 'آمار']],
  admin: [['admin-doctors', 'تأیید پزشکان'], ['settings', 'تنظیمات سیستم'], ['drug-catalog', 'فهرست داروها'], ['payments', 'پرداخت‌ها'], ['accounting', 'حسابداری'], ['escalations', 'درخواست‌های ارجاع'], ['stats', 'آمار'], ['audit', 'لاگ ممیزی'], ['activity', 'سابقه ورود و فعالیت'], ['staff', 'کاربران و نقش‌ها']],
};
TABS.doctor.splice(4, 0, ['doctor-accounting', 'حسابداری من']);
for (const k of ['patient', 'doctor', 'doctor_pending']) TABS[k].push(['my-activity', 'سابقه ورود']);
const TAB_PERMS = {
  'admin-doctors': 'doctors.review', settings: 'tariffs.manage', 'drug-catalog': 'drug_catalog.manage', payments: 'payments.view',
  accounting: 'accounting.view', escalations: 'escalations.handle', stats: 'stats.view', audit: 'audit.view', activity: 'activity.view', staff: 'users.manage',
};
function tabsFor(u) {
  if (['admin', 'operator'].includes(u.role)) {
    const perms = u.permissions ?? (u.role === 'admin' ? Object.values(TAB_PERMS) : ['escalations.handle', 'stats.view']);
    return [...TABS.admin.filter(([id]) => perms.includes(TAB_PERMS[id])), ['my-activity', 'سابقه ورود من']];
  }
  return TABS[u.role === 'doctor' && u.doctor_status && u.doctor_status !== 'approved' ? 'doctor_pending' : u.role] ?? [];
}

// Icons for every section (navigation bar, home tiles, staff menu).
const TAB_ICONS = {
  home: 'home', assistant: 'assistant', doctors: 'doctors', book: 'stethoscope', appointments: 'calendar', records: 'folder',
  prescriptions: 'rx', inbox: 'bell', profile: 'user', 'my-activity': 'history',
  'doctor-appointments': 'stethoscope', calendar: 'calendar', 'doctor-rx': 'rx', 'doctor-profile': 'idcard', 'doctor-accounting': 'wallet',
  'admin-doctors': 'approve', settings: 'settings', 'drug-catalog': 'catalog', payments: 'card', accounting: 'wallet',
  escalations: 'alert', stats: 'chart', audit: 'shield', activity: 'history', staff: 'team', 'staff-create': 'team',
};
// Phones: a bottom bar with five sections for patients and doctors (the rest is on the home
// screen and in the top bar). Staff have many sections: a menu (side menu on wide screens).
const BOTTOM_NAV = {
  patient: [['home', 'خانه'], ['appointments', 'نوبت‌ها'], ['assistant', 'دستیار هوشمند', true], ['records', 'پرونده من'], ['profile', 'پروفایل']],
  doctor: [['doctor-appointments', 'نوبت‌ها'], ['calendar', 'تقویم'], ['doctor-rx', 'نسخه‌ها'], ['doctor-accounting', 'حسابداری'], ['doctor-profile', 'پروفایل']],
};
// Pages reached from the home screen highlight the bar item they belong to.
const NAV_PARENT = { doctors: 'home', book: 'home', prescriptions: 'records', summary: 'appointments', room: 'appointments', 'my-activity': 'profile', inbox: 'home' };
const isStaff = (u) => ['admin', 'operator'].includes(u?.role);
function navFor(u) {
  if (u.role === 'patient') return BOTTOM_NAV.patient;
  if (u.role === 'doctor') return u.doctor_status && u.doctor_status !== 'approved' ? [] : BOTTOM_NAV.doctor;
  return [['home', 'پیشخوان'], ...tabsFor(u)];
}

// Unread messages: notifications newer than the last time the inbox was opened (kept on the device).
const badge = { count: 0, at: 0, newest: null };
const seenKey = () => `inbox_seen:${session?.user?.id}`;
async function refreshBadge(force = false) {
  if (!session || (!force && Date.now() - badge.at < 25_000)) return;
  badge.at = Date.now();
  try {
    const r = await api('GET', '/v1/notifications');
    const seen = store.get(seenKey(), '');
    badge.count = r.items.filter((n) => n.created_at > seen).length;
    paintBadge();
    // Something new since the last check (not on the first check after opening the app): show it.
    const fresh = badge.newest ? r.items.filter((n) => n.created_at > badge.newest) : [];
    if (r.items[0]) badge.newest = r.items[0].created_at;
    else if (!badge.newest) badge.newest = new Date().toISOString();
    if (fresh.length && current.view !== 'inbox') announce(fresh);
  } catch { /* offline */ }
}
// New notifications: an on-screen message, plus a system notification when the user allowed it
// (browser / installed web app; inside the Android app the on-screen message is shown).
function announce(items) {
  const first = items[0].body;
  toast(items.length > 1 ? `${fa(items.length)} اعلان جدید — ${first}` : `🔔 ${first}`);
  if (typeof Notification !== 'undefined' && Notification.permission === 'granted' && document.visibilityState !== 'visible') {
    for (const n of items.slice(0, 3)) {
      try { new Notification('درمان پلاس', { body: n.body, icon: 'icons/icon-192.png', tag: n.id }); } catch { /* not allowed here */ }
    }
  }
}
const canNotify = () => typeof Notification !== 'undefined' && !IS_NATIVE;
function notifyPermissionCard() {
  if (!canNotify() || Notification.permission === 'granted') return null;
  const card = h('div', { class: 'card row' }, h('span', { class: 'svc-ic tone-rose' }, icon('bell', 24)),
    h('div', { class: 'grow' }, h('b', {}, 'اعلان‌ها روی این دستگاه'),
      h('div', { class: 'muted' }, Notification.permission === 'denied'
        ? 'اعلان‌ها در تنظیمات مرورگر برای این سایت بسته شده‌اند؛ برای دریافت یادآوری ویزیت آن را باز کنید.'
        : 'یادآوری ویزیت، باز شدن اتاق ویزیت و پیام‌ها را حتی وقتی صفحه باز نیست دریافت کنید.')),
    Notification.permission === 'denied' ? null : h('button', { class: 'btn primary small', onclick: guard(async () => {
      const r = await Notification.requestPermission();
      if (r === 'granted') { toast('اعلان‌ها فعال شد'); card.remove(); } else toast('اجازه اعلان داده نشد', true);
    }) }, 'فعال‌سازی'));
  return card;
}
setInterval(() => refreshBadge(), 30_000);
function paintBadge() {
  const b = document.getElementById('bell-count');
  if (b) { b.textContent = badge.count > 9 ? '۹+' : fa(badge.count); b.hidden = !badge.count; }
}

function renderChrome() {
  $user.replaceChildren();
  $tabs.replaceChildren();
  $tabs.className = 'tabs';
  document.body.classList.remove('has-bottomnav', 'has-sidenav');
  if (!session) return;
  const u = session.user;
  const active = NAV_PARENT[current.view] && !navFor(u).some(([id]) => id === current.view) ? NAV_PARENT[current.view] : current.view;
  const bell = h('button', { class: 'icon-btn', type: 'button', title: 'پیام‌ها و اعلان‌ها', 'aria-label': 'پیام‌ها و اعلان‌ها', onclick: () => route('inbox') },
    icon('bell', 22), h('span', { class: 'count', id: 'bell-count', hidden: true }));
  $user.append(
    h('span', { class: 'who' }, `${u.full_name || fa(u.phone)} · ${LABELS.role[u.role]}`),
    bell,
    h('button', { class: 'icon-btn', type: 'button', title: 'خروج', 'aria-label': 'خروج', onclick: logout }, icon('logout', 22)),
  );
  paintBadge();
  refreshBadge();
  const items = navFor(u);
  if (!items.length) return;
  const bottom = !isStaff(u);
  $tabs.classList.add(bottom ? 'nav-bottom' : 'nav-side');
  document.body.classList.add(bottom ? 'has-bottomnav' : 'has-sidenav');
  for (const [id, label, fab] of items) {
    $tabs.append(h('button', { class: fab ? 'fab' : null, 'aria-current': active === id ? 'page' : null, onclick: () => route(id) },
      h('span', { class: 'ic' }, icon(TAB_ICONS[id] ?? 'plus', fab ? 28 : 22)), h('span', { class: 'lbl' }, label)));
  }
}

// The public website, shown in the app (login screen, home screen).
const SITE = 'darman-plus.ir';
const siteLink = () => h('a', { class: 'muted site-link', href: `https://${SITE}`, target: '_blank', rel: 'noopener' }, '🌐 ', h('bdi', {}, SITE));

// Home-screen tile: a coloured icon with its label.
const tile = (id, label, tone, onclick = () => route(id), sub = null) => h('button', { class: `svc tone-${tone}`, type: 'button', onclick },
  h('span', { class: 'svc-ic' }, icon(TAB_ICONS[id] ?? id, 30)), h('span', { class: 'svc-lbl' }, label), sub ? h('span', { class: 'svc-sub' }, sub) : null);

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
    let me;
    try { me = await api('GET', '/v1/patients/me'); } catch (e) { if (e.code === 'profile_incomplete') return route('onboarding'); throw e; }
    return patientHome(me);
  }
  const me = await api('GET', '/v1/auth/me');
  setSession({ ...session, user: { ...session.user, doctor_status: me.doctor_status, full_name: me.full_name, permissions: me.permissions, staff_role: me.staff_role } });
  if (r === 'doctor' && me.doctor_status !== 'approved') return route('doctor-profile');
  if (r === 'doctor') return route('doctor-appointments');
  // Staff: a dashboard of the sections this person may open.
  renderChrome();
  const tones = ['blue', 'green', 'navy', 'amber', 'violet', 'rose'];
  $app.append(h('div', { class: 'card' }, h('h2', {}, `سلام ${me.full_name || ''}`.trim()),
    h('p', { class: 'muted' }, me.staff_role ? `نقش شما: ${me.staff_role.name ?? me.staff_role}` : 'دسترسی کامل مدیریت'),
    h('div', { class: 'svc-grid' }, [...tabsFor(session.user)].map(([id, label], i) => tile(id, label, tones[i % tones.length])))));
};

async function patientHome(me) {
  const first = (me.full_name || '').split(' ')[0];
  const next = h('div');
  $app.append(
    h('div', { class: 'home-hello' }, h('h2', {}, first ? `سلام ${first}` : 'سلام'), h('p', { class: 'muted' }, 'امروز چه کمکی از دست ما برمی‌آید؟')),
    h('button', { class: 'home-banner', type: 'button', onclick: () => route('assistant') },
      h('span', { class: 'hb-text' }, h('b', {}, 'سلامت، همیشه در دسترس'), h('span', {}, 'علائم خود را با دستیار هوشمند در میان بگذارید؛ در صورت نیاز همان‌جا نوبت ویزیت بگیرید.'), h('span', { class: 'hb-cta' }, 'شروع گفتگو ←')),
      h('span', { class: 'hb-art' }, h('img', { src: 'brand/mark-white.svg', alt: '', width: 84, height: 84 }))),
    next,
    notifyPermissionCard(),
    h('div', { class: 'card' }, h('h3', {}, 'خدمات'),
      h('div', { class: 'svc-grid' },
        tile('book', 'ویزیت با پزشک', 'blue'),
        tile('assistant', 'بررسی علائم', 'green', () => route('assistant', 'triage')),
        tile('doctors', 'پزشکان', 'navy'),
        tile('prescriptions', 'نسخه‌ها', 'violet'),
        tile('records', 'مدارک پزشکی', 'amber'),
        tile('inbox', 'پیام‌ها', 'rose'))),
    h('p', { class: 'muted', style: 'text-align:center' }, 'درمان پلاس — ', siteLink()),
  );
  // The next confirmed visit, if any, right on the home screen.
  const r = await api('GET', '/v1/appointments?limit=50').catch(() => ({ items: [] }));
  const now = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  const a = r.items.filter((x) => x.status === 'confirmed' && x.starts_at > now).sort((x, y) => x.starts_at.localeCompare(y.starts_at))[0]
    ?? r.items.find((x) => x.status === 'pending');
  if (a?.queue) every(30_000, () => { if (current.view === 'home') route('home'); });
  if (a) {
    next.replaceChildren(h('div', { class: 'card next-visit' }, queueBox(a),
      h('div', { class: 'row' }, h('span', { class: 'svc-ic tone-blue' }, icon('calendar', 26)),
        h('div', { class: 'grow' }, h('div', { class: 'muted' }, a.status === 'pending' ? 'نوبت در انتظار پرداخت' : 'نوبت بعدی شما'),
          h('b', {}, a.doctor?.full_name ?? ''), ' ', h('span', { class: 'muted' }, a.doctor?.specialty_label ?? ''), h('br'),
          h('span', {}, fmt.dt(a.starts_at)), ' · ', h('span', { class: 'muted' }, LABELS.channel[a.channel])),
        a.status === 'confirmed'
          ? joinButton(a)
          : h('button', { class: 'btn small', onclick: () => route('appointments') }, 'مشاهده'))));
  }
}

VIEWS.login = () => {
  let phone = '';
  let role = null; // 'patient' | 'doctor' — chosen on the start screen
  let mfaToken = null;
  let lastNid = null; // national id of a registration, reused by "send again"
  const box = h('div', { class: 'card narrow stack' });
  const hint = h('div', { class: 'muted' });
  const showDevCode = (code, to = '', delivery = 'sms') => hint.replaceChildren(code
    ? h('div', { class: 'banner info' }, `محیط آزمایشی — کد: ${fa(code)}`)
    : h('p', { class: 'muted' }, delivery === 'voice'
      ? `تا لحظاتی دیگر با شماره ${fa(to)} تماس گرفته می‌شود و کد تأیید خوانده می‌شود.`
      : `کد تأیید ${to ? `به شماره ${fa(to)} ` : ''}پیامک شد.`));
  // App builds with the server address built in only show the website; others can change the server.
  const footer = () => h('div', { class: 'row', style: 'justify-content:space-between' },
    IS_NATIVE ? (window.TELEHEALTH_API_BASE ? null : h('button', { class: 'btn small', onclick: () => route('server') }, `سرور: ${API_BASE.replace(/^https?:\/\//, '')} — تغییر`)) : installButton(),
    siteLink());

  // Start screen: two entries, as in the requirements.
  const stepRole = () => {
    box.className = 'narrow stack';
    box.replaceChildren(
      h('div', { class: 'hero' }, h('img', { src: 'icon.svg', alt: '', width: 72, height: 72 }), h('h1', { class: 'wordmark', 'aria-label': 'درمان پلاس' }, h('b', {}, 'درمان'), ' ', h('i', {}, 'پلاس')), h('div', { class: 'wordmark-latin', 'aria-hidden': 'true' }, 'DARMAN PLUS'), h('p', { class: 'tagline' }, 'سلامت، همیشه در دسترس'), h('p', { class: 'muted' }, 'ویزیت آنلاین با پزشک و دستیار هوشمند')),
      h('button', { class: 'entry', onclick: () => { role = 'patient'; stepPhone(); } },
        h('span', { class: 'entry-icon' }, '🧑'), h('span', {}, h('b', {}, 'ثبت‌نام و ورود بیماران'), h('br'), h('small', { class: 'muted' }, 'دریافت نوبت، ویزیت آنلاین، دستیار هوشمند'))),
      h('button', { class: 'entry', onclick: () => { role = 'doctor'; stepPhone(); } },
        h('span', { class: 'entry-icon' }, '👨‍⚕️'), h('span', {}, h('b', {}, 'ثبت‌نام و ورود پزشکان'), h('br'), h('small', { class: 'muted' }, 'پزشکان و کادر کلینیک'))),
      config.dev_mode ? h('div', { class: 'banner info small' },
        h('b', {}, 'حساب‌های نمونه (ورود پزشکان): '), 'پزشک ', h('bdi', {}, '09120000001'), ' · اپراتور ', h('bdi', {}, '09120000009'), ' · مدیر ', h('bdi', {}, '09120000010')) : null,
      footer(),
    );
  };

  const stepPhone = (needNid = false) => {
    box.className = 'card narrow stack';
    const input = h('input', { type: 'tel', dir: 'ltr', placeholder: '09121234567', autocomplete: 'tel', inputmode: 'tel', value: phone });
    const nid = needNid ? h('input', { type: 'text', dir: 'ltr', inputmode: 'numeric', maxlength: 10, placeholder: 'کد ملی ۱۰ رقمی' }) : null;
    const submit = once(async () => {
      phone = input.value.trim();
      lastNid = nid ? nid.value.trim() : null;
      const r = await api('POST', '/v1/auth/otp/request', { phone, role, ...(lastNid ? { national_id: lastNid } : {}) });
      if (r.registration_required) { stepPhone(true); return; }
      stepCode(r.registration, r.resend_in);
      if (r.already_sent) toast('کد تأیید چند لحظه پیش ارسال شده است؛ همان کد را وارد کنید');
      showDevCode(r.dev_code, phone, r.delivery);
    });
    box.replaceChildren(
      h('button', { class: 'btn small', type: 'button', onclick: stepRole }, '→ بازگشت'),
      h('h2', {}, role === 'doctor' ? 'ورود / ثبت‌نام پزشکان' : 'ورود / ثبت‌نام بیماران'),
      h('p', { class: 'muted' }, needNid
        ? 'این شماره هنوز ثبت‌نام نشده است. برای ثبت‌نام کد ملی خود را وارد کنید؛ تطابق شماره موبایل با کد ملی از طریق سامانه شاهکار بررسی می‌شود. شماره باید به نام خود شما باشد.'
        : 'شماره موبایل خود را وارد کنید. کد تأیید پیامک می‌شود.'),
      h('form', { onsubmit: submit, class: 'stack' },
        h('label', {}, 'شماره موبایل'), input,
        nid ? h('label', {}, 'کد ملی') : null, nid,
        h('button', { class: 'btn primary block' }, needNid ? 'استعلام و دریافت کد' : 'ادامه')),
      footer(),
    );
    (nid ?? input).focus();
  };

  const stepCode = (registering = false, resendIn = 60) => {
    const input = h('input', { type: 'text', dir: 'ltr', inputmode: 'numeric', autocomplete: 'one-time-code', maxlength: 6 });
    // "Send again" unlocks after the server's resend window.
    const resend = h('button', { class: 'btn small', type: 'button', disabled: true });
    let left = resendIn ?? 60;
    const tick = () => {
      if (!resend.isConnected && left < (resendIn ?? 60)) return clearInterval(timer);
      resend.disabled = left > 0;
      resend.textContent = left > 0 ? `ارسال مجدد کد (${fa(left)} ثانیه)` : 'ارسال مجدد کد';
      left -= 1;
    };
    const timer = setInterval(tick, 1000);
    tick();
    resend.onclick = guard(async () => {
      resend.disabled = true;
      const r = await api('POST', '/v1/auth/otp/request', { phone, role, ...(lastNid ? { national_id: lastNid } : {}) });
      left = r.resend_in ?? 60;
      toast(r.already_sent ? 'کد قبلی هنوز معتبر است؛ کمی بعد دوباره تلاش کنید' : 'کد جدید ارسال شد؛ کدهای قبلی باطل شدند');
      showDevCode(r.dev_code, phone, r.delivery);
      tick();
    });
    const submit = once(async () => {
      const r = await api('POST', '/v1/auth/otp/verify', { phone, code: input.value });
      if (r.mfa_required) { mfaToken = r.mfa_token; stepMfa(); showDevCode(r.dev_code, phone, r.delivery); return; }
      done(r);
    });
    box.replaceChildren(
      h('h2', {}, 'کد تأیید'),
      ...(registering ? [h('div', { class: 'banner info' }, '✓ تطابق شماره موبایل و کد ملی در سامانه شاهکار تأیید شد.')] : []),
      h('p', { class: 'muted' }, `کد ۶ رقمی ارسال‌شده به ${fa(phone)} را وارد کنید.`),
      hint,
      h('form', { onsubmit: submit, class: 'stack' }, input, h('button', { class: 'btn primary block' }, 'ورود')),
      h('div', { class: 'row', style: 'gap:8px;flex-wrap:wrap' }, resend, h('button', { class: 'btn small', type: 'button', onclick: () => { clearInterval(timer); stepPhone(); } }, 'تغییر شماره')),
    );
    input.focus();
  };

  const stepMfa = () => {
    const input = h('input', { type: 'text', dir: 'ltr', inputmode: 'numeric', maxlength: 6 });
    const submit = once(async () => {
      done(await api('POST', '/v1/auth/mfa/verify', { mfa_token: mfaToken, code: input.value }));
    });
    box.replaceChildren(
      h('h2', {}, 'تأیید دومرحله‌ای'),
      h('p', { class: 'muted' }, 'برای امنیت حساب‌های پزشک و کادر، یک کد دوم (جدا از کد ورود) برای شما پیامک شد.'),
      hint,
      h('form', { onsubmit: submit, class: 'stack' }, input, h('button', { class: 'btn primary block' }, 'تأیید')),
    );
    input.focus();
  };

  const done = (r) => { setSession(r); route('home'); };
  stepRole();
  $app.append(box);
};

VIEWS.onboarding = async () => {
  const me = await api('GET', '/v1/auth/me').catch(() => ({}));
  const f = {
    full_name: h('input', { type: 'text', autocomplete: 'name', value: me.full_name ?? '' }),
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
      ...(me.person_info_enabled ? {} : { full_name: f.full_name.value }), ...(me.identity_verified_at ? {} : { national_id: f.national_id.value }), dob: f.dob.value,
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
      me.person_info_enabled
        ? h('div', {}, h('label', {}, 'نام و نام خانوادگی'), h('p', { class: 'muted' }, 'پس از ثبت، از روی کد ملی و تاریخ تولد از ثبت احوال دریافت می‌شود.'))
        : h('div', {}, h('label', {}, 'نام و نام خانوادگی *'), f.full_name),
      me.identity_verified_at
        ? h('div', {}, h('label', {}, 'کد ملی'), h('p', {}, `✓ تأییدشده با ${me.identity_source === 'shahkar' ? 'سامانه شاهکار' : 'استعلام آزمایشی'} هنگام ثبت‌نام`))
        : h('div', {}, h('label', {}, 'کد ملی *'), f.national_id),
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
VIEWS.assistant = async (arg) => {
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
      if (!log.childElementCount) bubble('assistant', 'سلام! من دستیار هوشمند درمان پلاس هستم. می‌توانم علائم شما را بررسی کنم، به پرسش‌های عمومی پاسخ بدهم و برایتان نوبت بگیرم. تشخیص و تجویز فقط با پزشک است.');
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

  const startWizard = guard(async () => {
    if (!(await V2.ensureTriagePaid())) return;
    await openTriageWizard({ h, api, toast, fa, onSubmit: (form) => send('📋 فرم بررسی علائم ارسال شد', form) });
  });

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
          else if (ev === 'payment') {
            botEl.after(h('div', { class: 'chips' }, h('button', { class: 'btn primary small', onclick: guard(() => V2.pay(data.payment_id, {
              title: data.purpose === 'triage' ? 'پرداخت هزینه ارزیابی علائم' : 'پرداخت هزینه ویزیت',
              onPaid: () => toast(data.purpose === 'triage' ? 'اکنون می‌توانید علائم خود را بنویسید یا «بررسی علائم» را بزنید' : 'نوبت شما قطعی شد ✅'),
            })) }, `💳 پرداخت ${fa(Math.round(data.amount / 10).toLocaleString('en-US'))} تومان`)));
          } else if (ev === 'escalation') chips.append(h('span', { class: 'chip' }, data.kind === 'emergency' ? '🚨 اپراتور مطلع شد' : '👤 به اپراتور ارجاع شد'));
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
  if (arg === 'triage') startWizard(); // "بررسی علائم" on the home screen
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
        const a = await api('POST', '/v1/appointments', { doctor_id: chosen.doctor_id, slot_id: chosen.id, channel: channel.value }, { 'Idempotency-Key': key });
        if (a.status === 'pending' && a.payment) {
          toast('نوبت به‌طور موقت رزرو شد؛ پرداخت را انجام دهید');
          route('appointments');
          V2.pay(a.payment.id, { title: 'پرداخت هزینه ویزیت', onPaid: () => route('appointments') });
          return;
        }
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
// "Enter the visit room": active only from the room's opening time (set by the admin) until
// shortly after the visit; before that it shows when it opens and switches on by itself.
function joinButton(a, cls = 'btn primary small') {
  const btn = h('button', { class: cls, onclick: () => route('room', a.consultation.id) }, 'ورود به اتاق ویزیت');
  const w = a.join;
  if (!w?.enforced) return btn;
  const now = Date.now();
  if (now > Date.parse(w.closes_at)) return h('span', { class: 'muted small' }, 'زمان ویزیت گذشته است');
  const opens = Date.parse(w.opens_at);
  if (now < opens) {
    btn.disabled = true;
    btn.className = cls.replace('primary', '');
    btn.textContent = `اتاق ویزیت ${tehranDayKey(w.opens_at) === tehranDayKey(new Date()) ? `ساعت ${fmt.time(w.opens_at)}` : fmt.dt(w.opens_at)} باز می‌شود`;
    if (opens - now < 6 * 3600e3) {
      const id = setTimeout(() => { btn.disabled = false; btn.className = cls; btn.textContent = 'ورود به اتاق ویزیت'; toast('اتاق ویزیت باز شد'); }, opens - now + 500);
      onCleanup(() => clearTimeout(id));
    }
  }
  return btn;
}

// Live queue of the visit's day, as the patient sees it: place, people ahead, expected start.
function queueBox(a) {
  const q = a.queue;
  if (!q) return null;
  const DOT = { done: 'q-done', no_show: 'q-done', missed: 'q-done', in_visit: 'q-live', waiting: 'q-wait', me: 'q-me' };
  const dots = h('div', { class: 'q-dots', 'aria-hidden': 'true' }, q.states.map((st, i) => h('span', { class: `q-dot ${DOT[st]}` }, fa(i + 1))));
  let line;
  if (q.state === 'in_visit') line = h('b', {}, 'ویزیت شما در حال انجام است');
  else if (q.ahead_waiting === 0 && q.ahead_in_visit === 0) line = h('b', {}, 'نوبت شماست — وارد اتاق ویزیت شوید');
  else {
    const parts = [];
    if (q.ahead_in_visit) parts.push(`${fa(q.ahead_in_visit)} نفر در حال ویزیت`);
    if (q.ahead_waiting) parts.push(`${fa(q.ahead_waiting)} نفر در انتظار`);
    line = h('span', {}, `قبل از شما: ${parts.join(' و ')}`);
  }
  return h('div', { class: 'queue-box' },
    h('div', { class: 'row', style: 'justify-content:space-between' },
      h('b', {}, `صف ویزیت امروز — نوبت ${fa(q.position)} از ${fa(q.total)}`),
      q.est_start && q.state === 'waiting' ? h('span', { class: `pill ${q.delay_min >= 10 ? 'warn' : 'info'}` }, `شروع تخمینی ${fmt.time(q.est_start)}`) : null),
    dots,
    h('div', {}, line, q.delay_min >= 5 && q.state === 'waiting' ? h('span', { class: 'muted' }, ` (حدود ${fa(q.delay_min)} دقیقه تأخیر)`) : null));
}

// Cancel a visit. A doctor must give a reason, which is sent to the patient.
function cancelAppointment(a, role, after = () => route(current.view)) {
  const reason = h('textarea', { rows: 3, maxlength: 300, placeholder: role === 'doctor' ? 'مثلاً: شرایط اضطراری؛ لطفاً نوبت دیگری بگیرید' : 'اختیاری' });
  const box = h('div', { class: 'wizard-overlay', role: 'dialog', 'aria-modal': 'true' }, h('div', { class: 'card pay-box stack' },
    h('h2', {}, 'لغو نوبت'),
    h('p', { class: 'muted' }, role === 'doctor'
      ? 'دلیل لغو برای بیمار پیامک/اعلان می‌شود. اگر بیمار هزینه را پرداخت کرده باشد، بازگشت وجه به مدیر اطلاع داده می‌شود.'
      : 'نوبت آزاد می‌شود و به پزشک اطلاع داده می‌شود.'),
    h('label', {}, role === 'doctor' ? 'دلیل لغو (الزامی)' : 'دلیل لغو'), reason,
    h('div', { class: 'row' },
      h('button', { class: 'btn danger', onclick: guard(async () => {
        if (role === 'doctor' && reason.value.trim().length < 3) return toast('دلیل لغو را بنویسید', true);
        await api('POST', `/v1/appointments/${a.id}/cancel`, { reason: reason.value.trim() || null });
        box.remove(); toast('نوبت لغو شد'); after();
      }) }, 'لغو نوبت'),
      h('button', { class: 'btn', onclick: () => box.remove() }, 'انصراف'))));
  document.body.append(box);
  reason.focus();
}

function appointmentItem(a, role) {
  const actions = [];
  if (a.status === 'confirmed') {
    actions.push(joinButton(a));
    actions.push(h('button', { class: 'btn danger small', onclick: () => cancelAppointment(a, role) }, 'لغو نوبت'));
  }
  if (a.status === 'pending' && role === 'doctor') actions.push(h('button', { class: 'btn danger small', onclick: () => cancelAppointment(a, role) }, 'لغو نوبت'));
  if (a.status === 'completed' && role === 'doctor') actions.push(h('button', { class: 'btn small', onclick: () => route('room', a.consultation.id) }, a.summary_ready ? 'پرونده ویزیت' : '📝 خلاصه ویزیت (پیش‌نویس)'));
  if (a.status === 'completed' && role === 'patient' && a.summary_ready) actions.push(h('button', { class: 'btn primary small', onclick: () => route('summary', a.consultation.id) }, '📝 خلاصه ویزیت'));
  if (role === 'patient' && ['pending', 'confirmed'].includes(a.status)) actions.push(h('button', { class: 'btn small', onclick: () => route('records') }, '📎 ارسال مدرک'));
  return h('li', {}, role === 'patient' ? V2.paymentBanner(a, () => route('appointments')) : null, role === 'patient' ? queueBox(a) : null, h('div', { class: 'row' },
    h('div', { class: 'grow' },
      h('b', {}, role === 'doctor' ? (a.patient?.full_name ?? 'بیمار') : a.doctor?.full_name), ' ',
      h('span', { class: 'muted' }, role === 'doctor' ? '' : a.doctor?.specialty_label), h('br'),
      h('span', {}, fmt.dt(a.starts_at)), ' · ', h('span', { class: 'muted' }, LABELS.channel[a.channel]),
      a.booked_via === 'ai_assistant' ? h('span', { class: 'pill info', style: 'margin-inline-start:6px' }, 'رزرو با دستیار') : null,
      a.triage ? h('span', { style: 'margin-inline-start:6px' }, urgencyPill(a.triage.urgency_level)) : null,
      a.status === 'cancelled' && a.cancelled_by && a.cancel_reason !== 'rescheduled'
        ? h('div', { class: 'muted small' }, `لغو توسط ${{ doctor: 'پزشک', patient: 'بیمار', admin: 'مدیر', operator: 'اپراتور' }[a.cancelled_by] ?? 'سامانه'}${a.cancel_reason ? ` — دلیل: ${a.cancel_reason}` : ''}`) : null),
    statusPill(a.status), ...actions));
}

VIEWS.appointments = async () => {
  const r = await api('GET', '/v1/appointments?limit=50');
  // Keep today's queue fresh while the page is open.
  if (r.items.some((a) => a.queue)) every(30_000, () => { if (current.view === 'appointments' && !document.querySelector('.wizard-overlay')) route('appointments'); });
  $app.append(h('div', { class: 'card' }, h('h2', {}, 'نوبت‌های من'),
    r.items.length ? h('ul', { class: 'list' }, r.items.map((a) => appointmentItem(a, 'patient')))
      : h('div', { class: 'empty' }, 'هنوز نوبتی ندارید. ', h('a', { href: '#book', onclick: (e) => { e.preventDefault(); route('book'); } }, 'رزرو نوبت'))));
};

// The doctor's queue for today: order, state and expected start of every visit.
async function doctorQueueCard() {
  const q = (await api('GET', '/v1/doctors/me/queue')).items;
  if (!q.length) return null;
  const ST = { done: ['انجام شد', ''], no_show: ['عدم حضور', 'danger'], missed: ['از دست رفته', 'danger'], in_visit: ['در حال ویزیت', 'ok'], waiting: ['در انتظار', 'info'] };
  const live = q.find((x) => x.state === 'in_visit');
  const nextUp = q.find((x) => x.state === 'waiting');
  const delay = (live ?? nextUp)?.delay_min ?? 0;
  return h('div', { class: 'card' },
    h('div', { class: 'row', style: 'justify-content:space-between' }, h('h2', { style: 'margin:0' }, 'صف امروز'),
      h('span', { class: `pill ${delay >= 10 ? 'warn' : 'info'}` }, delay >= 5 ? `حدود ${fa(delay)} دقیقه عقب‌تر از برنامه` : 'طبق برنامه')),
    h('ul', { class: 'list' }, q.map((x) => h('li', { class: 'row' },
      h('span', { class: `q-dot ${x.state === 'in_visit' ? 'q-live' : x.state === 'waiting' ? 'q-wait' : 'q-done'}` }, fa(x.position)),
      h('div', { class: 'grow' }, h('b', {}, x.patient_name ?? 'بیمار'), h('br'),
        h('span', { class: 'muted' }, `ساعت نوبت ${fmt.time(x.starts_at)}`, x.state === 'waiting' && x.delay_min >= 5 ? ` · شروع تخمینی ${fmt.time(x.est_start)}` : '')),
      h('span', { class: `pill ${ST[x.state][1]}` }, ST[x.state][0]),
      ['waiting', 'in_visit'].includes(x.state) ? h('button', { class: `btn small ${x.state === 'in_visit' || x === nextUp ? 'primary' : ''}`, onclick: () => route('room', x.consultation_id) }, 'اتاق ویزیت') : null,
      x.state === 'waiting' && Date.parse(x.starts_at) <= Date.now() ? h('button', { class: 'btn small danger', onclick: guard(async () => {
        if (!confirm('عدم حضور بیمار ثبت شود؟')) return;
        await api('POST', `/v1/appointments/${x.appointment_id}/no-show`, {});
        toast('عدم حضور ثبت شد'); route(current.view);
      }) }, 'عدم حضور') : null))));
}

VIEWS['doctor-appointments'] = async () => {
  const r = await api('GET', '/v1/appointments?limit=100');
  const todayQueue = await doctorQueueCard().catch(() => null);
  if (todayQueue) every(30_000, () => { if (current.view === 'doctor-appointments' && !document.querySelector('.wizard-overlay')) route('doctor-appointments'); });
  const upcoming = r.items.filter((a) => a.status === 'confirmed').sort((a, b) => a.starts_at.localeCompare(b.starts_at));
  const past = r.items.filter((a) => a.status !== 'confirmed');
  $app.append(
    notifyPermissionCard(),
    todayQueue,
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

  const media = info.channel === 'chat' ? null : callPanel(cid, info, join, isDoctor);

  $app.append(
    h('div', { class: 'row', style: 'margin-bottom:10px' }, h('button', { class: 'btn small', onclick: () => route(isDoctor ? 'doctor-appointments' : 'appointments') }, '→ بازگشت'),
      h('b', {}, 'اتاق ویزیت'), ended ? h('span', { class: 'pill' }, 'پایان‌یافته') : h('span', { class: 'pill ok' }, 'فعال')),
    (ended ? null : media) ?? "",
    h('div', { class: 'card chat', style: 'height:auto' }, log, ended ? null : h('div', { class: 'chat-input' }, input, sendBtn)),
  );
  await poll();
  if (!ended) every(3000, () => poll().catch(() => {}));

  if (isDoctor) await doctorPanel(cid, info, ended);
};

// Video/audio call card (WebRTC). Chat below stays available as the fallback channel.
function callPanel(cid, info, join, isDoctor) {
  const other = isDoctor ? 'بیمار' : 'پزشک';
  if (!join) return null;
  if (!mediaSupported()) {
    return h('div', { class: 'banner warn' }, `تماس ${LABELS.channel[info.channel]} در این مرورگر در دسترس نیست (به اپ موبایل یا نسخهٔ HTTPS نیاز دارد). ویزیت را با پیام متنی ادامه دهید.`);
  }
  const wantVideo = info.channel === 'video';
  const remote = h('video', { class: 'v-remote', autoplay: true, playsinline: true });
  const local = h('video', { class: 'v-local', autoplay: true, playsinline: true, muted: true });
  local.muted = true;
  const status = h('div', { class: 'call-status', role: 'status' }, `برای شروع، دکمه «شروع تماس» را بزنید. ${other} هم باید وارد اتاق شود.`);
  const controls = h('div', { class: 'call-controls' });
  let call = null;
  const btn = (label, onclick, cls = '') => h('button', { class: `btn ${cls}`, onclick }, label);
  const showIdle = () => controls.replaceChildren(btn(wantVideo ? '📹 شروع تماس تصویری' : '📞 شروع تماس صوتی', start, 'primary'));
  async function start() {
    call = startCall({
      api, cid, role: isDoctor ? 'doctor' : 'patient', iceServers: join.ice_servers ?? [], videoWanted: wantVideo,
      els: { remote, local },
      onState: (text, state) => {
        if (text) status.textContent = text;
        wrap.dataset.state = state ?? '';
        if (state === 'ended') showIdle();
        if (state === 'failed') status.textContent = 'اتصال تصویری برقرار نشد. اینترنت را بررسی کنید یا ویزیت را با پیام متنی ادامه دهید.';
      },
    });
    if (!(await call.begin())) { call = null; return; }
    const mic = btn('🎙️ قطع صدا', () => { const on = call.toggleMic(); mic.textContent = on ? '🎙️ قطع صدا' : '🔇 وصل صدا'; });
    const cam = wantVideo ? btn('📷 خاموش کردن دوربین', () => { const on = call.toggleCam(); cam.textContent = on ? '📷 خاموش کردن دوربین' : '📷 روشن کردن دوربین'; }) : null;
    controls.replaceChildren(mic, cam ?? '', btn('⛔ پایان تماس', () => { call.hangup(); call = null; }, 'danger'));
  }
  onCleanup(() => call?.hangup());
  showIdle();
  const wrap = h('div', { class: `card call${wantVideo ? '' : ' audio-only'}` },
    h('div', { class: 'stage' }, remote, wantVideo ? local : null, h('div', { class: 'stage-label' }, other)),
    status, controls);
  return wrap;
}

async function doctorPanel(cid, info, ended) {
  // After the visit the summary comes first; during it, the notes box sits below the prescription.
  const summary = await V2.summaryPanel(cid, ended).catch(() => h('div'));
  if (ended) $app.append(summary);
  $app.append(await V2.doctorRecords(info.appointment_id).catch(() => h('div')));
  $app.append(await V2.summaryHistory(info.patient_id, cid).catch(() => h('div')));
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

  // Prescription (diagnosis codes, personal templates, live safety checks) + end of visit
  $app.append(await V2.rxPanel(cid, {
    endButton: ended ? null : h('button', {
      class: 'btn danger', onclick: guard(async () => {
        if (!confirm('ویزیت پایان یابد؟')) return;
        await api('POST', `/v1/consultations/${cid}/end`, {});
        toast('ویزیت پایان یافت؛ پیش‌نویس خلاصه آماده است'); route('room', cid);
      }),
    }, 'پایان ویزیت'),
  }));
  if (!ended) $app.append(summary);
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
  if (r.items[0]) store.set(seenKey(), r.items[0].created_at);
  badge.count = 0; paintBadge();
  $app.append(notifyPermissionCard());
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
  // Allowed visit lengths come from the admin's system settings (filled on the first load).
  const dur = h('select', {}, h('option', { value: 30 }, `${fa(30)} دقیقه`));
  const list = h('div');
  // Wall-clock time in Tehran (UTC+03:30) → ISO.
  const toIso = (d, t) => { const [y, m, dd] = d.split('-').map(Number); const [hh, mm] = t.split(':').map(Number); return new Date(Date.UTC(y, m - 1, dd, hh, mm) - 210 * 60000).toISOString(); };
  const load = async () => {
    const r = await api('GET', '/v1/doctors/me/slots');
    if (r.visit && !dur.dataset.ready) {
      dur.replaceChildren(...r.visit.durations.map((m) => h('option', { value: m, selected: m === r.visit.default }, `${fa(m)} دقیقه`)));
      dur.dataset.ready = '1';
    }
    const days = new Map();
    for (const s of r.items) { const k = tehranDayKey(s.starts_at); if (!days.has(k)) days.set(k, []); days.get(k).push(s); }
    list.replaceChildren(...[...days.values()].map((slots) => h('div', {}, h('div', { class: 'day-title' }, fmt.day(slots[0].starts_at)),
      h('div', { class: 'slots' }, slots.map((s) => h('div', { class: 'slot', style: s.booked ? 'border-color:var(--primary)' : '' },
        fmt.time(s.starts_at), h('small', {}, s.booked
          ? h('button', { class: 'btn small danger', title: 'لغو نوبت بیمار', onclick: () => cancelAppointment({ id: s.appointment_id }, 'doctor', load) }, 'رزروشده · لغو')
          : h('button', { class: 'btn small', onclick: guard(async () => { await api('DELETE', `/v1/doctors/me/slots/${s.id}`); load(); }) }, 'حذف'))))))));
    if (!r.items.length) list.append(h('div', { class: 'empty' }, 'زمانی منتشر نشده است.'));
  };
  // Repeat on weekdays (Saturday first, as in the Iranian week) for a number of weeks.
  const WEEKDAYS = [[6, 'شنبه'], [0, 'یکشنبه'], [1, 'دوشنبه'], [2, 'سه‌شنبه'], [3, 'چهارشنبه'], [4, 'پنجشنبه'], [5, 'جمعه']];
  const repeat = h('select', {}, [[0, 'فقط همین روز'], [1, 'تا ۱ هفته'], [2, 'تا ۲ هفته'], [4, 'تا ۴ هفته'], [8, 'تا ۸ هفته']].map(([v, l]) => h('option', { value: v }, l)));
  const dayBoxes = WEEKDAYS.map(([d]) => h('input', { type: 'checkbox', value: d }));
  const daysRow = h('div', { class: 'row', style: 'gap:4px 14px;flex-wrap:wrap' }, WEEKDAYS.map(([, l], i) => h('label', { class: 'row', style: 'gap:4px' }, dayBoxes[i], l)));
  const weekdayOf = (key) => new Date(`${key}T12:00:00Z`).getUTCDay();
  // The days to publish: the chosen date, plus the ticked weekdays in the following weeks.
  const targetDays = () => {
    const weeks = Number(repeat.value);
    if (!weeks) return [date.value];
    const want = new Set(dayBoxes.filter((b) => b.checked).map((b) => Number(b.value)));
    want.add(weekdayOf(date.value));
    const out = [];
    for (let i = 0; i < weeks * 7; i++) {
      const k = new Date(Date.parse(`${date.value}T12:00:00Z`) + i * 864e5).toISOString().slice(0, 10);
      if (want.has(weekdayOf(k))) out.push(k);
    }
    return out;
  };
  // Live preview: how many visits the range makes, and at what times.
  const preview = h('div', { class: 'banner info small' });
  const slotTimes = () => {
    const [fh, fm] = from.value.split(':').map(Number);
    const [th, tm] = to.value.split(':').map(Number);
    const total = (th * 60 + tm) - (fh * 60 + fm);
    const d = Number(dur.value);
    const n = total > 0 ? Math.floor(total / d) : 0;
    return { total, d, n, times: Array.from({ length: n }, (_, i) => { const m = fh * 60 + fm + i * d; return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`; }), rest: total > 0 ? total % d : 0 };
  };
  const showPreview = () => {
    daysRow.style.display = Number(repeat.value) ? '' : 'none';
    const p = slotTimes();
    if (p.total <= 0) { preview.className = 'banner warn small'; preview.textContent = 'ساعت پایان باید بعد از ساعت شروع باشد.'; return; }
    const days = targetDays().length;
    preview.className = `banner ${p.n ? 'info' : 'warn'} small`;
    preview.replaceChildren(
      h('b', {}, `${fa(Math.floor(p.total / 60))} ساعت${p.total % 60 ? ` و ${fa(p.total % 60)} دقیقه` : ''} ÷ ${fa(p.d)} دقیقه = ${fa(p.n)} نوبت در روز`),
      days > 1 ? ` × ${fa(days)} روز = ${fa(p.n * days)} نوبت` : '',
      p.rest ? ` (${fa(p.rest)} دقیقه آخر کمتر از یک نوبت است و استفاده نمی‌شود)` : '',
      p.n ? h('div', { class: 'muted', style: 'margin-top:4px' }, 'ساعت نوبت‌ها: ', p.times.map(fa).join('، ')) : null,
    );
  };
  for (const el of [date, from, to, dur, repeat, ...dayBoxes]) el.addEventListener('change', showPreview);
  const publish = guard(async (e) => {
    e.preventDefault();
    const p = slotTimes();
    if (!p.n) return toast('در این بازه هیچ نوبتی جا نمی‌شود', true);
    const days = targetDays();
    if (days.length > 1 && !confirm(`${fa(p.n * days.length)} نوبت در ${fa(days.length)} روز منتشر شود؟`)) return;
    let created = 0; let skipped = 0;
    for (const d of days) {
      const startIso = toIso(d, from.value);
      if (Date.parse(startIso) < Date.now()) continue; // past part of today
      const r = await api('POST', '/v1/doctors/me/slots', { starts_at: startIso, ends_at: toIso(d, to.value), duration_min: Number(dur.value) });
      created += r.created; skipped += r.skipped_overlapping;
    }
    toast(`${fa(created)} نوبت منتشر شد${skipped ? ` (${fa(skipped)} مورد با نوبت‌های قبلی تداخل داشت و رد شد)` : ''}`);
    load();
  });
  $app.append(h('form', { class: 'card stack', onsubmit: publish }, h('h2', {}, 'انتشار تقویم'),
    h('div', { class: 'grid2' }, h('div', {}, h('label', {}, 'تاریخ'), date), h('div', {}, h('label', {}, 'مدت هر نوبت'), dur),
      h('div', {}, h('label', {}, 'از ساعت (تهران)'), from), h('div', {}, h('label', {}, 'تا ساعت'), to),
      h('div', {}, h('label', {}, 'تکرار'), repeat)),
    daysRow,
    preview,
    h('div', {}, h('button', { class: 'btn primary' }, 'انتشار'))),
  h('div', { class: 'card' }, h('h2', {}, 'زمان‌های من'), list));
  await load();
  showPreview();
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
  $app.append(await V2.cxrStats().catch(() => h('div')));
};

VIEWS.audit = async () => {
  const r = await api('GET', '/v1/admin/audit');
  $app.append(h('div', { class: 'card' }, h('h2', {}, 'لاگ ممیزی (append-only)'),
    h('div', { style: 'overflow-x:auto' }, h('table', {}, h('thead', {}, h('tr', {}, ['زمان', 'عمل', 'منبع', 'trace_id', 'جزئیات'].map((x) => h('th', {}, x)))),
      h('tbody', {}, r.items.map((a) => h('tr', {}, h('td', {}, fmt.short(a.ts)), h('td', { class: 'ltr' }, a.action), h('td', { class: 'ltr' }, a.resource),
        h('td', { class: 'ltr' }, (a.trace_id || '').slice(0, 10)), h('td', { class: 'ltr' }, a.detail ? JSON.stringify(a.detail).slice(0, 160) : ''))))))));
};

VIEWS['staff-create'] = async () => {
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

// Views from the second requirements document (doctor onboarding, admin review, tariffs, payments, records).
const V2 = { VIEWS, h, api, toast, fa, fmt, route, guard, onCleanup, every, apiUrl, IS_NATIVE, formatJalaliDate, $app, getSession: () => session, setSession, renderChrome };
installV2(V2);
// Login history moved off the bar: a link at the end of the profile pages.
for (const name of ['profile', 'doctor-profile']) {
  const view = VIEWS[name];
  VIEWS[name] = async (...args) => {
    await view(...args);
    if (current.view !== name) return;
    $app.append(h('div', { class: 'card row' }, h('span', { class: 'svc-ic tone-navy' }, icon('history', 24)),
      h('div', { class: 'grow' }, h('b', {}, 'امنیت حساب'), h('div', { class: 'muted' }, 'سابقه ورودهای شما با تاریخ، دستگاه و نشانی اینترنتی')),
      h('button', { class: 'btn small', onclick: () => route('my-activity') }, 'سابقه ورود')));
  };
}
// Book a slot from a doctor's profile page.
V2.bookSlot = (slot) => {
  const channel = h('select', {}, Object.entries(LABELS.channel).map(([k, v]) => h('option', { value: k }, v)));
  const key = crypto.randomUUID();
  const box = h('div', { class: 'wizard-overlay', role: 'dialog', 'aria-modal': 'true' }, h('div', { class: 'card pay-box stack' },
    h('h2', {}, 'رزرو نوبت'), h('p', {}, h('b', {}, slot.doctor_name), ' — ', fmt.dt(slot.starts_at)),
    h('label', {}, 'نوع ویزیت'), channel,
    h('div', { class: 'row' },
      h('button', { class: 'btn primary', onclick: guard(async () => {
        const a = await api('POST', '/v1/appointments', { doctor_id: slot.doctor_id, slot_id: slot.id, channel: channel.value }, { 'Idempotency-Key': key });
        box.remove();
        route('appointments');
        if (a.status === 'pending' && a.payment) V2.pay(a.payment.id, { title: 'پرداخت هزینه ویزیت', onPaid: () => route('appointments') });
        else toast('نوبت شما ثبت شد ✅');
      }) }, 'تأیید و رزرو'),
      h('button', { class: 'btn', onclick: () => box.remove() }, 'انصراف'))));
  document.body.append(box);
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
  // Doctor approval and staff permissions can change while away: refresh before drawing tabs.
  const me = await api('GET', '/v1/auth/me').catch(() => null);
  if (me) setSession({ ...session, user: { ...session.user, doctor_status: me.doctor_status, full_name: me.full_name, permissions: me.permissions, staff_role: me.staff_role } });
  route(view && VIEWS[view] && !['login', 'server'].includes(view) ? view : 'home', arg);
})();
