import jwt from 'jsonwebtoken';
import { config } from '../config.js';
import { one, pool, query, type Db } from '../db/pool.js';
import { hmac, randomToken, safeEqualHex } from '../lib/crypto.js';
import { HttpError, unauthorized } from '../lib/errors.js';
import { audit } from '../lib/audit.js';
import type { Channel } from './roles.js';
import { getSettings } from './settings.js';

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

export interface AccessHistory {
  lastSuccessAt: string | null;
  lastSuccessIp: string | null;
  lastFailureAt: string | null;
  failuresSinceLastSuccess: number;
}

/**
 * Records a successful sign-in on the user and returns the history to show them (FTA_TAH.1).
 * The counters are reset here and preserved on the new session, so they are never lost unseen (FTA_TAH.1.3).
 */
export async function recordSuccessfulLogin(db: Db, userId: string, ip: string | null): Promise<AccessHistory> {
  const prev = await one<{ last_login_at: Date | null; last_login_ip: string | null; last_failed_login_at: Date | null; failed_since_success: number }>(
    'SELECT last_login_at, last_login_ip, last_failed_login_at, failed_since_success FROM users WHERE id = $1',
    [userId],
    db,
  );
  await db.query(
    `UPDATE users SET last_login_at = now(), last_login_ip = $2, failed_since_success = 0, failed_logins = 0, locked_until = NULL, lock_count = 0 WHERE id = $1`,
    [userId, ip],
  );
  return {
    lastSuccessAt: prev?.last_login_at?.toISOString() ?? null,
    lastSuccessIp: prev?.last_login_ip ?? null,
    lastFailureAt: prev?.last_failed_login_at?.toISOString() ?? null,
    failuresSinceLastSuccess: prev?.failed_since_success ?? 0,
  };
}

/**
 * Opens a session after enforcing the concurrent-session limit (FTA_MCS.1, FDP_ACF.1.4, FIA_USB.1.2):
 * "replace" ends the oldest session(s) (their page is told why), "deny" refuses the new one.
 */
export async function createSession(db: Db, userId: string, ch: Channel, meta: SessionMeta, history: AccessHistory | null = null): Promise<TokenPair> {
  const s0 = await getSettings(db);
  const max = ch === 'console' ? s0['sessions.maxConsole'] : s0['sessions.maxApp'];
  const active = await query<{ id: string }>(
    `SELECT id FROM sessions WHERE user_id = $1 AND channel = $2 AND revoked_at IS NULL AND expires_at > now() ORDER BY last_seen_at ASC`,
    [userId, ch],
    db,
  );
  if (active.length >= max) {
    if (s0['sessions.limitAction'] === 'deny') {
      await audit({ action: 'session.limit_denied', actorId: userId, outcome: 'denied', ip: meta.ip, channel: ch, details: { active: active.length, max } });
      throw new HttpError(409, `سقف نشست همزمان (${max}) پر است؛ ابتدا از نشست دیگر خارج شوید`, 'session_limit');
    }
    const victims = active.slice(0, active.length - max + 1).map((a) => a.id);
    await db.query(`UPDATE sessions SET revoked_at = now(), revoked_reason = 'replaced_by_new_login' WHERE id = ANY($1)`, [victims]);
    await audit({ action: 'session.replaced', actorId: userId, ip: meta.ip, channel: ch, details: { replaced: victims, max } }, db);
  }
  const secret = randomToken();
  const s = await one<{ id: string }>(
    `INSERT INTO sessions (user_id, channel, refresh_hash, device_id, device_name, ip, bound_ip, user_agent, access_history, expires_at)
     VALUES ($1,$2,$3,$4,$5,$6,$6,$7,$8, now() + make_interval(secs => $9)) RETURNING id`,
    [userId, ch, hmac(secret, config.JWT_SECRET), meta.deviceId ?? null, meta.deviceName ?? null, meta.ip ?? null, meta.userAgent?.slice(0, 300) ?? null, history, refreshTtl(ch)],
    db,
  );
  return { accessToken: signAccess({ sub: userId, sid: s!.id, ch }), refreshToken: `${s!.id}.${secret}`, expiresIn: config.ACCESS_TOKEN_TTL_SEC };
}

/**
 * Rotates a refresh token. Presenting an already-rotated token is treated as theft:
 * the whole session is revoked (refresh-token reuse detection).
 */
export async function rotateRefresh(refreshToken: string, ch: Channel, ip: string | null, userAgent: string | null): Promise<TokenPair> {
  const [sid, secret] = refreshToken.split('.');
  if (!sid || !secret || !/^[0-9a-f-]{36}$/.test(sid)) throw unauthorized('توکن نوسازی نامعتبر است');
  const st = await getSettings();
  const s = await one<{ id: string; user_id: string; channel: Channel; refresh_hash: string; revoked_at: string | null; expired: boolean; idle: boolean; bound_ip: string | null; user_agent: string | null }>(
    `SELECT id, user_id, channel, refresh_hash, revoked_at, bound_ip, user_agent, expires_at < now() AS expired,
            last_seen_at < now() - make_interval(secs => CASE WHEN channel = 'console' THEN $2::int ELSE $3::int END) AS idle
       FROM sessions WHERE id = $1`,
    [sid, st['sessions.consoleIdleMinutes'] * 60, st['sessions.appIdleDays'] * 86400],
  );
  if (!s || s.channel !== ch || s.revoked_at || s.expired) throw unauthorized('نشست منقضی شده است، دوباره وارد شوید', 'session_expired');
  if (!safeEqualHex(hmac(secret, config.JWT_SECRET), s.refresh_hash)) {
    await revokeSession(pool, s.id, 'refresh_reuse');
    await audit({ action: 'session.refresh_reuse', actorId: s.user_id, targetType: 'session', targetId: s.id, outcome: 'denied', ip, channel: ch });
    throw unauthorized('نشست به دلایل امنیتی ابطال شد، دوباره وارد شوید', 'session_revoked');
  }
  await enforceBinding({ id: s.id, userId: s.user_id, channel: ch, boundIp: s.bound_ip, userAgent: s.user_agent }, ip, userAgent);
  if (s.idle) {
    await revokeSession(pool, s.id, 'idle_timeout');
    await audit({ action: 'session.idle_timeout', actorId: s.user_id, targetType: 'session', targetId: s.id, ip, channel: ch });
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

/**
 * FIA_USB.1.3: a session token presented from another client (different IP where bound, or another browser/app)
 * ends the session and requires a new sign-in.
 */
export async function enforceBinding(
  sess: { id: string; userId: string; channel: Channel; boundIp: string | null; userAgent: string | null },
  ip: string | null,
  userAgent: string | null,
): Promise<void> {
  const st = await getSettings();
  const bindIp = sess.channel === 'console' ? st['sessions.bindIpConsole'] : st['sessions.bindIpApp'];
  const ipChanged = bindIp && sess.boundIp !== null && sess.boundIp !== ip;
  const uaChanged = st['sessions.bindUserAgent'] && (sess.userAgent ?? '') !== (userAgent?.slice(0, 300) ?? '');
  if (!ipChanged && !uaChanged) return;
  await revokeSession(pool, sess.id, ipChanged ? 'ip_changed' : 'client_changed');
  await audit({
    action: 'session.hijack_suspected', actorId: sess.userId, targetType: 'session', targetId: sess.id, outcome: 'denied', ip, channel: sess.channel, userAgent,
    details: { boundIp: sess.boundIp, ipChanged, uaChanged },
  });
  throw unauthorized('نشست از محل یا مرورگر دیگری استفاده شد و خاتمه یافت؛ دوباره وارد شوید', 'session_revoked');
}
