import bcrypt from 'bcryptjs';
import { config } from '../config.js';
import { query, type Db } from '../db/pool.js';
import { randomInt } from 'node:crypto';
import { randomToken } from '../lib/crypto.js';
import { badRequest } from '../lib/errors.js';

/** Returns a list of policy violations (empty = acceptable). */
export function passwordProblems(pw: string, minLength: number, ctx: { username?: string | null; nationalCode?: string; mobile?: string } = {}): string[] {
  const p: string[] = [];
  if (pw.length < minLength) p.push(`حداقل ${minLength} کاراکتر`);
  if (pw.length > 128) p.push('حداکثر ۱۲۸ کاراکتر');
  if (!/[a-z]/.test(pw) || !/[A-Z]/.test(pw)) p.push('حروف کوچک و بزرگ لاتین');
  if (!/\d/.test(pw)) p.push('حداقل یک رقم');
  if (!/[^A-Za-z0-9]/.test(pw)) p.push('حداقل یک نماد');
  const lower = pw.toLowerCase();
  for (const v of [ctx.username, ctx.nationalCode, ctx.mobile]) {
    if (v && v.length >= 4 && lower.includes(v.toLowerCase())) p.push('نباید شامل نام کاربری، کد ملی یا موبایل باشد');
  }
  return p;
}

export function hashPassword(pw: string): Promise<string> {
  return bcrypt.hash(pw, config.BCRYPT_COST);
}

let dummyHash: string | undefined;

export function verifyPassword(pw: string, hash: string | null): Promise<boolean> {
  // Compare against a dummy hash when there is none, so timing does not reveal unknown usernames.
  return bcrypt.compare(pw, hash ?? (dummyHash ??= bcrypt.hashSync(randomToken(), config.BCRYPT_COST)));
}

/** Characters that cannot be confused when read aloud or typed by hand (no 0/O, 1/l/I, -/_). */
const TEMP_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';

/** One-time password issued by the user administrator; the user must change it on first console sign-in. */
export function temporaryPassword(): string {
  const body = Array.from({ length: 12 }, () => TEMP_ALPHABET[randomInt(TEMP_ALPHABET.length)]).join('');
  return `Tmp-${body}#${randomInt(10, 100)}`;
}

export async function assertNotReused(db: Db, userId: string, pw: string, history: number): Promise<void> {
  if (history <= 0) return;
  const prev = await query<{ password_hash: string }>(
    'SELECT password_hash FROM password_history WHERE user_id = $1 ORDER BY created_at DESC LIMIT $2',
    [userId, history],
    db,
  );
  for (const h of prev) if (await bcrypt.compare(pw, h.password_hash)) throw badRequest(`رمز عبور نباید با ${history} رمز قبلی یکسان باشد`);
}

export async function setPassword(db: Db, userId: string, pw: string, mustChange: boolean): Promise<void> {
  const hash = await hashPassword(pw);
  await db.query(
    `UPDATE users SET password_hash=$2, password_changed_at=now(), must_change_password=$3, updated_at=now() WHERE id=$1`,
    [userId, hash, mustChange],
  );
  await db.query('INSERT INTO password_history (user_id, password_hash) VALUES ($1,$2)', [userId, hash]);
}
