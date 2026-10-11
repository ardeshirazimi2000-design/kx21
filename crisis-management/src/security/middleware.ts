import type { NextFunction, Request, Response } from 'express';
import { one, pool } from '../db/pool.js';
import { audit, auditReq } from '../lib/audit.js';
import { forbidden, HttpError, unauthorized } from '../lib/errors.js';
import { auditBlocked } from '../services/auditStorage.js';
import type { Scope } from './catalog.js';
import { loadAccess, type Access, type Channel } from './roles.js';
import { enforceBinding, revokeSession, verifyAccess } from './sessions.js';
import { getSettings } from './settings.js';

export interface AuthUser {
  id: string;
  sessionId: string;
  channel: Channel;
  kind: 'staff' | 'citizen';
  fullName: string;
  districtId: number | null;
  /** Console only: the user must change their (temporary or expired) password before anything else. */
  passwordChangeRequired: boolean;
  /** FTA_TAH.1: sign-in history captured when this session was opened. */
  accessHistory: unknown;
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
    const st = await getSettings();

    const row = await one<{
      user_id: string; kind: 'staff' | 'citizen'; first_name: string; last_name: string; district_id: number | null;
      status: string; console_access: boolean; app_access: boolean; must_change_password: boolean; password_expired: boolean;
      revoked_at: string | null; revoked_reason: string | null; expired: boolean; idle: boolean; bound_ip: string | null; user_agent: string | null;
      access_history: unknown;
    }>(
      `SELECT u.id AS user_id, u.kind, u.first_name, u.last_name, u.district_id, u.status, u.console_access, u.app_access,
              u.must_change_password,
              ($3::int > 0 AND (u.password_changed_at IS NULL OR u.password_changed_at < now() - make_interval(days => $3::int))) AS password_expired,
              s.revoked_at, s.revoked_reason, s.expires_at < now() AS expired, s.bound_ip, s.user_agent, s.access_history,
              s.last_seen_at < now() - make_interval(secs => CASE WHEN s.channel = 'console' THEN $4::int ELSE $5::int END) AS idle
         FROM sessions s JOIN users u ON u.id = s.user_id
        WHERE s.id = $1 AND s.user_id = $2`,
      [claims.sid, claims.sub, st['password.maxAgeDays'], st['sessions.consoleIdleMinutes'] * 60, st['sessions.appIdleDays'] * 86400],
    );
    if (!row) throw unauthorized('نشست ابطال یا منقضی شده است', 'session_revoked');
    if (row.revoked_at) {
      // FIA_USB.1.2: tell the earlier session why it ended.
      if (row.revoked_reason === 'replaced_by_new_login') throw unauthorized('با این حساب از محل دیگری وارد شده‌اند و این نشست خاتمه یافت', 'session_replaced');
      throw unauthorized('نشست ابطال یا منقضی شده است', 'session_revoked');
    }
    if (row.expired) throw unauthorized('نشست منقضی شده است', 'session_expired');
    if (row.idle) {
      await revokeSession(pool, claims.sid, 'idle_timeout');
      await audit({ action: 'session.idle_timeout', actorId: row.user_id, targetType: 'session', targetId: claims.sid, ip: req.ip, channel: claims.ch });
      throw unauthorized('به دلیل عدم فعالیت از نشست خارج شدید', 'session_expired');
    }
    await enforceBinding({ id: claims.sid, userId: row.user_id, channel: claims.ch, boundIp: row.bound_ip, userAgent: row.user_agent }, req.ip ?? null, req.get('user-agent') ?? null);
    if (row.status !== 'active') throw unauthorized('حساب کاربری غیرفعال است', 'account_inactive');
    if (claims.ch === 'console' && !row.console_access) throw unauthorized('دسترسی کنسول برای این حساب غیرفعال است', 'channel_denied');
    if (claims.ch === 'app' && !row.app_access) throw unauthorized('دسترسی اپلیکیشن برای این حساب غیرفعال است', 'channel_denied');

    const access = await loadAccess(row.user_id, claims.ch);
    const channelPerm = claims.ch === 'console' ? 'console.access' : 'app.access';
    if (!access.permissions.has(channelPerm)) throw unauthorized('نقش فعالی برای این کانال ندارید', 'channel_denied');
    // FAU_STG.4: while the audit trail is full, only the administrators who can resolve it may act.
    if (auditBlocked() && !access.permissions.has('audit.configure') && !access.permissions.has('settings.manage')) {
      throw new HttpError(503, 'ظرفیت ممیزی تکمیل است؛ تا بایگانی ممیزی توسط ممیز امنیتی، سامانه در دسترس نیست', 'audit_full');
    }

    await one('UPDATE sessions SET last_seen_at = now(), ip = $2 WHERE id = $1', [claims.sid, req.ip ?? null]);
    req.user = {
      id: row.user_id,
      sessionId: claims.sid,
      channel: claims.ch,
      kind: row.kind,
      fullName: `${row.first_name} ${row.last_name}`,
      districtId: row.district_id,
      passwordChangeRequired: claims.ch === 'console' && (row.must_change_password || row.password_expired),
      accessHistory: row.access_history ?? null,
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
