import type { NextFunction, Request, Response } from 'express';
import { config } from '../config.js';
import { one } from '../db/pool.js';
import { auditReq } from '../lib/audit.js';
import { forbidden, unauthorized } from '../lib/errors.js';
import type { Scope } from './catalog.js';
import { loadAccess, type Access, type Channel } from './roles.js';
import { verifyAccess } from './sessions.js';

export interface AuthUser {
  id: string;
  sessionId: string;
  channel: Channel;
  kind: 'staff' | 'citizen';
  fullName: string;
  districtId: number | null;
  /** Console only: the user must change their (temporary or expired) password before anything else. */
  passwordChangeRequired: boolean;
  access: Access;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: AuthUser;
    }
  }
}

/**
 * Validates the bearer token, the server-side session (so revocation is immediate),
 * the account status and the channel entitlement, then loads the effective permissions.
 */
export function authenticate(channel?: Channel) {
  return async (req: Request, _res: Response, next: NextFunction) => {
    const header = req.headers.authorization;
    const token = header?.startsWith('Bearer ') ? header.slice(7).trim() : null;
    if (!token) throw unauthorized();
    const claims = verifyAccess(token);
    if (!claims || (channel && claims.ch !== channel)) throw unauthorized('توکن نامعتبر یا منقضی است', 'invalid_token');

    const row = await one<{
      user_id: string; kind: 'staff' | 'citizen'; first_name: string; last_name: string; district_id: number | null;
      status: string; console_access: boolean; app_access: boolean; must_change_password: boolean; password_expired: boolean;
      revoked: boolean; idle: boolean;
    }>(
      `SELECT u.id AS user_id, u.kind, u.first_name, u.last_name, u.district_id, u.status, u.console_access, u.app_access,
              u.must_change_password,
              (u.password_changed_at IS NULL OR u.password_changed_at < now() - make_interval(days => $3)) AS password_expired,
              (s.revoked_at IS NOT NULL OR s.expires_at < now()) AS revoked,
              (s.channel = 'console' AND s.last_seen_at < now() - make_interval(secs => $4)) AS idle
         FROM sessions s JOIN users u ON u.id = s.user_id
        WHERE s.id = $1 AND s.user_id = $2`,
      [claims.sid, claims.sub, config.PASSWORD_MAX_AGE_DAYS, config.CONSOLE_IDLE_TIMEOUT_SEC],
    );
    if (!row || row.revoked) throw unauthorized('نشست ابطال یا منقضی شده است', 'session_revoked');
    if (row.idle) throw unauthorized('به دلیل عدم فعالیت از نشست خارج شدید', 'session_expired');
    if (row.status !== 'active') throw unauthorized('حساب کاربری غیرفعال است', 'account_inactive');
    if (claims.ch === 'console' && !row.console_access) throw unauthorized('دسترسی کنسول برای این حساب غیرفعال است', 'channel_denied');
    if (claims.ch === 'app' && !row.app_access) throw unauthorized('دسترسی اپلیکیشن برای این حساب غیرفعال است', 'channel_denied');

    const access = await loadAccess(row.user_id, claims.ch);
    const channelPerm = claims.ch === 'console' ? 'console.access' : 'app.access';
    if (!access.permissions.has(channelPerm)) throw unauthorized('نقش فعالی برای این کانال ندارید', 'channel_denied');

    await one('UPDATE sessions SET last_seen_at = now() WHERE id = $1', [claims.sid]);
    req.user = {
      id: row.user_id,
      sessionId: claims.sid,
      channel: claims.ch,
      kind: row.kind,
      fullName: `${row.first_name} ${row.last_name}`,
      districtId: row.district_id,
      passwordChangeRequired: claims.ch === 'console' && (row.must_change_password || row.password_expired),
      access,
    };
    next();
  };
}

/** Blocks everything except password change while a console password change is pending. */
export function requirePasswordCurrent(req: Request, _res: Response, next: NextFunction) {
  if (req.user?.passwordChangeRequired) throw forbidden('ابتدا رمز عبور خود را تغییر دهید');
  next();
}

export function currentUser(req: Request): AuthUser {
  if (!req.user) throw unauthorized();
  return req.user;
}

export function can(user: AuthUser, permission: string): boolean {
  return user.access.permissions.has(permission);
}

export function scopeOf(user: AuthUser, permission: string): Scope | null {
  return user.access.scopes.get(permission) ?? null;
}

/** Route guard: the user must hold at least one of the permissions. Denials are audited. */
export function requirePermission(...permissions: string[]) {
  return async (req: Request, _res: Response, next: NextFunction) => {
    const user = currentUser(req);
    if (permissions.some((p) => can(user, p))) return next();
    await auditReq(req, { action: 'access.denied', outcome: 'denied', details: { required: permissions, method: req.method, path: req.originalUrl } });
    throw forbidden();
  };
}
