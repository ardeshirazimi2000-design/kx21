import type { NextFunction, Request, Response } from 'express';
import { one, query } from '../db/pool.js';
import { HttpError, unauthorized } from '../lib/errors.js';
import { touchSession, verifyToken } from './tokens.js';

export interface AuthUser {
  id: string;
  fullName: string;
  chamberId: string | null;
  /** The system's IT administrator (مدیر فناوری اطلاعات سامانه): chambers, people, logins, roles, security settings. */
  isSuperAdmin: boolean;
  /** Chambers whose processes the user runs (مدیر اتاق). */
  adminChambers: string[];
  /** Chambers whose people, logins and roles the user manages (مدیر فناوری اطلاعات اتاق). */
  itChambers: string[];
  /** Security auditor (ممیز امنیت): of every chamber, or of these. */
  auditAll: boolean;
  auditChambers: string[];
  /** Iran Chamber's secretariat (دبیرخانهٔ ملی): sees every chamber's commissions, runs the networks. */
  isNational: boolean;
  /** the sign-in session of this request's access token */
  sessionId?: string;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: AuthUser;
    }
  }
}

export async function loadAuthUser(userId: string): Promise<AuthUser | null> {
  const u = await one<{ id: string; full_name: string; chamber_id: string | null; is_super_admin: boolean; is_active: boolean }>(
    'SELECT id, full_name, chamber_id, is_super_admin, is_active FROM users WHERE id = $1',
    [userId],
  );
  if (!u || !u.is_active) return null;
  const admin = await query<{ chamber_id: string }>('SELECT chamber_id FROM chamber_admins WHERE user_id = $1', [userId]);
  const staff = await query<{ role: string; chamber_id: string | null }>('SELECT role, chamber_id FROM staff_roles WHERE user_id = $1', [userId]);
  const of = (role: string) => staff.filter((s) => s.role === role);
  return {
    id: u.id,
    fullName: u.full_name,
    chamberId: u.chamber_id,
    isSuperAdmin: u.is_super_admin,
    adminChambers: admin.map((a) => a.chamber_id),
    itChambers: of('it_admin').map((s) => s.chamber_id!),
    auditAll: of('auditor').some((s) => !s.chamber_id),
    auditChambers: of('auditor').flatMap((s) => (s.chamber_id ? [s.chamber_id] : [])),
    isNational: of('national').length > 0,
  };
}

export async function authenticate(req: Request, _res: Response, next: NextFunction) {
  const header = req.headers.authorization;
  const token = header?.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) throw unauthorized();
  const payload = verifyToken(token, 'access');
  if (!payload) throw unauthorized('توکن نامعتبر یا منقضی است');
  if (payload.sid) {
    const state = await touchSession(payload.sid);
    if (state === 'idle') throw new HttpError(401, 'session_idle', 'نشست به‌دلیل بی‌کاری بسته شد؛ دوباره وارد شوید');
    if (state === 'ended') throw new HttpError(401, 'session_ended', 'نشست پایان یافته است؛ دوباره وارد شوید');
  }
  const user = await loadAuthUser(payload.sub);
  if (!user) throw unauthorized('حساب کاربری غیرفعال است');
  req.user = { ...user, sessionId: payload.sid };
  next();
}

export function currentUser(req: Request): AuthUser {
  if (!req.user) throw unauthorized();
  return req.user;
}
