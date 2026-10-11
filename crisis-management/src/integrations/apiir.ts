/**
 * api.ir gateway client — Shahkar (national code ↔ mobile owner match) and SMS OTP.
 * Contract taken from the api.ir OpenAPI document (servers: https://s.api.ir, Bearer auth):
 *   POST /api/sw1/Shahkar | ShahkarPro   { nationalCode, mobile, isCompany } → ResultDataOfboolean
 *   POST /api/sw1/ShahkarLite            { nationalCode, mobile }            → ResultDataOfboolean
 *   POST /api/sw1/SmsOTP                 { code, mobile, template }          → ResultDataOfboolean
 *   ResultDataOfboolean = { data: boolean, success: boolean, code: int, message: string|null }
 */
import { config } from '../config.js';
import { logger } from '../lib/logger.js';

export interface ResultDataOfBoolean {
  data?: boolean;
  success: boolean;
  code?: number | string;
  message?: string | null;
}

export interface ShahkarResult {
  /** The provider answered (regardless of match). false = network/provider failure. */
  ok: boolean;
  /** true = mobile is registered to this national code; null when the provider failed. */
  matched: boolean | null;
  endpoint: string;
  code?: string;
  message?: string | null;
  durationMs: number;
}

export interface SmsResult {
  ok: boolean;
  code?: string;
  message?: string | null;
}

export interface ApiIrClient {
  shahkar(nationalCode: string, mobile: string, isCompany?: boolean): Promise<ShahkarResult>;
  sendOtp(mobile: string, code: string): Promise<SmsResult>;
  /** Service SMS (SendSms) — used for security notifications to administrators. */
  sendSms(mobiles: string[], message: string): Promise<SmsResult>;
}

async function post(path: string, body: unknown): Promise<ResultDataOfBoolean> {
  const res = await fetch(new URL(path, config.APIIR_BASE_URL), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      Authorization: `Bearer ${config.APIIR_TOKEN}`,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(config.APIIR_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`api.ir HTTP ${res.status}`);
  return (await res.json()) as ResultDataOfBoolean;
}

export const liveClient: ApiIrClient = {
  async shahkar(nationalCode, mobile, isCompany = false) {
    const endpoint = config.APIIR_SHAHKAR_ENDPOINT;
    const body = endpoint === 'ShahkarLite' ? { nationalCode, mobile } : { nationalCode, mobile, isCompany };
    const started = Date.now();
    try {
      const r = await post(`/api/sw1/${endpoint}`, body);
      return {
        ok: r.success === true,
        matched: r.success === true ? r.data === true : null,
        endpoint,
        code: r.code === undefined ? undefined : String(r.code),
        message: r.message ?? null,
        durationMs: Date.now() - started,
      };
    } catch (err) {
      logger.warn({ err, endpoint }, 'shahkar call failed');
      return { ok: false, matched: null, endpoint, message: (err as Error).message, durationMs: Date.now() - started };
    }
  },

  async sendOtp(mobile, code) {
    try {
      const r = await post('/api/sw1/SmsOTP', { code, mobile, template: config.APIIR_OTP_TEMPLATE });
      return { ok: r.success === true && r.data !== false, code: r.code === undefined ? undefined : String(r.code), message: r.message ?? null };
    } catch (err) {
      logger.warn({ err }, 'sms otp call failed');
      return { ok: false, message: (err as Error).message };
    }
  },

  async sendSms(mobiles, message) {
    try {
      const r = await post('/api/sw1/SendSms', { message, mobiles });
      return { ok: r.success === true, code: r.code === undefined ? undefined : String(r.code), message: r.message ?? null };
    } catch (err) {
      logger.warn({ err }, 'send sms call failed');
      return { ok: false, message: (err as Error).message };
    }
  },
};

/**
 * Offline simulator for development and automated tests. Refused in production by config.ts.
 * - Shahkar matches unless the pair was registered as a mismatch or the mobile ends with 9999.
 * - Sent OTPs are kept in memory (and printed in development) instead of being delivered.
 */
export const mockState = {
  mismatches: new Set<string>(),
  shahkarDown: false,
  smsDown: false,
  shahkarCalls: 0,
  sent: new Map<string, string>(),
  serviceSms: [] as { mobiles: string[]; message: string }[],
  reset() {
    this.serviceSms = [];
    this.mismatches.clear();
    this.shahkarDown = false;
    this.smsDown = false;
    this.shahkarCalls = 0;
    this.sent.clear();
  },
};

export const mockClient: ApiIrClient = {
  async shahkar(nationalCode, mobile) {
    mockState.shahkarCalls++;
    if (mockState.shahkarDown) return { ok: false, matched: null, endpoint: 'mock', message: 'simulated outage', durationMs: 0 };
    const matched = !mockState.mismatches.has(`${nationalCode}:${mobile}`) && !mobile.endsWith('9999');
    return { ok: true, matched, endpoint: 'mock', code: '0', message: null, durationMs: 0 };
  },
  async sendOtp(mobile, code) {
    if (mockState.smsDown) return { ok: false, message: 'simulated outage' };
    mockState.sent.set(mobile, code);
    if (config.NODE_ENV === 'development') logger.info({ mobile }, `[mock SMS] OTP for ${mobile}: ${code}`);
    return { ok: true };
  },
  async sendSms(mobiles, message) {
    mockState.serviceSms.push({ mobiles, message });
    return { ok: true };
  },
};

export const apiIr: ApiIrClient = config.APIIR_MODE === 'live' ? liveClient : mockClient;
