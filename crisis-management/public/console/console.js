import { apiClient, clear, faDate, formData, h, LABELS, storage } from '/shared/dom.js';

const store = storage('session', 'cm.console.');
const api = apiClient({ base: '/api/console', refreshPath: '/api/console/auth/refresh', store });
const root = document.getElementById('root');

let me = null;
let districts = [];
const can = (p) => !!me?.permissions.includes(p);

function brand() {
  return h('div', { class: 'brand' }, h('div', { class: 'logo' }, 'ب'), h('div', {}, 'سامانه مدیریت بحران شهری', h('div', { class: 'muted small' }, 'کنسول مدیریت')));
}

function errorBox() {
  return h('div', { class: 'error', role: 'alert' });
}

async function guarded(errEl, fn) {
  errEl.textContent = '';
  try {
    await fn();
  } catch (e) {
    errEl.textContent = e.message + (e.details && Array.isArray(e.details) ? ` — ${e.details.map((d) => d.message || d).join('، ')}` : '');
  }
}

// ───────── Sign-in: password → OTP → (password change) ─────────

function loginView() {
  const err = errorBox();
  const form = h('form', {},
    h('label', { for: 'u' }, 'نام کاربری'), h('input', { id: 'u', name: 'username', autocomplete: 'username', class: 'ltr', required: true }),
    h('label', { for: 'p' }, 'رمز عبور'), h('input', { id: 'p', name: 'password', type: 'password', autocomplete: 'current-password', class: 'ltr', required: true }),
    h('div', { class: 'row' }, h('button', { class: 'btn primary grow', type: 'submit' }, 'ادامه')), err);
  form.addEventListener('submit', (ev) => {
    ev.preventDefault();
    guarded(err, async () => {
      const r = await fetchJson('/api/console/auth/login', formData(form));
      otpView(r);
    });
  });
  clear(root, h('div', { class: 'center' }, h('div', { class: 'card' }, brand(), h('p', { class: 'muted small' }, 'ورود دومرحله‌ای: رمز عبور + کد یکبارمصرف پیامکی به موبایل احراز‌شده با شاهکار'), form)));
}

async function fetchJson(url, body) {
  const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(data?.error?.message || 'خطا'), { code: data?.error?.code });
  return data;
}

function otpView(ch) {
  const err = errorBox();
  const form = h('form', {},
    h('p', {}, 'کد یکبارمصرف به شماره ', h('span', { dir: 'ltr' }, ch.mobileMasked), ` ارسال شد (اعتبار ${ch.expiresIn} ثانیه).`),
    h('input', { name: 'code', class: 'otp', inputmode: 'numeric', autocomplete: 'one-time-code', maxlength: 8, required: true, 'aria-label': 'کد تأیید' }),
    h('div', { class: 'row' }, h('button', { class: 'btn primary grow', type: 'submit' }, 'ورود'), h('button', { class: 'btn link', type: 'button', onclick: loginView }, 'بازگشت')), err);
  form.addEventListener('submit', (ev) => {
    ev.preventDefault();
    guarded(err, async () => {
      const t = await fetchJson('/api/console/auth/verify', { challengeId: ch.challengeId, code: formData(form).code });
      store.set('accessToken', t.accessToken);
      store.set('refreshToken', t.refreshToken);
      await boot();
    });
  });
  clear(root, h('div', { class: 'center' }, h('div', { class: 'card' }, brand(), form)));
  form.querySelector('input').focus();
}

function changePasswordForm(onDone, forced) {
  const err = errorBox();
  const form = h('form', {},
    forced ? h('p', { class: 'chip warn' }, 'رمز عبور شما موقت یا منقضی است و باید تغییر کند.') : null,
    h('label', {}, 'رمز فعلی'), h('input', { name: 'currentPassword', type: 'password', class: 'ltr', autocomplete: 'current-password', required: true }),
    h('label', {}, 'رمز جدید'), h('input', { name: 'newPassword', type: 'password', class: 'ltr', autocomplete: 'new-password', required: true }),
    h('p', { class: 'muted small' }, 'حداقل ۱۲ کاراکتر شامل حروف بزرگ و کوچک لاتین، رقم و نماد؛ متفاوت با ۵ رمز قبلی.'),
    h('button', { class: 'btn primary', type: 'submit' }, 'تغییر رمز'), err);
  form.addEventListener('submit', (ev) => {
    ev.preventDefault();
    guarded(err, async () => {
      await api.post('/auth/change-password', formData(form));
      onDone();
    });
  });
  return form;
}

