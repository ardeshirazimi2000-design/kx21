// Minimal DOM helpers. Text is always set via textContent (no innerHTML with data) to prevent XSS.
export function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'class') el.className = v;
    else if (v === true) el.setAttribute(k, '');
    else el.setAttribute(k, String(v));
  }
  for (const c of children.flat()) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

export function clear(el, ...children) {
  el.replaceChildren(...children.flat().filter(Boolean));
  return el;
}

export function formData(form) {
  return Object.fromEntries(new FormData(form).entries());
}

const fmt = new Intl.DateTimeFormat('fa-IR', { dateStyle: 'short', timeStyle: 'short' });
export function faDate(v) {
  return v ? fmt.format(new Date(v)) : '—';
}

/** JSON API client with bearer token and one transparent refresh on 401. */
export function apiClient({ base, refreshPath, store }) {
  async function refresh() {
    const rt = store.get('refreshToken');
    if (!rt) return false;
    const r = await fetch(refreshPath, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ refreshToken: rt }) });
    if (!r.ok) {
      store.clear();
      return false;
    }
    const t = await r.json();
    store.set('accessToken', t.accessToken);
    store.set('refreshToken', t.refreshToken);
    return true;
  }
  async function call(method, path, body, retry = true) {
    const headers = { 'Content-Type': 'application/json' };
    const at = store.get('accessToken');
    if (at) headers.Authorization = `Bearer ${at}`;
    const r = await fetch(base + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    if (r.status === 401 && retry && store.get('refreshToken') && (await refresh())) return call(method, path, body, false);
    if (r.status === 204) return null;
    const data = await r.json().catch(() => ({}));
    if (!r.ok) {
      const err = new Error(data?.error?.message || `خطا (${r.status})`);
      err.status = r.status;
      err.code = data?.error?.code;
      err.details = data?.error?.details;
      throw err;
    }
    return data;
  }
  return {
    get: (p) => call('GET', p),
    post: (p, b) => call('POST', p, b ?? {}),
    put: (p, b) => call('PUT', p, b),
    patch: (p, b) => call('PATCH', p, b),
    del: (p) => call('DELETE', p),
  };
}

/** `keep`: keys that survive clear() (e.g. the app's enrolled-device secret). */
export function storage(kind, prefix, keep = []) {
  const s = kind === 'local' ? window.localStorage : window.sessionStorage;
  return {
    get: (k) => { try { return s.getItem(prefix + k); } catch { return null; } },
    set: (k, v) => { try { s.setItem(prefix + k, v); } catch { /* ignore */ } },
    // FDP_RIP.2: on sign-out remove everything this page stored, except the keys named in `keep`.
    clear: () => {
      try {
        for (const k of Object.keys(s)) if (k.startsWith(prefix) && !keep.includes(k.slice(prefix.length))) s.removeItem(k);
      } catch { /* ignore */ }
    },
  };
}

export const LABELS = {
  status: { reported: 'گزارش‌شده', verified: 'تأییدشده', active: 'بحران فعال', contained: 'مهارشده', closed: 'خاتمه‌یافته', rejected: 'رد شده' },
  task: { assigned: 'تخصیص‌یافته', accepted: 'پذیرفته', en_route: 'در مسیر', on_site: 'در محل', done: 'انجام شد', cancelled: 'لغو' },
  type: { fire: 'آتش‌سوزی', flood: 'سیلاب/آبگرفتگی', earthquake: 'زلزله', building_collapse: 'ریزش ساختمان', gas_leak: 'نشت گاز', storm: 'طوفان', accident: 'حادثه ترافیکی', other: 'سایر' },
  scope: { city: 'کل شهر', district: 'منطقه', own: 'شخصی' },
  userStatus: { active: 'فعال', suspended: 'تعلیق', disabled: 'غیرفعال' },
  level: { info: 'اطلاع‌رسانی', warning: 'هشدار', danger: 'خطر' },
};
