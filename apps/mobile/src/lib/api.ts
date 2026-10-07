import * as SecureStore from 'expo-secure-store';
import { Platform } from 'react-native';
import { getApiUrl } from './config';

export interface Session {
  accessToken: string;
  refreshToken: string;
}

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
  }
}

const KEY = 'kx.session';
let session: Session | null = null;
const listeners = new Set<(s: Session | null) => void>();

// SecureStore is unavailable on web; fall back to memory there.
const storage = {
  get: () => (Platform.OS === 'web' ? Promise.resolve(null) : SecureStore.getItemAsync(KEY)),
  set: (v: string) => (Platform.OS === 'web' ? Promise.resolve() : SecureStore.setItemAsync(KEY, v)),
  del: () => (Platform.OS === 'web' ? Promise.resolve() : SecureStore.deleteItemAsync(KEY)),
};

export async function loadSession(): Promise<Session | null> {
  try {
    const raw = await storage.get();
    session = raw ? (JSON.parse(raw) as Session) : null;
  } catch {
    session = null;
  }
  return session;
}

export function getSession() {
  return session;
}

export async function setSession(s: Session | null) {
  session = s;
  try {
    if (s) await storage.set(JSON.stringify(s));
    else await storage.del();
  } catch {
    /* keep in memory */
  }
  listeners.forEach((l) => l(s));
}

export function onSessionChange(l: (s: Session | null) => void) {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
}

let refreshing: Promise<boolean> | null = null;
async function refresh(): Promise<boolean> {
  if (!session) return false;
  const rt = session.refreshToken;
  refreshing ??= fetch(`${getApiUrl()}/api/auth/refresh`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ refreshToken: rt }),
  })
    .then(async (r) => {
      if (!r.ok) {
        await setSession(null);
        return false;
      }
      await setSession(await r.json());
      return true;
    })
    .catch(() => false)
    .finally(() => {
      refreshing = null;
    });
  return refreshing;
}

export async function api<T = any>(path: string, init: { method?: string; json?: unknown } = {}, retry = true): Promise<T> {
  const headers: Record<string, string> = { accept: 'application/json' };
  if (session) headers.authorization = `Bearer ${session.accessToken}`;
  if (init.json !== undefined) headers['content-type'] = 'application/json';
  let res: Response;
  try {
    res = await fetch(`${getApiUrl()}/api${path}`, {
      method: init.method ?? 'GET',
      headers,
      body: init.json !== undefined ? JSON.stringify(init.json) : undefined,
    });
  } catch {
    throw new ApiError(0, 'network', 'ارتباط با سرور برقرار نشد؛ اتصال اینترنت را بررسی کنید');
  }
  if (res.status === 401 && retry && session && !path.startsWith('/auth/login')) {
    if (await refresh()) return api<T>(path, init, false);
  }
  if (res.status === 204) return undefined as T;
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    throw new ApiError(res.status, data?.error?.code ?? 'error', data?.error?.message ?? 'خطا در ارتباط با سرور');
  }
  return data as T;
}

export const get = <T = any>(p: string) => api<T>(p);

/** Multipart upload of a local file (camera photo, gallery image, picked PDF/PowerPoint) to /documents. */
export async function uploadFile(fields: Record<string, string>, file: { uri: string; name: string; type: string }, retry = true): Promise<any> {
  const fd = new FormData();
  Object.entries(fields).forEach(([k, v]) => fd.append(k, v));
  fd.append('file', file as any);
  const headers: Record<string, string> = { accept: 'application/json' };
  if (session) headers.authorization = `Bearer ${session.accessToken}`;
  let res: Response;
  try {
    res = await fetch(`${getApiUrl()}/api/documents`, { method: 'POST', headers, body: fd });
  } catch {
    throw new ApiError(0, 'network', 'ارسال فایل ممکن نشد؛ اتصال اینترنت را بررسی کنید');
  }
  if (res.status === 401 && retry && session && (await refresh())) return uploadFile(fields, file, false);
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new ApiError(res.status, data?.error?.code ?? 'error', data?.error?.message ?? 'ارسال فایل ناموفق بود');
  return data;
}
export const post = <T = any>(p: string, json: unknown = {}) => api<T>(p, { method: 'POST', json });
export const patch = <T = any>(p: string, json: unknown = {}) => api<T>(p, { method: 'PATCH', json });
