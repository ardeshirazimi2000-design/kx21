// Identity verification for registration:
//  • Shahkar (via s.api.ir): does this mobile number belong to this national code?
//  • optional identity inquiry (name / birth date from the national registry) — pluggable URL.
// Fails closed in production: if the service is not configured or unreachable, registration
// is refused rather than accepted unverified. In development a mock is used (valid checksum ⇒ match).
import { ApiError } from '../lib/http.js';
import { isValidNationalId } from '../lib/fa.js';
import { toJalali } from '../../public/jalali.js';

// s.api.ir wraps results differently per product; find the verdict. Keys that explicitly mean
// "match" win over generic ones; API-level flags such as isSuccess/status are never a verdict
// (a successful call can still report "not matched").
const VERDICT_KEYS = [/^(is)?match(ed)?$/i, /^(result|isvalid|valid)$/i];

export function readVerdict(body) {
  // s.api.ir Shahkar (sw1): {"data":true|false,"success":true,"code":0,"message":"استعلام انجام شد"}
  // — `data` is the match verdict; `success` only says the inquiry itself ran.
  if (body && typeof body === 'object' && typeof body.data === 'boolean') {
    return body.success === false || (body.code !== undefined && body.code !== 0) ? undefined : body.data;
  }
  const asBool = (v) => (typeof v === 'boolean' ? v : typeof v === 'string' && /^(true|false)$/i.test(v) ? v.toLowerCase() === 'true' : undefined);
  for (const re of VERDICT_KEYS) {
    const stack = [[body, 0]];
    while (stack.length) {
      const [v, depth] = stack.shift();
      if (!v || typeof v !== 'object' || depth > 4) continue;
      for (const [k, val] of Object.entries(v)) {
        if (re.test(k)) { const b = asBool(val); if (b !== undefined) return b; }
        if (val && typeof val === 'object') stack.push([val, depth + 1]);
      }
    }
  }
  return undefined;
}

// Tokens are often pasted with quotes, a trailing newline or the "Bearer " prefix itself.
export const cleanToken = (t) => String(t ?? '').trim().replace(/^["']|["']$/g, '').replace(/^bearer\s+/i, '').trim();

// One raw call to s.api.ir — shared by the service and the server-side diagnostic script.
export const callShahkar = ({ base, token, nationalId, mobile, fetchImpl }) => callSapi({
  url: `${base.replace(/\/$/, '')}/Shahkar`, token, body: { nationalCode: nationalId, mobile, isCompany: false }, fetchImpl,
});

export async function callSapi({ url, token, body: payload, fetchImpl = globalThis.fetch }) {
  const res = await fetchImpl(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json', Accept: 'application/json',
      'User-Agent': 'Mozilla/5.0 (kx21-clinic) curl-compatible', Authorization: `Bearer ${cleanToken(token)}`,
    },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(15000),
  });
  const text = await res.text();
  let body = null;
  try { body = JSON.parse(text); } catch { /* HTML error page from a CDN/WAF */ }
  return { status: res.status, ok: res.ok, body, text };
}

