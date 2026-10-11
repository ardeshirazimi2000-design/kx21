import { afterEach, describe, expect, it, vi } from 'vitest';
import { liveClient } from '../src/integrations/apiir.js';
import { isValidNationalCode, normalizeMobile } from '../src/lib/identity.js';

afterEach(() => vi.unstubAllGlobals());

function stubFetch(body: unknown, status = 200) {
  const fn = vi.fn(async () => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } }));
  vi.stubGlobal('fetch', fn);
  return fn;
}

describe('api.ir live client (contract from the OpenAPI document)', () => {
  it('calls ShahkarPro with nationalCode, mobile, isCompany and a Bearer token', async () => {
    const fetch = stubFetch({ data: true, success: true, code: 0, message: null });
    const r = await liveClient.shahkar('0010007700', '09120000000');
    expect(r).toMatchObject({ ok: true, matched: true, endpoint: 'ShahkarPro' });
    const [url, init] = fetch.mock.calls[0] as unknown as [URL, RequestInit];
    expect(String(url)).toBe('https://s.api.ir/api/sw1/ShahkarPro');
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>).Authorization).toMatch(/^Bearer /);
    expect(JSON.parse(init.body as string)).toEqual({ nationalCode: '0010007700', mobile: '09120000000', isCompany: false });
  });

  it('maps data=false to a mismatch and success=false to a provider failure', async () => {
    stubFetch({ data: false, success: true, code: 0 });
    expect(await liveClient.shahkar('0010007700', '09120000000')).toMatchObject({ ok: true, matched: false });
    stubFetch({ data: false, success: false, code: 401, message: 'توکن نامعتبر' });
    expect(await liveClient.shahkar('0010007700', '09120000000')).toMatchObject({ ok: false, matched: null, message: 'توکن نامعتبر' });
    stubFetch({}, 500);
    expect(await liveClient.shahkar('0010007700', '09120000000')).toMatchObject({ ok: false, matched: null });
  });

  it('sends the OTP through SmsOTP with the login template', async () => {
    const fetch = stubFetch({ data: true, success: true });
    expect(await liveClient.sendOtp('09120000000', '123456')).toEqual({ ok: true, code: undefined, message: null });
    const [url, init] = fetch.mock.calls[0] as unknown as [URL, RequestInit];
    expect(String(url)).toBe('https://s.api.ir/api/sw1/SmsOTP');
    expect(JSON.parse(init.body as string)).toEqual({ code: '123456', mobile: '09120000000', template: 1 });
  });
});

describe('identity helpers', () => {
  it('validates national codes', () => {
    expect(isValidNationalCode('0010007700')).toBe(false);
    expect(isValidNationalCode('0499370899')).toBe(true);
    expect(isValidNationalCode('1111111111')).toBe(false);
    expect(isValidNationalCode('123')).toBe(false);
  });
  it('normalises mobiles to the 09xxxxxxxxx format', () => {
    expect(normalizeMobile('+989121234567')).toBe('09121234567');
    expect(normalizeMobile('۰۹۱۲۱۲۳۴۵۶۷')).toBe('09121234567');
    expect(normalizeMobile('9121234567')).toBe('09121234567');
    expect(normalizeMobile('02112345678')).toBeNull();
  });
});
