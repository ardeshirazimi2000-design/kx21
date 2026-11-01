import { DEFAULT_SECURITY_POLICY, mergeSecurityPolicy, passwordRulesText, SECURITY_POLICY_LIMITS } from '@kx/shared';
import { Router } from 'express';
import { z } from 'zod';
import { forbidden } from '../lib/errors.js';
import { currentUser } from '../auth/middleware.js';
import { one, tx } from '../db/pool.js';
import { audit } from '../lib/audit.js';
import { body } from '../lib/validate.js';
import { requireSuperAdmin } from '../services/access.js';
import { invalidateSecurityPolicy, securityPolicy } from '../services/security.js';

/** The system's security policy (سیاست امنیتی): password rules, temporary lockout, CAPTCHA and sessions. */
export const securityRouter = Router();

/** The password rules, for every form that sets a password. */
securityRouter.get('/password-rules', async (_req, res) => {
  const p = (await securityPolicy()).password;
  res.json({ rules: p, text: passwordRulesText(p) });
});

securityRouter.get('/security-policy', async (req, res) => {
  const u = currentUser(req);
  // The auditor reviews the settings too (read only).
  if (!u.isSuperAdmin && !u.auditAll) throw forbidden();
  res.json({ policy: await securityPolicy(), defaults: DEFAULT_SECURITY_POLICY, limits: SECURITY_POLICY_LIMITS });
});

const int = z.number().int();
const policySchema = z.object({
  password: z.object({ minLength: int, requireLower: z.boolean(), requireUpper: z.boolean(), requireDigit: z.boolean(), requireSymbol: z.boolean() }),
  lockout: z.object({ maxFailures: int, lockMinutes: int, captchaAfter: int }),
  session: z.object({ maxConcurrent: int, webIdleMinutes: int, mobileIdleDays: int }),
});

/** Changed by the IT administrator only; values outside their limits are brought within them, never rejected silently. */
securityRouter.put('/security-policy', async (req, res) => {
  const u = currentUser(req);
  requireSuperAdmin(u);
  const b = body(req, policySchema);
  const policy = mergeSecurityPolicy(b);
  await tx(async (c) => {
    const before = await one<{ value: unknown }>(`SELECT value FROM app_settings WHERE key = 'security' FOR UPDATE`, [], c);
    await c.query(
      `INSERT INTO app_settings (key, value, updated_by) VALUES ('security', $1, $2)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = now()`,
      [JSON.stringify(policy), u.id],
    );
    await audit(c, req, { chamberId: null, action: 'security.policy_changed', entity: 'app_settings', entityId: 'security', before: mergeSecurityPolicy(before?.value), after: policy });
  });
  invalidateSecurityPolicy();
  res.json({ policy });
});