export function createIdentityService(config, fetchImpl = globalThis.fetch) {
  const token = cleanToken(config.sapiToken);
  const mock = !token && config.devMode;

  async function verifyMobileOwnership({ nationalId, mobile }) {
    if (!isValidNationalId(nationalId)) return { matched: false, source: 'checksum' };
    if (mock) return { matched: true, source: 'mock' };
    if (!token) {
      throw new ApiError(503, 'identity_service_unavailable', 'سرویس استعلام شاهکار پیکربندی نشده است؛ ثبت‌نام موقتاً ممکن نیست');
    }
    let r;
    try {
      r = await callShahkar({ base: config.sapiBase, token, nationalId, mobile, fetchImpl });
    } catch (e) {
      console.error('[shahkar] request failed (network/DNS/timeout — is s.api.ir reachable from this server?):', e.cause?.code ?? e.message);
      throw new ApiError(503, 'identity_service_unavailable', 'سرور به سرویس شاهکار (s.api.ir) دسترسی ندارد؛ کمی بعد دوباره تلاش کنید');
    }
    if (!r.ok) {
      console.error('[shahkar] HTTP', r.status, r.text.replace(/\d{10,11}/g, '…').slice(0, 300));
      const why = r.status === 401 || r.status === 403
        ? 'توکن s.api.ir پذیرفته نشد یا IP سرور مجاز نیست'
        : r.status === 429 ? 'سقف درخواست‌های سرویس شاهکار پر شده است' : `پاسخ HTTP ${r.status}`;
      throw new ApiError(503, 'identity_service_unavailable', `خطا در استعلام شاهکار (${why})`);
    }
    const body = r.body;
    const verdict = readVerdict(body);
    if (verdict === undefined) {
      // Unknown response shape: never guess "match". Log the shape (values masked) for setup.
      const shape = JSON.stringify(body, (k, v) => (typeof v === 'string' ? '…' : v))?.slice(0, 400) ?? r.text.slice(0, 200);
      console.error('[shahkar] unrecognised response shape:', shape);
      throw new ApiError(503, 'identity_service_unavailable', 'پاسخ سرویس شاهکار قابل تفسیر نبود');
    }
    return { matched: verdict, source: 'shahkar' };
  }

  // Civil registry (ثبت احوال) via s.api.ir PersonInfo: national code + birth date → name.
  // Returns { found: true, first_name, last_name, full_name, father_name?, gender?, deceased? }
  // or { found: false, message }. Throws 503 when the service cannot be reached or understood.
  const personInfoUrl = config.identityInquiryUrl || `${String(config.sapiBase ?? '').replace(/\/$/, '')}/PersonInfo`;
  async function inquirePerson({ nationalId, dobIso }) {
    const [gy, gm, gd] = String(dobIso).split('-').map(Number);
    const j = toJalali(gy, gm, gd);
    let r;
    try {
      r = await callSapi({ url: personInfoUrl, token, body: { nationalCode: nationalId, birthDate: `${j.jy}/${j.jm}/${j.jd}` }, fetchImpl });
    } catch (e) {
      console.error('[person-info] request failed:', e.cause?.code ?? e.message);
      throw new ApiError(503, 'identity_service_unavailable', 'سرور به سرویس استعلام هویت دسترسی ندارد؛ کمی بعد دوباره تلاش کنید');
    }
    if (!r.ok) {
      console.error('[person-info] HTTP', r.status, r.text.replace(/\d{10,11}/g, '…').slice(0, 300));
      throw new ApiError(503, 'identity_service_unavailable', `خطا در استعلام هویت (HTTP ${r.status})`);
    }
    const p = readPerson(r.body);
    if (p?.error) {
      console.error('[person-info] service error:', p.message);
      throw new ApiError(503, 'identity_service_unavailable', `خطا در استعلام هویت${p.message ? ` (${p.message})` : ''}`);
    }
    if (p === undefined) {
      const shape = JSON.stringify(r.body, (k, v) => (typeof v === 'string' ? '…' : v))?.slice(0, 400) ?? r.text.slice(0, 200);
      console.error('[person-info] unrecognised response shape:', shape);
      throw new ApiError(503, 'identity_service_unavailable', 'پاسخ سرویس استعلام هویت قابل تفسیر نبود');
    }
    return p;
  }

  return {
    verifyMobileOwnership, inquirePerson, mock,
    // Registry check runs whenever a real s.api.ir token is configured.
    personInfoEnabled: !!token,
  };
}

// Tolerant reader for PersonInfo replies ({data:{firstName,lastName,…},success,code,message}).
const FIRST = /^(first_?name|name|fname|esm)$/i;
const LAST = /^(last_?name|family(_?name)?|lname|surname)$/i;
export function readPerson(body) {
  if (!body || typeof body !== 'object') return undefined;
  const failed = body.success === false || (typeof body.code === 'number' && body.code !== 0);
  const data = body.data ?? body.result ?? (failed ? null : body);
  const message = typeof body.message === 'string' ? body.message : null;
  // Request/credential/server errors (e.g. code 400 "data is invalid") are not a "no match".
  if (typeof body.code === 'number' && (body.code === 400 || body.code === 401 || body.code === 403 || body.code === 429 || body.code >= 500)) {
    return { found: false, error: true, message };
  }
  if (failed || data === null || data === false) return { found: false, message };
  if (typeof data !== 'object') return undefined;
  const find = (re) => {
    const stack = [[data, 0]];
    while (stack.length) {
      const [v, depth] = stack.shift();
      for (const [k, val] of Object.entries(v)) {
        if (re.test(k) && typeof val === 'string' && val.trim()) return val.trim();
        if (val && typeof val === 'object' && depth < 3) stack.push([val, depth + 1]);
      }
    }
    return null;
  };
  const first = find(FIRST);
  const last = find(LAST);
  const full = find(/^full_?name$/i) ?? [first, last].filter(Boolean).join(' ');
  if (!full) return undefined;
  const deadVal = Object.entries(data).find(([k]) => /^((is_?)?dead|deceased|is_?death)$/i.test(k))?.[1];
  return {
    found: true, first_name: first, last_name: last, full_name: full,
    father_name: find(/^father_?name$/i), gender: find(/^(gender|sex)$/i),
    deceased: deadVal === true || deadVal === 'true',
  };
}
