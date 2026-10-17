import crypto from 'node:crypto';
import jwt from 'jsonwebtoken';
import { config } from '../config.js';
import { one, pool, query, type Db } from '../db/pool.js';

const ISSUER = 'kx-office';

export function signAccessToken(userId: string): string {
  return jwt.sign({ sub: userId, typ: 'access' }, config.jwtSecret, { expiresIn: config.accessTokenTtl as jwt.SignOptions['expiresIn'], issuer: ISSUER });
}

export function signMfaToken(userId: string): string {
  return jwt.sign({ sub: userId, typ: 'mfa' }, config.jwtSecret, { expiresIn: '5m', issuer: ISSUER });
}

/** Short-lived token for a single file download link. */
export function signFileToken(userId: string, ref: string): string {
  return jwt.sign({ sub: userId, typ: 'file', ref }, config.jwtSecret, { expiresIn: '2m', issuer: ISSUER });
}

export function verifyToken(token: string, typ: 'access' | 'mfa' | 'file'): { sub: string; ref?: string } | null {
  try {
    const p = jwt.verify(token, config.jwtSecret, { issuer: ISSUER }) as { sub: string; typ: string; ref?: string };
    return p.typ === typ ? p : null;
  } catch {
    return null;
  }
}

const sha256 = (s: string) => crypto.createHash('sha256').update(s).digest('hex');

export async function issueRefreshToken(userId: string, device: string | undefined, ip: string | undefined, db: Db = pool) {
  const raw = crypto.randomBytes(48).toString('base64url');
  await query(
    `INSERT INTO refresh_tokens (user_id, token_hash, device, ip, expires_at) VALUES ($1,$2,$3,$4, now() + make_interval(days => $5))`,
    [userId, sha256(raw), device?.slice(0, 200) ?? null, ip ?? null, config.refreshTokenTtlDays],
    db,
  );
  return raw;
}

/** Rotation; reuse of a revoked token revokes every session of the user. */
export async function rotateRefreshToken(raw: string, ip?: string) {
  const row = await one('SELECT id, user_id, revoked_at, expires_at, device FROM refresh_tokens WHERE token_hash = $1', [sha256(raw)]);
  if (!row) return null;
  if (row.revoked_at) {
    await query('UPDATE refresh_tokens SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL', [row.user_id]);
    return null;
  }
  if (row.expires_at < new Date()) return null;
  await query('UPDATE refresh_tokens SET revoked_at = now() WHERE id = $1', [row.id]);
  return { userId: row.user_id as string, refreshToken: await issueRefreshToken(row.user_id, row.device ?? undefined, ip), accessToken: signAccessToken(row.user_id) };
}

export async function revokeRefreshToken(raw: string) {
  await query('UPDATE refresh_tokens SET revoked_at = now() WHERE token_hash = $1 AND revoked_at IS NULL', [sha256(raw)]);
}

export async function revokeAllSessions(userId: string, db: Db = pool) {
  await query('UPDATE refresh_tokens SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL', [userId], db);
}
