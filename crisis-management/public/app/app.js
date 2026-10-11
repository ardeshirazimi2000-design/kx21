import { apiClient, clear, faDate, formData, h, LABELS, storage } from '/shared/dom.js';

const store = storage('local', 'cm.app.');
const api = apiClient({ base: '/api/app', refreshPath: '/api/app/auth/refresh', store });
const root = document.getElementById('root');

function deviceId() {
  let id = store.get('deviceId');
  if (!id) {
    id = (crypto.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`).replace(/[^A-Za-z0-9-]/g, '');
    store.set('deviceId', id);
  }
  return id;
}

async function post(url, body) {
  const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(data?.error?.message || 'خطا'), { code: data?.error?.code, details: data?.error?.details });
  return data;
}

function errorText(e) {
  return e.message + (Array.isArray(e.details) ? ` — ${e.details.map((d) => d.message).join('، ')}` : '');
}

function header(title, right) {
  return h('div', { class: 'top' }, h('div', { class: 'grow' }, title), right);
}

function steps(n) {
  return h('div', { class: 'steps', 'aria-hidden': 'true' }, [1, 2, 3].map((i) => h('span', { class: i <= n ? 'on' : '' })));
}

// ── Step 1: national code + mobile. Initial sign-in goes through Shahkar; later sign-ins straight to OTP. ──
function startView() {
  const err = h('div', { class: 'error', role: 'alert' });
  const form = h('form', {},
    h('label', { for: 'nc' }, 'کد ملی'),
    h('input', { id: 'nc', name: 'nationalCode', class: 'ltr', inputmode: 'numeric', maxlength: 10, value: store.get('nationalCode') ?? '', required: true }),
    h('label', { for: 'mb' }, 'شماره موبایل (به نام خودتان)'),
    h('input', { id: 'mb', name: 'mobile', class: 'ltr', inputmode: 'tel', placeholder: '09xxxxxxxxx', value: store.get('mobile') ?? '', required: true }),
    h('p', { class: 'muted small' }, 'در ورود اولیه، تطابق کد ملی و شماره موبایل از سامانه شاهکار استعلام می‌شود و سپس کد تأیید پیامک می‌شود. در ورودهای بعدی فقط کد تأیید (OTP) لازم است.'),
    h('button', { class: 'btn primary', type: 'submit' }, 'دریافت کد تأیید'), err);
  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    err.textContent = '';
    const btn = form.querySelector('button');
    btn.disabled = true;
    try {
      const d = formData(form);
      const r = await post('/api/app/auth/start', { ...d, deviceId: deviceId() });
      store.set('nationalCode', d.nationalCode);
      store.set('mobile', d.mobile);
      otpView(r);
    } catch (e) {
      err.textContent = errorText(e);
    } finally {
      btn.disabled = false;
    }
  });
  clear(root, header('مدیریت بحران شهری'), h('div', { class: 'page' }, steps(1), h('div', { class: 'card' }, h('h2', {}, 'ورود / ثبت‌نام'), form)));
}

// ── Step 2: OTP (and name, for a new citizen) ──
function otpView(ch, needProfile = false) {
  const err = h('div', { class: 'error', role: 'alert' });
  const form = h('form', {},
    ch.shahkarVerified ? h('p', { class: 'okmsg' }, '✓ مالکیت شماره موبایل از طریق سامانه شاهکار تأیید شد.') : null,
    h('p', {}, 'کد تأیید به ', h('span', { dir: 'ltr' }, ch.mobileMasked), ' پیامک شد.'),
    h('input', { name: 'code', class: 'otp', inputmode: 'numeric', autocomplete: 'one-time-code', maxlength: 8, required: true, 'aria-label': 'کد تأیید' }),
    needProfile ? h('div', {}, h('label', {}, 'نام'), h('input', { name: 'firstName', required: true }), h('label', {}, 'نام خانوادگی'), h('input', { name: 'lastName', required: true })) : null,
    h('div', { class: 'row' }, h('button', { class: 'btn primary grow', type: 'submit' }, needProfile ? 'تکمیل ثبت‌نام' : 'ورود'), h('button', { class: 'btn link', type: 'button', onclick: startView }, 'ویرایش شماره')),
    err);
  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    err.textContent = '';
    const d = formData(form);
    try {
      const t = await post('/api/app/auth/verify', { challengeId: ch.challengeId, deviceId: deviceId(), deviceName: navigator.userAgent.slice(0, 90), ...d });
      store.set('accessToken', t.accessToken);
      store.set('refreshToken', t.refreshToken);
      home();
    } catch (e) {
      if (e.code === 'profile_required') {
        otpView(ch, true);
        root.querySelector('input[name=code]').value = d.code;
        return;
      }
      err.textContent = errorText(e);
    }
  });
  clear(root, header('تأیید شماره'), h('div', { class: 'page' }, steps(2), h('div', { class: 'card' }, form)));
  form.querySelector('input').focus();
}

// ── Signed in ──
let me = null;
let tab = 'alerts';

async function home() {
  try {
    me = await api.get('/me');
  } catch {
    store.clear();
    return startView();
  }
  render();
}

function render() {
  const can = (p) => me.permissions.includes(p);
  const tabs = [
    ['alerts', 'هشدارها', can('alerts.read')],
    ['tasks', 'مأموریت‌ها', can('tasks.read')],
    ['report', 'گزارش حادثه', can('incidents.report')],
    ['incidents', 'گزارش‌های من', can('incidents.read') && !can('tasks.read')],
    ['profile', 'حساب', true],
  ].filter((t) => t[2]);
  if (!tabs.find((t) => t[0] === tab)) tab = tabs[0][0];
  const page = h('div', { class: 'page' }, h('p', { class: 'muted' }, 'در حال بارگذاری…'));
  clear(root, header(me.fullName, h('button', { onclick: logout }, 'خروج')), page,
    h('nav', { class: 'tabs' }, tabs.map(([k, label]) => h('button', { class: k === tab ? 'on' : '', onclick: () => { tab = k; render(); } }, label))));
  const views = { alerts: alertsView, tasks: tasksView, report: reportView, incidents: incidentsView, profile: profileView };
  views[tab](page).catch((e) => clear(page, h('p', { class: 'error' }, errorText(e))));
}

async function logout() {
  try { await fetch('/api/app/auth/logout', { method: 'POST', headers: { Authorization: `Bearer ${store.get('accessToken')}` } }); } catch { /* ignore */ }
  store.clear();
  startView();
}

async function alertsView(page) {
  const rows = await api.get('/alerts');
  clear(page, rows.length ? rows.map((a) => h('div', { class: 'card' },
    h('span', { class: `chip ${a.level === 'danger' ? 'danger' : a.level === 'warning' ? 'warn' : ''}` }, LABELS.level[a.level]),
    h('strong', {}, ` ${a.title}`), h('p', {}, a.body), h('div', { class: 'muted small' }, `${a.district_name ?? 'کل شهر'} — ${faDate(a.published_at)}`)))
    : h('p', { class: 'muted' }, 'هشدار فعالی وجود ندارد.'));
}

const NEXT = { assigned: ['accepted', 'پذیرش'], accepted: ['en_route', 'در مسیرم'], en_route: ['on_site', 'رسیدم'], on_site: ['done', 'پایان مأموریت'] };

async function tasksView(page) {
  const rows = await api.get('/tasks');
  clear(page, rows.length ? rows.map((t) => {
    const err = h('div', { class: 'error' });
    const next = NEXT[t.status];
    return h('div', { class: 'card task' },
      h('strong', {}, t.title), h('div', {}, h('span', { class: 'chip' }, LABELS.task[t.status]), h('span', { class: `chip ${t.severity >= 3 ? 'danger' : ''}` }, `سطح ${t.severity}`)),
      h('p', {}, `${LABELS.type[t.incident_type] ?? ''}: ${t.incident_title}`), t.address ? h('p', { class: 'muted small' }, t.address) : null,
      next ? h('div', { class: 'row' }, h('button', { class: 'btn primary', onclick: async () => {
        try { await api.patch(`/tasks/${t.id}/status`, { status: next[0] }); render(); } catch (e) { err.textContent = errorText(e); }
      } }, next[1])) : null, err);
  }) : h('p', { class: 'muted' }, 'مأموریتی به شما تخصیص داده نشده است.'));
}

async function reportView(page) {
  const err = h('div', { class: 'error' });
  const ok = h('div', { class: 'okmsg' });
  const form = h('form', { class: 'card' },
    h('label', {}, 'عنوان'), h('input', { name: 'title', required: true }),
    h('label', {}, 'نوع حادثه'), h('select', { name: 'type' }, Object.entries(LABELS.type).map(([k, v]) => h('option', { value: k }, v))),
    h('label', {}, 'نشانی'), h('input', { name: 'address' }),
    h('label', {}, 'شرح'), h('textarea', { name: 'description', rows: 3 }),
    h('div', { class: 'row' }, h('button', { class: 'btn', type: 'button', onclick: locate }, 'ثبت موقعیت فعلی'), h('span', { class: 'muted small', id: 'loc' })),
    h('button', { class: 'btn primary', type: 'submit' }, 'ارسال گزارش'), ok, err);
  let coords = null;
  function locate() {
    navigator.geolocation?.getCurrentPosition((p) => {
      coords = { lat: p.coords.latitude, lng: p.coords.longitude };
      form.querySelector('#loc').textContent = `${coords.lat.toFixed(4)}, ${coords.lng.toFixed(4)}`;
    }, () => { err.textContent = 'دسترسی به موقعیت مکانی ممکن نشد'; });
  }
  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    err.textContent = ''; ok.textContent = '';
    const d = formData(form);
    try {
      await api.post('/incidents', { title: d.title, type: d.type, address: d.address || undefined, description: d.description || undefined, ...(coords ?? {}) });
      form.reset();
      ok.textContent = 'گزارش ثبت شد و برای بررسی به اتاق عملیات ارسال گردید.';
    } catch (e) {
      err.textContent = errorText(e);
    }
  });
  clear(page, form);
}

async function incidentsView(page) {
  const rows = await api.get('/incidents');
  clear(page, rows.length ? rows.map((i) => h('div', { class: 'card' }, h('strong', {}, i.title), h('div', {}, h('span', { class: 'chip' }, LABELS.status[i.status]), h('span', { class: 'chip' }, LABELS.type[i.type])), h('div', { class: 'muted small' }, faDate(i.created_at))))
    : h('p', { class: 'muted' }, 'گزارشی ثبت نکرده‌اید.'));
}

async function profileView(page) {
  const sessions = await api.get('/me/sessions');
  clear(page,
    h('div', { class: 'card' }, h('h2', {}, me.fullName), h('p', {}, me.roles.map((r) => h('span', { class: 'chip' }, r.title))),
      h('p', { class: 'muted small' }, `کد ملی: ${me.national_code} — موبایل: ${me.mobile}`),
      h('p', { class: 'muted small' }, `آخرین احراز شاهکار: ${faDate(me.shahkar_verified_at)}`)),
    h('div', { class: 'card' }, h('h2', {}, 'دستگاه‌ها و نشست‌ها'), sessions.map((s) => h('div', { class: 'row' },
      h('span', { class: 'grow small' }, `${s.channel === 'app' ? 'اپ' : 'کنسول'} — ${faDate(s.last_seen_at)}`),
      s.current ? h('span', { class: 'chip ok' }, 'این دستگاه') : h('button', { class: 'btn link', onclick: async () => { await api.del(`/me/sessions/${s.id}`); render(); } }, 'خروج از این نشست')))));
}

if (store.get('refreshToken')) home();
else startView();
