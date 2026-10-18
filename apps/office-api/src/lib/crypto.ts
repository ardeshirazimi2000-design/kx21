import crypto from 'node:crypto';
import { config } from '../config.js';

/** AES-256-GCM master key for data at rest (files, secrets, signing keys). */
const key = config.dataEncryptionKey
  ? Buffer.from(config.dataEncryptionKey, 'hex')
  : crypto.createHash('sha256').update(`kx-office-data:${config.jwtSecret}`).digest();

/** Layout: iv(12) | tag(16) | ciphertext */
export function encrypt(buf: Buffer): Buffer {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key, iv);
  const data = Buffer.concat([c.update(buf), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), data]);
}

export function decrypt(buf: Buffer): Buffer {
  const d = crypto.createDecipheriv('aes-256-gcm', key, buf.subarray(0, 12));
  d.setAuthTag(buf.subarray(12, 28));
  return Buffer.concat([d.update(buf.subarray(28)), d.final()]);
}

export const encryptText = (s: string) => `v1:${encrypt(Buffer.from(s, 'utf8')).toString('base64')}`;
export const decryptText = (s: string) => decrypt(Buffer.from(s.replace(/^v1:/, ''), 'base64')).toString('utf8');

export const sha256 = (v: string | Buffer) => crypto.createHash('sha256').update(v).digest('hex');

export function timingSafeEqualHex(a: string, b: string): boolean {
  const x = Buffer.from(a, 'hex');
  const y = Buffer.from(b, 'hex');
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

/** JSON with recursively sorted keys (stable hashing/signing). */
export function canonical(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v ?? null);
  if (v instanceof Date) return JSON.stringify(v.toISOString());
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o)
    .filter((k) => o[k] !== undefined)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`)
    .join(',')}}`;
}
