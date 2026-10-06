import type { NextFunction, Request, Response } from 'express';
import { one, query } from '../db/pool.js';
import { unauthorized } from '../lib/errors.js';
import { verifyToken } from './tokens.js';

export interface AuthUser {
  id: string;
  fullName: string;
  chamberId: string | null;
  isSuperAdmin: boolean;
  adminChambers: string[];
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
  return {
    id: u.id,
    fullName: u.full_name,
    chamberId: u.chamber_id,
    isSuperAdmin: u.is_super_admin,
    adminChambers: admin.map((a) => a.chamber_id),
  };
}

export async function authenticate(req: Request, _res: Response, next: NextFunction) {
  const header = req.headers.authorization;
  const token = header?.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) throw unauthorized();
  const payload = verifyToken(token, 'access');
  if (!payload) throw unauthorized('توکن نامعتبر یا منقضی است');
  const user = await loadAuthUser(payload.sub);
  if (!user) throw unauthorized('حساب کاربری غیرفعال است');
  req.user = user;
  next();
}

export function currentUser(req: Request): AuthUser {
  if (!req.user) throw unauthorized();
  return req.user;
}
