// Identity verification for registration:
//  • Shahkar (via s.api.ir): does this mobile number belong to this national code?
//  • optional identity inquiry (name / birth date from the national registry) — pluggable URL.
// Fails closed in production: if the service is not configured or unreachable, registration
// is refused rather than accepted unverified. In development a mock is used (valid checksum ⇒ match).
import { ApiError } from '../lib/http.js';
import { isValidNationalId } from '../lib/fa.js';

// s.api.ir wraps results differently per product; find the verdict. Keys that explicitly mean
// "match" win over generic ones; API-level flags such as isSuccess/status are never a verdict
// (a successful call can still report "not matched").
const VERDICT_KEYS = [/^(is)?match(ed)?$/i, /^(result|isvalid|valid)$/i];

export function readVerdict(body) {
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
export async function callShahkar({ base, token, nationalId, mobile, fetchImpl = globalThis.fetch }) {
  const res = await fetchImpl(`${base.replace(/\/$/, '')}/Shahkar`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json', Accept: 'application/json',
      'User-Agent': 'Mozilla/5.0 (kx21-clinic) curl-compatible', Authorization: `Bearer ${cleanToken(token)}`,
    },
    body: JSON.stringify({ nationalCode: nationalId, mobile, isCompany: false }),
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

  // Optional: name / birth date from the national registry (configure IDENTITY_INQUIRY_URL).
  async function inquireIdentity({ nationalId, birthDate }) {
    if (!config.identityInquiryUrl || !token) return null;
    try {
      const res = await fetchImpl(config.identityInquiryUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ nationalCode: nationalId, birthDate }),
        signal: AbortSignal.timeout(15000),
      });
      if (!res.ok) return null;
      const b = await res.json();
      const d = b?.data ?? b?.result ?? b;
      const first = d?.firstName ?? d?.first_name ?? d?.name;
      const last = d?.lastName ?? d?.last_name ?? d?.family;
      return first || last ? { full_name: [first, last].filter(Boolean).join(' ') } : null;
    } catch {
      return null;
    }
  }

  return { verifyMobileOwnership, inquireIdentity, mock };
}
