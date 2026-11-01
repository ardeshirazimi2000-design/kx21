import { describe, expect, it } from 'vitest';
import { DEFAULT_SECURITY_POLICY, mergeSecurityPolicy, passwordProblems } from './securityPolicy.js';

describe('security policy', () => {
  it('fills defaults and keeps every value within its limits', () => {
    expect(mergeSecurityPolicy(undefined)).toEqual(DEFAULT_SECURITY_POLICY);
    const p = mergeSecurityPolicy({ password: { minLength: 3 }, lockout: { maxFailures: 1000, captchaAfter: 50 }, session: { webIdleMinutes: 'x' } });
    expect(p.password.minLength).toBe(8);
    expect(p.lockout.maxFailures).toBe(20);
    expect(p.lockout.captchaAfter).toBe(19);
    expect(p.session.webIdleMinutes).toBe(DEFAULT_SECURITY_POLICY.session.webIdleMinutes);
  });

  it('asks for a CAPTCHA before the lock', () => {
    expect(mergeSecurityPolicy({ lockout: { maxFailures: 3, captchaAfter: 5 } }).lockout.captchaAfter).toBe(2);
  });

  it('names what a password lacks', () => {
    const rules = DEFAULT_SECURITY_POLICY.password;
    expect(passwordProblems('Str0ng!Pass', rules)).toEqual([]);
    expect(passwordProblems('short', rules).length).toBeGreaterThanOrEqual(4);
    expect(passwordProblems('alllowercase1!', rules)).toEqual(['رمز عبور باید حرف بزرگ لاتین (A-Z) داشته باشد']);
    expect(passwordProblems('Ali.Rezaei2024!', rules, { email: 'ali.rezaei@kx.ir' })).toHaveLength(1);
    expect(passwordProblems('MyPassw0rd!x', rules)).toHaveLength(1);
    expect(passwordProblems('abcdefgh', { minLength: 8, requireLower: true, requireUpper: false, requireDigit: false, requireSymbol: false })).toEqual([]);
  });
});
