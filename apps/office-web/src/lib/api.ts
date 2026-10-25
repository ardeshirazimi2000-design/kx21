/** Thin fetch wrapper with access-token refresh. Tokens live in localStorage (per-browser session). */

const KEY = 'oa.session';

export interface Session {
  accessToken: string;
  refreshToken: string;
}

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public details?: unknown,
  ) {
    super(message);
  }
}

export function getSession(): Session | null {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? (JSON.parse(raw) as Session) : null;
  } catch {
    return null;
  }
}

export function setSession(s: Session | null) {
  try {
    if (s) localStorage.setItem(KEY, JSON.stringify(s));
    else localStorage.removeItem(KEY);
  } catch {
    /* storage unavailable */
  }
  listeners.forEach((l) => l(s));
}

const listeners = new Set<(s: Session | null) => void>();
export function onSessionChange(l: (s: Session | null) => void) {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
}

let refreshing: Promise<boolean> | null = null;

async function refresh(): Promise<boolean> {
  const s = getSession();
  if (!s) return false;
  refreshing ??= fetch('/api/auth/refresh', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ refreshToken: s.refreshToken }),
  })
    .then(async (r) => {
      if (!r.ok) {
        setSession(null);
        return false;
      }
      setSession(await r.json());
      return true;
    })
    .finally(() => {
      refreshing = null;
    });
  return refreshing;
}

export async function api<T = any>(path: string, init: RequestInit & { json?: unknown } = {}, retry = true): Promise<T> {
  const headers = new Headers(init.headers);
  const s = getSession();
  if (s) headers.set('authorization', `Bearer ${s.accessToken}`);
  let body = init.body;
  if (init.json !== undefined) {
    headers.set('content-type', 'application/json');
    body = JSON.stringify(init.json);
  }
  let res: Response;
  try {
    res = await fetch(`/api${path}`, { ...init, headers, body });
  } catch {
    throw new ApiError(0, 'network', 'اتصال به سرور برقرار نشد؛ اتصال شبکه یا آدرس سامانه را بررسی کنید');
  }
  if (res.status === 401 && retry && s && !path.startsWith('/auth/login')) {
    if (await refresh()) return api<T>(path, init, false);
  }
  if (res.status === 204) return undefined as T;
  const ct = res.headers.get('content-type') ?? '';
  const data = ct.includes('application/json') ? await res.json() : await res.text();
  if (!res.ok) {
    const e = (data as any)?.error;
    const fallback = [502, 503, 504].includes(res.status) ? 'سرویس اتوماسیون اداری در دسترس نیست' : 'خطا در ارتباط با سرور';
    throw new ApiError(res.status, e?.code ?? 'error', e?.message ?? `${fallback} (کد ${res.status})`, e?.details);
  }
  return data as T;
}

export const get = <T = any>(p: string) => api<T>(p);
export const post = <T = any>(p: string, json: unknown = {}) => api<T>(p, { method: 'POST', json });
export const patch = <T = any>(p: string, json: unknown = {}) => api<T>(p, { method: 'PATCH', json });
export const del = <T = any>(p: string, json: unknown = {}) => api<T>(p, { method: 'DELETE', json });

/** Authenticated download (CSV, documents, .ics) */
export async function download(path: string, fallbackName: string) {
  const s = getSession();
  const res = await fetch(`/api${path}`, { headers: s ? { authorization: `Bearer ${s.accessToken}` } : {} });
  if (res.status === 401 && (await refresh())) return download(path, fallbackName);
  if (!res.ok) throw new ApiError(res.status, 'download_failed', 'دریافت فایل ممکن نشد');
  const blob = await res.blob();
  const cd = res.headers.get('content-disposition') ?? '';
  const m = cd.match(/filename\*=UTF-8''([^;]+)/) ?? cd.match(/filename="([^"]+)"/);
  const name = m ? decodeURIComponent(m[1]) : fallbackName;
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** Multipart upload (letter attachments, archive documents). */
export async function upload<T = any>(path: string, fields: Record<string, string | null | undefined>, file?: File | null) {
  const fd = new FormData();
  Object.entries(fields).forEach(([k, v]) => v !== null && v !== undefined && v !== '' && fd.append(k, v));
  if (file) fd.append('file', file);
  return api<T>(path, { method: 'POST', body: fd });
}

export const put = <T = any>(p: string, json: unknown = {}) => api<T>(p, { method: 'PUT', json });

/** Opens a protected file (inline) in a new tab. */
export async function openFile(path: string) {
  const s = getSession();
  const res = await fetch(`/api${path}`, { headers: s ? { authorization: `Bearer ${s.accessToken}` } : {} });
  if (res.status === 401 && (await refresh())) return openFile(path);
  if (!res.ok) throw new ApiError(res.status, 'download_failed', 'دریافت فایل ممکن نشد');
  const url = URL.createObjectURL(await res.blob());
  window.open(url, '_blank', 'noopener');
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

/** Object URL of an authenticated file (images shown inline); the caller revokes it. */
export async function blobUrl(path: string): Promise<string> {
  const s = getSession();
  const res = await fetch(`/api${path}`, { headers: s ? { authorization: `Bearer ${s.accessToken}` } : {} });
  if (res.status === 401 && (await refresh())) return blobUrl(path);
  if (!res.ok) throw new ApiError(res.status, 'download_failed', 'دریافت فایل ممکن نشد');
  return URL.createObjectURL(await res.blob());
}

/** Authenticated SVG/text fetch (barcode, QR). */
export async function fetchText(path: string): Promise<string> {
  const s = getSession();
  const res = await fetch(`/api${path}`, { headers: s ? { authorization: `Bearer ${s.accessToken}` } : {} });
  if (res.status === 401 && (await refresh())) return fetchText(path);
  if (!res.ok) throw new ApiError(res.status, 'error', 'دریافت ممکن نشد');
  return res.text();
}
