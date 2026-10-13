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

export function createIdentityService(config, fetchImpl = globalThis.fetch) {
  const mock = !config.sapiToken && config.devMode;

  async function verifyMobileOwnership({ nationalId, mobile }) {
    if (!isValidNationalId(nationalId)) return { matched: false, source: 'checksum' };
    if (mock) return { matched: true, source: 'mock' };
    if (!config.sapiToken) {
      throw new ApiError(503, 'identity_service_unavailable', 'سرویس استعلام شاهکار پیکربندی نشده است؛ ثبت‌نام موقتاً ممکن نیست');
    }
    let res;
    try {
      res = await fetchImpl(`${config.sapiBase.replace(/\/$/, '')}/Shahkar`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.sapiToken}` },
        body: JSON.stringify({ nationalCode: nationalId, mobile, isCompany: false }),
        signal: AbortSignal.timeout(15000),
      });
    } catch (e) {
      console.error('[shahkar] request failed:', e.message);
      throw new ApiError(503, 'identity_service_unavailable', 'سرویس استعلام شاهکار در دسترس نیست؛ کمی بعد دوباره تلاش کنید');
    }
    const body = await res.json().catch(() => null);
    if (!res.ok) {
      console.error('[shahkar] HTTP', res.status, JSON.stringify(body)?.slice(0, 300));
      throw new ApiError(503, 'identity_service_unavailable', 'خطا در استعلام شاهکار؛ کمی بعد دوباره تلاش کنید');
    }
    const verdict = readVerdict(body);
    if (verdict === undefined) {
      // Unknown response shape: never guess "match". Log the shape (values masked) for setup.
      const shape = JSON.stringify(body, (k, v) => (typeof v === 'string' ? '…' : v))?.slice(0, 400);
      console.error('[shahkar] unrecognised response shape:', shape);
      throw new ApiError(503, 'identity_service_unavailable', 'پاسخ سرویس شاهکار قابل تفسیر نبود');
    }
    return { matched: verdict, source: 'shahkar' };
  }

  // Optional: name / birth date from the national registry (configure IDENTITY_INQUIRY_URL).
  async function inquireIdentity({ nationalId, birthDate }) {
    if (!config.identityInquiryUrl || !config.sapiToken) return null;
    try {
      const res = await fetchImpl(config.identityInquiryUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.sapiToken}` },
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
