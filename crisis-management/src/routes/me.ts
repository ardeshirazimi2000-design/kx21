/** The signed-in user's own profile, permissions and sessions (console and app). */
import { Router } from 'express';
import { one, pool, query } from '../db/pool.js';
import { auditReq } from '../lib/audit.js';
import { notFound } from '../lib/errors.js';
import { maskNationalCode } from '../lib/identity.js';
import { currentUser } from '../security/middleware.js';
import { revokeSession } from '../security/sessions.js';

export const meRouter = Router();

meRouter.get('/', async (req, res) => {
  const u = currentUser(req);
  const row = await one<{ national_code: string; mobile: string; first_name: string; last_name: string; username: string | null; organization: string | null; position_title: string | null; district_id: number | null; district_name: string | null; shahkar_verified_at: string | null; last_login_at: string | null }>(
    `SELECT u.national_code, u.mobile, u.first_name, u.last_name, u.username, u.organization, u.position_title, u.district_id,
            d.name AS district_name, u.shahkar_verified_at, u.last_login_at
       FROM users u LEFT JOIN districts d ON d.id = u.district_id WHERE u.id = $1`,
    [u.id],
  );
  res.json({
    id: u.id,
    kind: u.kind,
    channel: u.channel,
    fullName: u.fullName,
    ...row,
    national_code: maskNationalCode(row!.national_code),
    passwordChangeRequired: u.passwordChangeRequired,
    accessHistory: u.accessHistory,
    roles: u.access.roles,
    permissions: [...u.access.permissions].sort(),
    scopes: Object.fromEntries(u.access.scopes),
  });
});

meRouter.get('/sessions', async (req, res) => {
  const u = currentUser(req);
  const rows = await query<{ id: string }>(
    `SELECT id, channel, device_name, ip, created_at, last_seen_at, expires_at FROM sessions
      WHERE user_id = $1 AND revoked_at IS NULL AND expires_at > now() ORDER BY last_seen_at DESC`,
    [u.id],
  );
  res.json(rows.map((r) => ({ ...r, current: r.id === u.sessionId })));
});

meRouter.delete('/sessions/:sid', async (req, res) => {
  const u = currentUser(req);
  const s = await one('SELECT 1 FROM sessions WHERE id = $1 AND user_id = $2', [/^[0-9a-f-]{36}$/.test(req.params.sid as string) ? req.params.sid : null, u.id]);
  if (!s) throw notFound();
  await revokeSession(pool, req.params.sid as string, 'user_revoke');
  await auditReq(req, { action: 'session.revoke_own', targetType: 'session', targetId: req.params.sid as string });
  res.status(204).end();
});
