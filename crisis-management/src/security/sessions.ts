import jwt from 'jsonwebtoken';
import { config } from '../config.js';
import { one, pool, type Db } from '../db/pool.js';
import { hmac, randomToken, safeEqualHex } from '../lib/crypto.js';
import { unauthorized } from '../lib/errors.js';
import { audit } from '../lib/audit.js';
import type { Channel } from './roles.js';

export interface AccessClaims {
  sub: string;
  sid: string;
  ch: Channel;
}

export interface TokenPair {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
}

const ISSUER = 'crisis-management';

export function signAccess(c: AccessClaims): string {
  return jwt.sign({ sid: c.sid, ch: c.ch }, config.JWT_SECRET, {
    subject: c.sub,
    expiresIn: config.ACCESS_TOKEN_TTL_SEC,
    issuer: ISSUER,
    audience: c.ch,
    algorithm: 'HS256',
  });
}

export function verifyAccess(token: string): AccessClaims | null {
  try {
    const p = jwt.verify(token, config.JWT_SECRET, { issuer: ISSUER, algorithms: ['HS256'] }) as jwt.JwtPayload;
    if (typeof p.sub !== 'string' || typeof p.sid !== 'string' || (p.ch !== 'console' && p.ch !== 'app') || p.aud !== p.ch) return null;
    return { sub: p.sub, sid: p.sid, ch: p.ch };
  } catch {
    return null;
  }
}

function refreshTtl(ch: Channel) {
  return ch === 'console' ? config.CONSOLE_REFRESH_TTL_SEC : config.APP_REFRESH_TTL_SEC;
}

export interface SessionMeta {
  ip?: string | null;
  userAgent?: string | null;
  deviceId?: string | null;
  deviceName?: string | null;
}

export async function createSession(db: Db, userId: string, ch: Channel, meta: SessionMeta): Promise<TokenPair> {
  const secret = randomToken();
  const s = await one<{ id: string }>(
    `INSERT INTO sessions (user_id, channel, refresh_hash, device_id, device_name, ip, user_agent, expires_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7, now() + make_interval(secs => $8)) RETURNING id`,
    [userId, ch, hmac(secret, config.JWT_SECRET), meta.deviceId ?? null, meta.deviceName ?? null, meta.ip ?? null, meta.userAgent?.slice(0, 300) ?? null, refreshTtl(ch)],
    db,
  );
  return { accessToken: signAccess({ sub: userId, sid: s!.id, ch }), refreshToken: `${s!.id}.${secret}`, expiresIn: config.ACCESS_TOKEN_TTL_SEC };
}

/**
 * Rotates a refresh token. Presenting an already-rotated token is treated as theft:
 * the whole session is revoked (refresh-token reuse detection).
 */
export async function rotateRefresh(refreshToken: string, ch: Channel, ip: string | null): Promise<TokenPair> {
  const [sid, secret] = refreshToken.split('.');
  if (!sid || !secret || !/^[0-9a-f-]{36}$/.test(sid)) throw unauthorized('توکن نوسازی نامعتبر است');
  const s = await one<{ id: string; user_id: string; channel: Channel; refresh_hash: string; revoked_at: string | null; expired: boolean; idle: boolean }>(
    `SELECT id, user_id, channel, refresh_hash, revoked_at, expires_at < now() AS expired,
            (channel = 'console' AND last_seen_at < now() - make_interval(secs => $2)) AS idle
       FROM sessions WHERE id = $1`,
    [sid, config.CONSOLE_IDLE_TIMEOUT_SEC],
  );
  if (!s || s.channel !== ch || s.revoked_at || s.expired) throw unauthorized('نشست منقضی شده است، دوباره وارد شوید', 'session_expired');
  if (!safeEqualHex(hmac(secret, config.JWT_SECRET), s.refresh_hash)) {
    await revokeSession(pool, s.id, 'refresh_reuse');
    await audit({ action: 'session.refresh_reuse', actorId: s.user_id, targetType: 'session', targetId: s.id, outcome: 'denied', ip, channel: ch });
    throw unauthorized('نشست به دلایل امنیتی ابطال شد، دوباره وارد شوید', 'session_revoked');
  }
  if (s.idle) {
    await revokeSession(pool, s.id, 'idle_timeout');
    throw unauthorized('به دلیل عدم فعالیت از نشست خارج شدید', 'session_expired');
  }
  const next = randomToken();
  await pool.query('UPDATE sessions SET refresh_hash = $2, last_seen_at = now(), ip = $3 WHERE id = $1', [s.id, hmac(next, config.JWT_SECRET), ip]);
  return { accessToken: signAccess({ sub: s.user_id, sid: s.id, ch }), refreshToken: `${s.id}.${next}`, expiresIn: config.ACCESS_TOKEN_TTL_SEC };
}

export async function revokeSession(db: Db, sid: string, reason: string): Promise<void> {
  await db.query('UPDATE sessions SET revoked_at = now(), revoked_reason = $2 WHERE id = $1 AND revoked_at IS NULL', [sid, reason]);
}

export async function revokeUserSessions(db: Db, userId: string, reason: string, channel?: Channel): Promise<void> {
  await db.query(
    `UPDATE sessions SET revoked_at = now(), revoked_reason = $2
      WHERE user_id = $1 AND revoked_at IS NULL AND ($3::text IS NULL OR channel = $3)`,
    [userId, reason, channel ?? null],
  );
}
