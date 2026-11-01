import crypto from 'node:crypto';
import jwt from 'jsonwebtoken';
import { config } from '../config.js';
import type { SecurityPolicy } from '@kx/shared';
import { one, query, type Db, pool } from '../db/pool.js';
import { securityPolicy } from '../services/security.js';

export interface AccessPayload {
  sub: string;
  typ: 'access' | 'mfa';
  /** the sign-in session the token belongs to (absent only on tokens minted by server-side scripts) */
  sid?: string;
}

export type SessionClient = 'web' | 'mobile';

export function signAccessToken(userId: string, sessionId?: string): string {
  return jwt.sign({ sub: userId, typ: 'access', ...(sessionId ? { sid: sessionId } : {}) }, config.jwtSecret, {
    expiresIn: config.accessTokenTtl as jwt.SignOptions['expiresIn'],
    issuer: 'kx-api',
  });
}

/** Short-lived token proving the password step passed, used to complete MFA. */
export function signMfaToken(userId: string): string {
  return jwt.sign({ sub: userId, typ: 'mfa' }, config.jwtSecret, { expiresIn: '5m', issuer: 'kx-api' });
}

export function verifyToken(token: string, typ: AccessPayload['typ']): AccessPayload | null {
  try {
    const p = jwt.verify(token, config.jwtSecret, { issuer: 'kx-api' }) as AccessPayload;
    return p.typ === typ ? p : null;
  } catch {
    return null;
  }
}

const sha256 = (s: string) => crypto.createHash('sha256').update(s).digest('hex');

/** A refresh token for a session: a new one at sign-in, or the next one of the same session at rotation. */
export async function issueRefreshToken(
  userId: string,
  device: string | undefined,
  ip: string | undefined,
  opts: { sessionId?: string; client?: SessionClient } = {},
  db: Db = pool,
) {
  const raw = crypto.randomBytes(48).toString('base64url');
  const row = await one<{ session_id: string }>(
    `INSERT INTO refresh_tokens (user_id, token_hash, device, ip, expires_at, client, session_id)
     VALUES ($1, $2, $3, $4, now() + make_interval(days => $5), $6, COALESCE($7::uuid, gen_random_uuid()))
     RETURNING session_id`,
    [userId, sha256(raw), device?.slice(0, 200) ?? null, ip ?? null, config.refreshTokenTtlDays, opts.client ?? 'web', opts.sessionId ?? null],
    db,
  );
  return { raw, sessionId: row!.session_id };
}

/** Idle limit of a session in minutes, from the security policy. */
export const idleMinutes = (policy: SecurityPolicy, client: string) =>
  client === 'mobile' ? policy.session.mobileIdleDays * 24 * 60 : policy.session.webIdleMinutes;

/**
 * Starts a session after a successful sign-in. When the user already has as many open sessions as the policy
 * allows, the oldest ones end (AFTA: limit concurrent sessions). Returns the tokens and how many sessions ended.
 */
export async function startSession(userId: string, client: SessionClient, device: string | undefined, ip: string | undefined) {
  const policy = await securityPolicy();
  const open = await query<{ session_id: string }>(
    `SELECT session_id FROM refresh_tokens
      WHERE user_id = $1 AND revoked_at IS NULL AND expires_at > now()
        AND last_used_at > now() - make_interval(mins => CASE WHEN client = 'mobile' THEN $2::int ELSE $3::int END)
      ORDER BY last_used_at ASC`,
    [userId, policy.session.mobileIdleDays * 24 * 60, policy.session.webIdleMinutes],
  );
  const evict = open.slice(0, Math.max(0, open.length - policy.session.maxConcurrent + 1)).map((r) => r.session_id);
  if (evict.length) await query('UPDATE refresh_tokens SET revoked_at = now() WHERE session_id = ANY($1::uuid[]) AND revoked_at IS NULL', [evict]);
  const { raw, sessionId } = await issueRefreshToken(userId, device, ip, { client });
  return { accessToken: signAccessToken(userId, sessionId), refreshToken: raw, sessionId, evicted: evict.length };
}

/**
 * Rotates a refresh token within its session. Reuse of a revoked token revokes every session of that user; a
 * session idle for longer than the policy allows ends (`reason: 'idle'`).
 */
export async function rotateRefreshToken(raw: string, ip?: string): Promise<{ userId: string; refreshToken: string; accessToken: string } | { reason: 'invalid' | 'idle' }> {
  const row = await one<{ id: string; user_id: string; revoked_at: Date | null; expires_at: Date; device: string | null; client: SessionClient; session_id: string; last_used_at: Date }>(
    'SELECT id, user_id, revoked_at, expires_at, device, client, session_id, last_used_at FROM refresh_tokens WHERE token_hash = $1',
    [sha256(raw)],
  );
  if (!row) return { reason: 'invalid' };
  if (row.revoked_at) {
    await query('UPDATE refresh_tokens SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL', [row.user_id]);
    return { reason: 'invalid' };
  }
  if (row.expires_at < new Date()) return { reason: 'invalid' };
  const policy = await securityPolicy();
  if (Date.now() - row.last_used_at.getTime() > idleMinutes(policy, row.client) * 60_000) {
    await query('UPDATE refresh_tokens SET revoked_at = now() WHERE session_id = $1 AND revoked_at IS NULL', [row.session_id]);
    return { reason: 'idle' };
  }
  await query('UPDATE refresh_tokens SET revoked_at = now() WHERE id = $1', [row.id]);
  const next = await issueRefreshToken(row.user_id, row.device ?? undefined, ip, { sessionId: row.session_id, client: row.client });
  return { userId: row.user_id, refreshToken: next.raw, accessToken: signAccessToken(row.user_id, row.session_id) };
}

/** Ends the session a refresh token belongs to. */
export async function revokeRefreshToken(raw: string) {
  await query(
    `UPDATE refresh_tokens SET revoked_at = now()
      WHERE session_id = (SELECT session_id FROM refresh_tokens WHERE token_hash = $1) AND revoked_at IS NULL`,
    [sha256(raw)],
  );
}

/**
 * Whether the session of an access token is still open, counting this request as activity. A session ends when
 * signed out, evicted, or idle for longer than the policy allows.
 */
export async function touchSession(sessionId: string): Promise<'ok' | 'ended' | 'idle'> {
  const row = await one<{ client: SessionClient; last_used_at: Date }>(
    `SELECT client, last_used_at FROM refresh_tokens WHERE session_id = $1 AND revoked_at IS NULL AND expires_at > now()
      ORDER BY created_at DESC LIMIT 1`,
    [sessionId],
  );
  if (!row) return 'ended';
  const policy = await securityPolicy();
  if (Date.now() - row.last_used_at.getTime() > idleMinutes(policy, row.client) * 60_000) {
    await query('UPDATE refresh_tokens SET revoked_at = now() WHERE session_id = $1 AND revoked_at IS NULL', [sessionId]);
    return 'idle';
  }
  // At most one write a minute per session.
  if (Date.now() - row.last_used_at.getTime() > 60_000) {
    await query('UPDATE refresh_tokens SET last_used_at = now() WHERE session_id = $1 AND revoked_at IS NULL', [sessionId]);
  }
  return 'ok';
}