// Change-password route lives under /api/console/auth, outside the authenticated router.
api.post = ((orig) => (p, b) => (p.startsWith('/auth/') ? authedPost('/api/console' + p, b) : orig(p, b)))(api.post);
async function authedPost(url, body) {
  const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${store.get('accessToken')}` }, body: JSON.stringify(body) });
  if (r.status === 204) return null;
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(data?.error?.message || 'خطا'), { details: data?.error?.details });
  return data;
}

async function logout() {
  try { await authedPost('/api/console/auth/logout', {}); } catch { /* ignore */ }
  store.clear();
  loginView();
}

// ───────── Shell ─────────

const PAGES = [
  { key: 'dashboard', title: 'داشبورد', perm: 'reports.read', render: dashboardPage },
  { key: 'incidents', title: 'حوادث و مأموریت‌ها', perm: 'incidents.read', render: incidentsPage },
  { key: 'alerts', title: 'هشدارها', perm: 'alerts.read', render: alertsPage },
  { key: 'users', title: 'کاربران', perm: 'users.read', render: usersPage },
  { key: 'roles', title: 'نقش‌ها و دسترسی‌ها', perm: 'roles.read', render: rolesPage },
  { key: 'shahkar', title: 'شاهکار', perm: ['shahkar.inquire', 'shahkar.log.read'], render: shahkarPage },
  { key: 'audit', title: 'رخدادهای امنیتی', perm: 'audit.read', render: auditPage },
  { key: 'policy', title: 'خط‌مشی امنیتی', perm: 'settings.read', render: policyPage },
  { key: 'account', title: 'حساب من', perm: null, render: accountPage },
];

let current = null;
const main = h('main', { class: 'main' });

function shell() {
  const visible = PAGES.filter((p) => !p.perm || [].concat(p.perm).some(can));
  const nav = h('nav', { 'aria-label': 'منو' }, visible.map((p) => h('button', { class: p.key === current ? 'on' : '', onclick: () => go(p.key) }, p.title)));
  clear(root, h('div', { class: 'layout' },
    h('aside', { class: 'side' }, brand(), nav,
      h('div', { class: 'who' }, h('div', {}, me.fullName), h('div', { class: 'muted small' }, me.roles.map((r) => r.title).join('، ')),
        h('button', { class: 'btn link', onclick: logout }, 'خروج'))),
    main));
  return visible;
}

function go(key) {
  current = key;
  const visible = shell();
  const page = visible.find((p) => p.key === key) ?? visible[0];
  current = page.key;
  shell();
  clear(main, h('p', { class: 'muted' }, 'در حال بارگذاری…'));
  page.render().catch((e) => clear(main, h('div', { class: 'error' }, e.message)));
}

async function boot() {
  if (!store.get('accessToken')) return loginView();
  try {
    me = await api.get('/me');
  } catch {
    store.clear();
    return loginView();
  }
  if (me.passwordChangeRequired) {
    return clear(root, h('div', { class: 'center' }, h('div', { class: 'card' }, brand(), h('h2', {}, 'تغییر رمز عبور'), changePasswordForm(boot, true))));
  }
  districts = await api.get('/security/districts');
  go(current ?? (can('reports.read') ? 'dashboard' : PAGES.find((p) => !p.perm || [].concat(p.perm).some(can)).key));
}

function modal(title, body) {
  const close = () => wrap.remove();
  const wrap = h('div', { class: 'dialog', onclick: (e) => e.target === wrap && close() },
    h('div', { class: 'card', role: 'dialog', 'aria-label': title }, h('div', { class: 'row' }, h('h2', { class: 'grow' }, title), h('button', { class: 'btn link', onclick: close }, 'بستن')), body));
  document.body.append(wrap);
  return close;
}

function districtSelect(name, value, allowEmpty = true) {
  return h('select', { name }, allowEmpty ? h('option', { value: '' }, '—') : null,
    districts.map((d) => h('option', { value: d.id, selected: String(d.id) === String(value ?? '') }, d.name)));
}

// ───────── Dashboard ─────────

async function dashboardPage() {
  const s = await api.get('/reports/summary');
  const count = (st) => s.byStatus.find((x) => x.status === st)?.count ?? 0;
  clear(main, h('h1', {}, 'داشبورد عملیات'),
    h('div', { class: 'grid2' },
      ['reported', 'verified', 'active', 'contained'].map((st) => h('div', { class: 'card' }, h('div', { class: 'muted' }, LABELS.status[st]), h('div', { class: 'stat' }, count(st).toLocaleString('fa-IR')))),
      h('div', { class: 'card' }, h('div', { class: 'muted' }, 'مأموریت‌های باز'), h('div', { class: 'stat' }, s.openTasks.toLocaleString('fa-IR')))),
    h('div', { class: 'card' }, h('h2', {}, 'حوادث جاری بر اساس سطح'),
      s.bySeverity.length ? s.bySeverity.map((b) => h('span', { class: `chip ${b.severity >= 3 ? 'danger' : ''}` }, `سطح ${b.severity}: ${b.count}`)) : h('span', { class: 'muted' }, 'حادثه جاری وجود ندارد')));
}

// ───────── Incidents ─────────

async function incidentsPage() {
  const rows = await api.get('/incidents');
  const err = errorBox();
  const createBtn = can('incidents.create') ? h('button', { class: 'btn primary', onclick: () => incidentForm() }, 'ثبت حادثه') : null;
  clear(main, h('div', { class: 'row' }, h('h1', { class: 'grow' }, 'حوادث'), createBtn), err,
    h('div', { class: 'card tablewrap' }, h('table', {},
      h('thead', {}, h('tr', {}, ['عنوان', 'نوع', 'سطح', 'وضعیت', 'منطقه', 'مأموریت', 'زمان', ''].map((t) => h('th', {}, t)))),
      h('tbody', {}, rows.map((i) => h('tr', {},
        h('td', {}, i.title), h('td', {}, LABELS.type[i.type] ?? i.type), h('td', {}, h('span', { class: `chip ${i.severity >= 3 ? 'danger' : ''}` }, i.severity)),
        h('td', {}, LABELS.status[i.status]), h('td', {}, i.district_name ?? '—'), h('td', {}, i.task_count), h('td', { class: 'small' }, faDate(i.created_at)),
        h('td', {}, h('button', { class: 'btn link', onclick: () => incidentDetail(i.id) }, 'جزئیات'))))))));
}

function incidentForm() {
  const err = errorBox();
  const form = h('form', {},
    h('label', {}, 'عنوان'), h('input', { name: 'title', required: true }),
    h('div', { class: 'grid2' },
      h('div', {}, h('label', {}, 'نوع'), h('select', { name: 'type' }, Object.entries(LABELS.type).map(([k, v]) => h('option', { value: k }, v)))),
      h('div', {}, h('label', {}, 'سطح'), h('select', { name: 'severity' }, [1, 2, 3, 4].filter((s) => s < 3 || can('incidents.declare')).map((s) => h('option', { value: s }, s)))),
      h('div', {}, h('label', {}, 'منطقه'), districtSelect('districtId', me.district_id, false))),
    h('label', {}, 'نشانی'), h('input', { name: 'address' }),
    h('label', {}, 'شرح'), h('textarea', { name: 'description', rows: 3 }),
    h('button', { class: 'btn primary', type: 'submit' }, 'ثبت'), err);
  const close = modal('ثبت حادثه', form);
  form.addEventListener('submit', (ev) => {
    ev.preventDefault();
    guarded(err, async () => {
      const d = formData(form);
      await api.post('/incidents', { title: d.title, type: d.type, severity: Number(d.severity), districtId: d.districtId ? Number(d.districtId) : null, address: d.address || undefined, description: d.description || undefined });
      close();
      go('incidents');
    });
  });
}

async function incidentDetail(id) {
  const i = await api.get(`/incidents/${id}`);
  const err = errorBox();
  const actions = h('div', { class: 'row' });
  if (can('incidents.update') && i.status === 'reported') actions.append(h('button', { class: 'btn', onclick: () => act(() => api.patch(`/incidents/${id}`, { status: 'verified' })) }, 'تأیید گزارش'), h('button', { class: 'btn', onclick: () => act(() => api.patch(`/incidents/${id}`, { status: 'rejected' })) }, 'رد گزارش'));
  if (can('incidents.declare') && ['reported', 'verified', 'active'].includes(i.status)) {
    const sev = h('select', {}, [1, 2, 3, 4].map((s) => h('option', { value: s, selected: s === i.severity }, `سطح ${s}`)));
    actions.append(sev, h('button', { class: 'btn primary', onclick: () => act(() => api.post(`/incidents/${id}/declare`, { severity: Number(sev.value) })) }, 'اعلام وضعیت بحران'));
  }
  if (can('incidents.close') && !['closed', 'rejected'].includes(i.status)) {
    actions.append(h('button', { class: 'btn', onclick: () => act(() => api.post(`/incidents/${id}/close`, { status: 'contained' })) }, 'مهار شد'),
      h('button', { class: 'btn', onclick: () => act(() => api.post(`/incidents/${id}/close`, { status: 'closed' })) }, 'خاتمه'));
  }
  let assign = null;
  if (can('tasks.assign') && ['verified', 'active', 'contained'].includes(i.status)) {
    const responders = await api.get('/responders');
    const f = h('form', { class: 'row' }, h('input', { name: 'title', placeholder: 'شرح مأموریت', class: 'grow', required: true }),
      h('select', { name: 'assigneeId', required: true }, h('option', { value: '' }, 'انتخاب نیرو…'), responders.map((r) => h('option', { value: r.id }, `${r.name} (${r.open_tasks} باز)`))),
      h('button', { class: 'btn primary', type: 'submit' }, 'تخصیص'));
    f.addEventListener('submit', (ev) => { ev.preventDefault(); act(() => api.post(`/incidents/${id}/tasks`, formData(f))); });
    assign = h('div', {}, h('h2', {}, 'تخصیص مأموریت'), f);
  }
  const body = h('div', {},
    h('p', {}, h('span', { class: 'chip' }, LABELS.type[i.type]), h('span', { class: 'chip' }, LABELS.status[i.status]), h('span', { class: `chip ${i.severity >= 3 ? 'danger' : ''}` }, `سطح ${i.severity}`), h('span', { class: 'chip' }, i.district_name ?? 'بدون منطقه')),
    i.address ? h('p', {}, i.address) : null, i.description ? h('p', { class: 'muted' }, i.description) : null,
    actions, err,
    h('h2', {}, 'مأموریت‌ها'),
    i.tasks.length ? h('table', {}, h('tbody', {}, i.tasks.map((t) => h('tr', {}, h('td', {}, t.title), h('td', {}, t.assignee_name), h('td', {}, LABELS.task[t.status]))))) : h('p', { class: 'muted' }, 'مأموریتی ثبت نشده است'),
    assign);
  const close = modal(i.title, body);
  function act(fn) {
    guarded(err, async () => { await fn(); close(); await incidentsPage(); incidentDetail(id); });
  }
}

// ───────── Alerts ─────────

async function alertsPage() {
  const rows = await api.get('/alerts');
  const err = errorBox();
  let form = null;
  if (can('alerts.publish')) {
    form = h('form', { class: 'card' }, h('h2', {}, 'انتشار هشدار'),
      h('div', { class: 'grid2' }, h('div', {}, h('label', {}, 'عنوان'), h('input', { name: 'title', required: true })),
        h('div', {}, h('label', {}, 'سطح'), h('select', { name: 'level' }, Object.entries(LABELS.level).filter(([k]) => k !== 'danger' || can('incidents.declare')).map(([k, v]) => h('option', { value: k }, v)))),
        h('div', {}, h('label', {}, 'منطقه (خالی = کل شهر)'), districtSelect('districtId'))),
      h('label', {}, 'متن'), h('textarea', { name: 'body', rows: 2, required: true }), h('button', { class: 'btn primary', type: 'submit' }, 'انتشار'), err);
    form.addEventListener('submit', (ev) => {
      ev.preventDefault();
      guarded(err, async () => { const d = formData(form); await api.post('/alerts', { ...d, districtId: d.districtId ? Number(d.districtId) : null }); go('alerts'); });
    });
  }
  clear(main, h('h1', {}, 'هشدارها'), form,
    h('div', { class: 'card' }, rows.length ? rows.map((a) => h('div', {}, h('span', { class: `chip ${a.level === 'danger' ? 'danger' : a.level === 'warning' ? 'warn' : ''}` }, LABELS.level[a.level]), h('strong', {}, ` ${a.title} `), h('span', { class: 'muted small' }, `${a.district_name ?? 'کل شهر'} — ${faDate(a.published_at)}`), h('p', {}, a.body))) : h('p', { class: 'muted' }, 'هشداری منتشر نشده است')));
}

// ───────── Users ─────────

let rolesCache = null;
async function roles() {
  rolesCache ??= await api.get('/roles');
  return rolesCache;
}

async function usersPage(q = '') {
  const rows = await api.get(`/users${q ? `?q=${encodeURIComponent(q)}` : ''}`);
  const search = h('input', { placeholder: 'جستجو: نام، نام کاربری، کد ملی یا موبایل', value: q, class: 'grow' });
  search.addEventListener('keydown', (e) => e.key === 'Enter' && usersPage(search.value.trim()));
  clear(main, h('div', { class: 'row' }, h('h1', { class: 'grow' }, 'کاربران'), can('users.create') ? h('button', { class: 'btn primary', onclick: userCreateForm }, 'تعریف کاربر جدید') : null),
    h('div', { class: 'card' }, h('div', { class: 'row' }, search, h('button', { class: 'btn', onclick: () => usersPage(search.value.trim()) }, 'جستجو'))),
    h('div', { class: 'card tablewrap' }, h('table', {},
      h('thead', {}, h('tr', {}, ['نام', 'کد ملی', 'موبایل', 'نوع', 'نقش‌ها', 'وضعیت', 'شاهکار', ''].map((t) => h('th', {}, t)))),
      h('tbody', {}, rows.map((u) => h('tr', {},
        h('td', {}, `${u.first_name} ${u.last_name}`, u.username ? h('div', { class: 'muted small ltr' }, u.username) : null),
        h('td', { class: 'ltr' }, u.national_code), h('td', { class: 'ltr' }, u.mobile), h('td', {}, u.kind === 'staff' ? 'کارمند' : 'شهروند'),
        h('td', {}, u.roles.map((r) => h('span', { class: 'chip' }, r.title))),
        h('td', {}, h('span', { class: `chip ${u.status === 'active' ? 'ok' : 'danger'}` }, LABELS.userStatus[u.status]), u.locked ? h('span', { class: 'chip warn' }, 'قفل') : null),
        h('td', { class: 'small' }, u.shahkar_verified_at ? h('span', { class: 'chip ok' }, `✓ ${faDate(u.shahkar_verified_at)}`) : h('span', { class: 'chip warn' }, 'احراز نشده')),
        h('td', {}, h('button', { class: 'btn link', onclick: () => userDetail(u.id) }, 'مدیریت'))))))));
}

function roleChecks(all, selected, kind) {
  return h('div', { class: 'checks' }, all.roles.filter((r) => kind === 'staff' || !r.staff_only).map((r) =>
    h('label', {}, h('input', { type: 'checkbox', name: 'role', value: r.key, checked: selected.includes(r.key) }), r.title, r.locked ? h('span', { class: 'chip warn' }, 'امنیتی') : null)));
}

async function userCreateForm() {
  const all = await roles();
  const err = errorBox();
  const consoleBox = h('input', { type: 'checkbox', name: 'consoleAccess' });
  const form = h('form', {},
    h('p', { class: 'muted small' }, 'پیش از ثبت، تطابق کد ملی و شماره موبایل از سامانه شاهکار استعلام می‌شود. بدون تطابق، کاربر ایجاد نمی‌شود.'),
    h('div', { class: 'grid2' },
      h('div', {}, h('label', {}, 'کد ملی'), h('input', { name: 'nationalCode', class: 'ltr', inputmode: 'numeric', maxlength: 10, required: true })),
      h('div', {}, h('label', {}, 'شماره موبایل'), h('input', { name: 'mobile', class: 'ltr', inputmode: 'tel', placeholder: '09xxxxxxxxx', required: true })),
      h('div', {}, h('label', {}, 'نام'), h('input', { name: 'firstName', required: true })),
      h('div', {}, h('label', {}, 'نام خانوادگی'), h('input', { name: 'lastName', required: true })),
      h('div', {}, h('label', {}, 'دستگاه / سازمان'), h('input', { name: 'organization' })),
      h('div', {}, h('label', {}, 'سمت'), h('input', { name: 'positionTitle' })),
      h('div', {}, h('label', {}, 'منطقه'), districtSelect('districtId')),
      h('div', {}, h('label', {}, 'نام کاربری کنسول'), h('input', { name: 'username', class: 'ltr', autocomplete: 'off' }))),
    h('div', { class: 'checks' },
      h('label', {}, consoleBox, 'دسترسی کنسول (رمز + OTP)'),
      h('label', {}, h('input', { type: 'checkbox', name: 'appAccess', checked: true }), 'دسترسی اپلیکیشن (شاهکار + OTP)')),
    can('users.assign_roles') ? h('div', {}, h('h2', {}, 'نقش‌ها'), roleChecks(all, [], 'staff')) : null,
    h('div', { class: 'row' }, h('button', { class: 'btn primary', type: 'submit' }, 'استعلام شاهکار و ثبت')), err);
  const close = modal('تعریف کاربر', form);
  form.addEventListener('submit', (ev) => {
    ev.preventDefault();
    guarded(err, async () => {
      const d = formData(form);
      const body = {
        nationalCode: d.nationalCode, mobile: d.mobile, firstName: d.firstName, lastName: d.lastName,
        organization: d.organization || undefined, positionTitle: d.positionTitle || undefined,
        districtId: d.districtId ? Number(d.districtId) : null, username: d.username || undefined,
        consoleAccess: !!d.consoleAccess, appAccess: !!d.appAccess,
        roles: [...form.querySelectorAll('input[name=role]:checked')].map((c) => ({ key: c.value })),
      };
      const r = await api.post('/users', body);
      close();
      showTempPassword(r.temporaryPassword, 'کاربر پس از تطابق شاهکار ایجاد شد.');
      usersPage();
    });
  });
}

function showTempPassword(pw, msg) {
  modal('نتیجه', h('div', {}, h('p', { class: 'okmsg' }, msg), pw ? h('div', {}, h('p', {}, 'رمز موقت (فقط یک‌بار نمایش داده می‌شود؛ به‌صورت امن به کاربر تحویل دهید):'), h('p', { class: 'ltr chip' }, pw)) : null));
}

async function userDetail(id) {
  const [u, all] = await Promise.all([api.get(`/users/${id}`), roles()]);
  const err = errorBox();
  const sections = [];
  sections.push(h('p', {},
    h('span', { class: 'chip' }, u.kind === 'staff' ? 'کارمند' : 'شهروند'), h('span', { class: 'chip ltr' }, u.national_code), h('span', { class: 'chip ltr' }, u.mobile),
    h('span', { class: `chip ${u.status === 'active' ? 'ok' : 'danger'}` }, LABELS.userStatus[u.status]),
    h('span', { class: 'chip' }, `شاهکار: ${faDate(u.shahkar_verified_at)}`), h('span', { class: 'chip' }, `ثبت در اپ: ${faDate(u.app_enrolled_at)}`), h('span', { class: 'chip' }, `آخرین ورود: ${faDate(u.last_login_at)}`)));

  if (can('users.assign_roles') && u.id !== me.id) {
    const rf = h('form', {}, h('h2', {}, 'نقش‌ها'), roleChecks(all, u.roles.map((r) => r.key), u.kind), h('button', { class: 'btn primary', type: 'submit' }, 'ذخیره نقش‌ها'));
    rf.addEventListener('submit', (ev) => {
      ev.preventDefault();
      act(() => api.put(`/users/${id}/roles`, { roles: [...rf.querySelectorAll('input[name=role]:checked')].map((c) => ({ key: c.value })) }));
    });
    sections.push(rf);
  }
  if (can('users.update')) {
    const ef = h('form', {}, h('h2', {}, 'ویرایش'),
      h('div', { class: 'grid2' },
        h('div', {}, h('label', {}, 'موبایل (تغییر = استعلام مجدد شاهکار)'), h('input', { name: 'mobile', class: 'ltr', value: u.mobile })),
        h('div', {}, h('label', {}, 'سمت'), h('input', { name: 'positionTitle', value: u.position_title ?? '' })),
        h('div', {}, h('label', {}, 'منطقه'), districtSelect('districtId', u.district_id)),
        h('div', {}, h('label', {}, 'نام کاربری'), h('input', { name: 'username', class: 'ltr', value: u.username ?? '' }))),
      h('div', { class: 'checks' },
        h('label', {}, h('input', { type: 'checkbox', name: 'consoleAccess', checked: u.console_access }), 'دسترسی کنسول'),
        h('label', {}, h('input', { type: 'checkbox', name: 'appAccess', checked: u.app_access }), 'دسترسی اپلیکیشن')),
      h('button', { class: 'btn primary', type: 'submit' }, 'ذخیره'));
    ef.addEventListener('submit', (ev) => {
      ev.preventDefault();
      const d = formData(ef);
      act(async () => {
        const r = await api.patch(`/users/${id}`, {
          mobile: d.mobile !== u.mobile ? d.mobile : undefined, positionTitle: d.positionTitle || null,
          districtId: d.districtId ? Number(d.districtId) : null, username: d.username || undefined,
          consoleAccess: !!d.consoleAccess, appAccess: !!d.appAccess,
        });
        if (r.temporaryPassword) showTempPassword(r.temporaryPassword, 'دسترسی کنسول فعال شد.');
      });
    });
    sections.push(ef);
  }
  const ops = h('div', { class: 'row' });
  if (can('users.status') && u.id !== me.id) {
    const reason = h('input', { placeholder: 'دلیل (الزامی)', class: 'grow' });
    for (const st of ['active', 'suspended', 'disabled'].filter((s) => s !== u.status)) {
      ops.append(h('button', { class: 'btn', onclick: () => act(() => api.post(`/users/${id}/status`, { status: st, reason: reason.value })) }, `تغییر به «${LABELS.userStatus[st]}»`));
    }
    ops.prepend(reason);
    if (u.locked) ops.append(h('button', { class: 'btn', onclick: () => act(() => api.post(`/users/${id}/unlock`)) }, 'بازگشایی قفل'));
    if (u.console_access) ops.append(h('button', { class: 'btn', onclick: () => act(async () => showTempPassword((await api.post(`/users/${id}/reset-password`)).temporaryPassword, 'رمز بازنشانی شد.')) }, 'بازنشانی رمز'));
  }
  if (can('shahkar.inquire')) ops.append(h('button', { class: 'btn', onclick: () => act(async () => { const r = await api.post(`/users/${id}/shahkar`); showTempPassword(null, r.matched ? 'تطابق شاهکار تأیید شد.' : 'عدم تطابق شاهکار — حساب تعلیق شد.'); }) }, 'استعلام مجدد شاهکار'));
  sections.push(h('div', {}, h('h2', {}, 'عملیات'), ops));

  if (can('sessions.manage')) {
    const sessions = await api.get(`/users/${id}/sessions`);
    sections.push(h('div', {}, h('div', { class: 'row' }, h('h2', { class: 'grow' }, 'نشست‌ها'), h('button', { class: 'btn', onclick: () => act(() => api.del(`/users/${id}/sessions`)) }, 'ابطال همه')),
      h('div', { class: 'tablewrap' }, h('table', {}, h('tbody', {}, sessions.map((s) => h('tr', {},
        h('td', {}, s.channel === 'console' ? 'کنسول' : 'اپ'), h('td', { class: 'small' }, s.device_name ?? s.user_agent ?? ''), h('td', { class: 'small ltr' }, s.ip ?? ''),
        h('td', { class: 'small' }, faDate(s.last_seen_at)),
        h('td', {}, s.revoked_at ? h('span', { class: 'chip' }, `باطل: ${s.revoked_reason}`) : h('button', { class: 'btn link', onclick: () => act(() => api.del(`/users/${id}/sessions/${s.id}`)) }, 'ابطال')))))))));
  }
  const close = modal(`${u.first_name} ${u.last_name}`, h('div', {}, ...sections, err));
  function act(fn) {
    guarded(err, async () => { await fn(); close(); usersPage(); userDetail(id); });
  }
}

// ───────── Roles & access matrix ─────────

async function rolesPage() {
  rolesCache = null;
  const all = await roles();
  const err = errorBox();
  const groups = { access: 'کانال دسترسی', identity: 'کاربران و هویت', security: 'امنیت و ممیزی', operations: 'عملیات بحران' };
  const matrix = h('table', { class: 'matrix' },
    h('thead', {}, h('tr', {}, h('th', {}, 'مجوز'), all.roles.map((r) => h('th', { title: r.description ?? '' }, r.title, h('div', { class: 'muted small' }, LABELS.scope[r.scope]))))),
    h('tbody', {}, Object.entries(groups).flatMap(([g, title]) => [
      h('tr', {}, h('th', { colspan: all.roles.length + 1 }, title)),
      ...all.permissions.filter((p) => p.group === g).map((p) => h('tr', {}, h('td', {}, p.title, h('div', { class: 'muted small ltr' }, p.key)),
        all.roles.map((r) => h('td', {}, r.permissions.includes(p.key) ? '●' : '')))),
    ])));
  clear(main, h('div', { class: 'row' }, h('h1', { class: 'grow' }, 'نقش‌ها و ماتریس دسترسی'), can('roles.manage') ? h('button', { class: 'btn primary', onclick: () => roleForm(all) }, 'تعریف نقش') : null), err,
    h('div', { class: 'card' }, h('p', { class: 'muted small' }, 'تفکیک وظایف: ', all.mutuallyExclusive.map(([a, b]) => h('span', { class: 'chip' }, `${title(all, a)} ⟂ ${title(all, b)}`)))),
    h('div', { class: 'card tablewrap' }, matrix),
    h('div', { class: 'card' }, h('h2', {}, 'فهرست نقش‌ها'), h('table', {}, h('tbody', {}, all.roles.map((r) => h('tr', {},
      h('td', {}, r.title, r.locked ? h('span', { class: 'chip warn' }, 'قفل') : null, r.builtin ? null : h('span', { class: 'chip' }, 'سفارشی')),
      h('td', { class: 'muted small' }, r.description ?? ''), h('td', {}, LABELS.scope[r.scope]), h('td', {}, `${r.holders} کاربر`),
      h('td', {}, can('roles.manage') && !r.locked ? h('button', { class: 'btn link', onclick: () => roleForm(all, r) }, 'ویرایش') : null,
        can('roles.manage') && !r.builtin ? h('button', { class: 'btn link', onclick: () => guarded(err, async () => { await api.del(`/roles/${r.key}`); rolesPage(); }) }, 'حذف') : null)))))));
}

function title(all, key) {
  return all.roles.find((r) => r.key === key)?.title ?? key;
}

function roleForm(all, role) {
  const err = errorBox();
  const form = h('form', {},
    h('div', { class: 'grid2' },
      role ? null : h('div', {}, h('label', {}, 'کلید (لاتین)'), h('input', { name: 'key', class: 'ltr', required: true })),
      h('div', {}, h('label', {}, 'عنوان'), h('input', { name: 'title', value: role?.title ?? '', required: true })),
      h('div', {}, h('label', {}, 'دامنه داده'), h('select', { name: 'scope' }, Object.entries(LABELS.scope).map(([k, v]) => h('option', { value: k, selected: role?.scope === k }, v))))),
    h('label', {}, 'توضیح'), h('input', { name: 'description', value: role?.description ?? '' }),
    h('div', { class: 'checks' }, h('label', {}, h('input', { type: 'checkbox', name: 'staffOnly', checked: role ? role.staff_only : true, disabled: role?.builtin }), 'فقط کارکنان')),
    h('h2', {}, 'مجوزها'),
    h('p', { class: 'muted small' }, 'مجوزهای مدیریت کاربران و ممیزی فقط در نقش‌های امنیتی قفل‌شده مجازند.'),
    h('div', { class: 'checks' }, all.permissions.filter((p) => !p.reserved).map((p) => h('label', {}, h('input', { type: 'checkbox', name: 'perm', value: p.key, checked: role?.permissions.includes(p.key) }), p.title))),
    h('button', { class: 'btn primary', type: 'submit' }, 'ذخیره'), err);
  const close = modal(role ? `ویرایش نقش «${role.title}»` : 'تعریف نقش', form);
  form.addEventListener('submit', (ev) => {
    ev.preventDefault();
    guarded(err, async () => {
      const d = formData(form);
      const body = { title: d.title, description: d.description || null, scope: d.scope, staffOnly: role?.builtin ? role.staff_only : !!d.staffOnly, permissions: [...form.querySelectorAll('input[name=perm]:checked')].map((c) => c.value) };
      if (role) await api.put(`/roles/${role.key}`, body);
      else await api.post('/roles', { ...body, key: d.key });
      close();
      rolesPage();
    });
  });
}

// ───────── Shahkar ─────────

async function shahkarPage() {
  const parts = [h('h1', {}, 'احراز هویت شاهکار')];
  if (can('shahkar.inquire')) {
    const err = errorBox();
    const result = h('div');
    const form = h('form', { class: 'card' }, h('h2', {}, 'استعلام تطابق کد ملی و شماره موبایل'),
      h('div', { class: 'grid2' },
        h('div', {}, h('label', {}, 'کد ملی'), h('input', { name: 'nationalCode', class: 'ltr', required: true })),
        h('div', {}, h('label', {}, 'شماره موبایل'), h('input', { name: 'mobile', class: 'ltr', required: true })),
        h('div', {}, h('label', {}, 'هدف استعلام (ثبت در لاگ)'), h('input', { name: 'purpose', required: true }))),
      h('button', { class: 'btn primary', type: 'submit' }, 'استعلام'), result, err);
    form.addEventListener('submit', (ev) => {
      ev.preventDefault();
      guarded(err, async () => {
        const r = await api.post('/security/shahkar/inquiry', formData(form));
        clear(result, h('p', { class: r.matched ? 'okmsg' : 'error' }, r.matched ? '✓ شماره موبایل متعلق به صاحب کد ملی است.' : '✗ عدم تطابق: شماره به نام این کد ملی ثبت نشده است.'));
      });
    });
    parts.push(form);
  }
  if (can('shahkar.log.read')) {
    const log = await api.get('/security/shahkar/inquiries');
    const ctx = { console_user_create: 'تعریف کاربر', console_user_update: 'تغییر موبایل', console_manual: 'استعلام دستی', console_reverify: 'استعلام مجدد', console_login: 'ورود کنسول', app_enroll: 'ورود اولیه اپ', app_signup: 'ثبت‌نام شهروند' };
    parts.push(h('div', { class: 'card tablewrap' }, h('h2', {}, 'سوابق استعلام'), h('table', {},
      h('thead', {}, h('tr', {}, ['زمان', 'زمینه', 'کد ملی', 'موبایل', 'نتیجه', 'کاربر', 'درخواست‌کننده'].map((t) => h('th', {}, t)))),
      h('tbody', {}, log.map((l) => h('tr', {},
        h('td', { class: 'small' }, faDate(l.created_at)), h('td', {}, ctx[l.context] ?? l.context), h('td', { class: 'ltr' }, l.national_code_masked), h('td', { class: 'ltr' }, l.mobile_masked),
        h('td', {}, !l.success ? h('span', { class: 'chip warn' }, 'خطای سرویس') : l.matched ? h('span', { class: 'chip ok' }, 'تطابق') : h('span', { class: 'chip danger' }, 'عدم تطابق')),
        h('td', {}, l.user_name ?? '—'), h('td', {}, l.requested_by_name ?? 'خودِ کاربر')))))));
  }
  clear(main, ...parts);
}

// ───────── Audit / policy / account ─────────

async function auditPage(filter = {}) {
  const qs = new URLSearchParams(Object.entries(filter).filter(([, v]) => v)).toString();
  const rows = await api.get(`/security/audit${qs ? `?${qs}` : ''}`);
  const f = h('form', { class: 'card row' },
    h('input', { name: 'action', placeholder: 'رویداد (مثلاً user. یا console.login)', class: 'grow ltr', value: filter.action ?? '' }),
    h('select', { name: 'outcome' }, h('option', { value: '' }, 'همه نتایج'), ['success', 'failure', 'denied'].map((o) => h('option', { value: o, selected: filter.outcome === o }, o))),
    h('button', { class: 'btn', type: 'submit' }, 'فیلتر'));
  f.addEventListener('submit', (ev) => { ev.preventDefault(); auditPage(formData(f)); });
  clear(main, h('h1', {}, 'رخدادهای امنیتی (لاگ ممیزی تغییرناپذیر)'), f,
    h('div', { class: 'card tablewrap' }, h('table', {},
      h('thead', {}, h('tr', {}, ['زمان', 'کاربر', 'رویداد', 'نتیجه', 'هدف', 'IP', 'کانال', 'جزئیات'].map((t) => h('th', {}, t)))),
      h('tbody', {}, rows.map((a) => h('tr', {},
        h('td', { class: 'small' }, faDate(a.at)), h('td', {}, a.actor_name ?? '—'), h('td', { class: 'ltr' }, a.action),
        h('td', {}, h('span', { class: `chip ${a.outcome === 'success' ? 'ok' : 'danger'}` }, a.outcome)),
        h('td', { class: 'small ltr' }, a.target_type ? `${a.target_type}:${String(a.target_id).slice(0, 8)}` : ''), h('td', { class: 'small ltr' }, a.ip ?? ''), h('td', {}, a.channel ?? ''),
        h('td', { class: 'small ltr' }, JSON.stringify(a.details))))))));
}

async function policyPage() {
  const s = await api.get('/security/settings');
  const row = (k, v) => h('tr', {}, h('td', {}, k), h('td', { class: 'ltr' }, String(v)));
  clear(main, h('h1', {}, 'خط‌مشی امنیتی اعمال‌شده'),
    h('div', { class: 'card' }, h('table', {}, h('tbody', {},
      row('حداقل طول رمز', s.password.minLength), row('عمر رمز (روز)', s.password.maxAgeDays), row('تاریخچه رمز', s.password.history), row('پیچیدگی', s.password.complexity),
      row('قفل پس از تلاش ناموفق', s.lockout.maxFailures), row('مدت قفل (دقیقه)', s.lockout.minutes),
      row('طول OTP', s.otp.length), row('اعتبار OTP (ثانیه)', s.otp.ttlSec), row('حداکثر تلاش OTP', s.otp.maxAttempts), row('فاصله ارسال مجدد (ثانیه)', s.otp.resendCooldownSec), row('سقف ارسال در ساعت', s.otp.maxPerHour),
      row('عمر توکن دسترسی (ثانیه)', s.sessions.accessTtlSec), row('عمر نشست کنسول (ثانیه)', s.sessions.consoleRefreshTtlSec), row('خروج خودکار کنسول در عدم فعالیت (ثانیه)', s.sessions.consoleIdleTimeoutSec), row('عمر نشست اپ (ثانیه)', s.sessions.appRefreshTtlSec),
      row('درگاه شاهکار', `${s.shahkar.mode} / ${s.shahkar.endpoint}`), row('استعلام مجدد شاهکار (روز)', s.shahkar.reverifyDays), row('شاهکار در دستگاه جدید', s.shahkar.onNewDevice ? 'بله' : 'خیر'),
      row('ثبت‌نام شهروند از اپ', s.app.citizenSignup ? 'فعال' : 'غیرفعال')))));
}

async function accountPage() {
  const sessions = await api.get('/me/sessions');
  const err = errorBox();
  clear(main, h('h1', {}, 'حساب من'),
    h('div', { class: 'card' }, h('p', {}, me.fullName, ' — ', h('span', { class: 'ltr' }, me.username ?? '')),
      h('p', {}, me.roles.map((r) => h('span', { class: 'chip' }, `${r.title} (${LABELS.scope[r.scope]})`))),
      h('p', { class: 'muted small' }, 'مجوزها: ', me.permissions.join(' · '))),
    h('div', { class: 'card' }, h('h2', {}, 'تغییر رمز عبور'), changePasswordForm(() => { store.clear(); loginView(); }, false)),
    h('div', { class: 'card' }, h('h2', {}, 'نشست‌های فعال'), err, h('table', {}, h('tbody', {}, sessions.map((s) => h('tr', {},
      h('td', {}, s.channel === 'console' ? 'کنسول' : 'اپ'), h('td', { class: 'small' }, s.device_name ?? ''), h('td', { class: 'ltr small' }, s.ip ?? ''), h('td', { class: 'small' }, faDate(s.last_seen_at)),
      h('td', {}, s.current ? h('span', { class: 'chip ok' }, 'نشست جاری') : h('button', { class: 'btn link', onclick: () => guarded(err, async () => { await api.del(`/me/sessions/${s.id}`); accountPage(); }) }, 'ابطال'))))))));
}

boot();
