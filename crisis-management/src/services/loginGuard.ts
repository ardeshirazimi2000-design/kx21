/**
 * Authentication failure handling (FIA_AFL.1) and session-establishment conditions (FTA_TSE.1).
 */
import { BlockList, isIP } from 'node:net';
import { config } from '../config.js';
import { one, type Db, pool } from '../db/pool.js';
import { audit } from '../lib/audit.js';
import { HttpError } from '../lib/errors.js';
import { getSettings } from '../security/settings.js';

/**
 * Counts a failed authentication (wrong password or OTP). On reaching the threshold the account is locked;
 * with progressive lockout every further lock doubles the duration (max 24h), making re-authentication harder.
 */
export async function recordAuthFailure(userId: string, ip: string | null, channel: string, reason: string, db: Db = pool): Promise<void> {
  const s = await getSettings(db);
  const u = await one<{ failed_logins: number; lock_count: number }>(
    `UPDATE users SET failed_logins = failed_logins + 1, failed_since_success = failed_since_success + 1, last_failed_login_at = now()
      WHERE id = $1 RETURNING failed_logins, lock_count`,
    [userId],
    db,
  );
  if (!u || u.failed_logins < s['lockout.threshold']) return;
  const minutes = Math.min(s['lockout.progressive'] ? s['lockout.minutes'] * 2 ** u.lock_count : s['lockout.minutes'], 24 * 60);
  await db.query(
    `UPDATE users SET locked_until = now() + make_interval(mins => $2), lock_count = lock_count + 1, failed_logins = 0 WHERE id = $1`,
    [userId, minutes],
  );
  await audit({ action: 'account.locked', actorId: userId, targetType: 'user', targetId: userId, outcome: 'failure', ip, channel, details: { reason, minutes, lockCount: u.lock_count + 1 } }, db);
}

export async function lockedMinutesLeft(userId: string): Promise<number> {
  const r = await one<{ left: number | null }>(
    `SELECT CEIL(EXTRACT(EPOCH FROM (locked_until - now())) / 60)::int AS left FROM users WHERE id = $1 AND locked_until > now()`,
    [userId],
  );
  return r?.left ?? 0;
}

export function normalizeIp(ip: string | null | undefined): string | null {
  if (!ip) return null;
  return ip.startsWith('::ffff:') && isIP(ip.slice(7)) === 4 ? ip.slice(7) : ip;
}

function blockList(cidrs: string[]): BlockList {
  const list = new BlockList();
  for (const c of cidrs) {
    const [addr, bits] = c.split('/');
    const type = isIP(addr) === 6 ? 'ipv6' : 'ipv4';
    if (!isIP(addr)) continue;
    if (bits === undefined) list.addAddress(addr, type);
    else list.addSubnet(addr, Number(bits), type);
  }
  return list;
}

export function ipAllowed(ip: string | null, cidrs: string[]): boolean {
  if (cidrs.length === 0) return true;
  const n = normalizeIp(ip);
  if (!n || !isIP(n)) return false;
  return blockList(cidrs).check(n, isIP(n) === 6 ? 'ipv6' : 'ipv4');
}

/** Local day-of-week (0 = Sunday) and HH:MM in the configured time zone. */
export function localClock(at = new Date()): { day: number; hhmm: string } {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: config.TIME_ZONE, weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(at);
  const get = (t: string) => parts.find((p) => p.type === t)!.value;
  const day = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(get('weekday'));
  return { day, hhmm: `${get('hour')}:${get('minute')}` };
}

function inWindow(hhmm: string, from: string, to: string): boolean {
  return from <= to ? hhmm >= from && hhmm <= to : hhmm >= from || hhmm <= to;
}

/** FTA_TSE.1: refuses console session establishment by network, day and time of day (global and per user). */
export async function assertConsoleSessionAllowed(user: { id: string; allowed_cidrs: string[] }, ip: string | null): Promise<void> {
  const s = await getSettings();
  const { day, hhmm } = localClock();
  let reason: string | null = null;
  if (!ipAllowed(ip, s['access.consoleCidrs'])) reason = 'network';
  else if (!ipAllowed(ip, user.allowed_cidrs ?? [])) reason = 'user_network';
  else if (!s['access.consoleDays'].includes(day)) reason = 'day';
  else if (!inWindow(hhmm, s['access.consoleHours'].from, s['access.consoleHours'].to)) reason = 'time';
  if (!reason) return;
  await audit({ action: 'session.denied', actorId: user.id, outcome: 'denied', ip, channel: 'console', details: { reason, day, time: hhmm } });
  throw new HttpError(403, reason.endsWith('network') ? 'ورود به کنسول از این شبکه مجاز نیست' : 'ورود به کنسول در این روز یا ساعت مجاز نیست', 'session_not_allowed');
}
