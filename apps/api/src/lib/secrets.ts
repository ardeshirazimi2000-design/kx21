import crypto from 'node:crypto';
import { config } from '../config.js';

/**
 * AES-256-GCM encryption for secrets stored in the database (e.g. webhook signing secrets).
 * Key: DATA_ENCRYPTION_KEY (64 hex chars) or, if unset, derived from JWT_SECRET.
 */
const key = config.dataEncryptionKey
  ? Buffer.from(config.dataEncryptionKey, 'hex')
  : crypto.createHash('sha256').update(`kx-data-key:${config.jwtSecret}`).digest();

export function encryptSecret(plain: string): string {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key, iv);
  const data = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return `v1:${Buffer.concat([iv, c.getAuthTag(), data]).toString('base64')}`;
}

export function decryptSecret(enc: string): string {
  const buf = Buffer.from(enc.replace(/^v1:/, ''), 'base64');
  const d = crypto.createDecipheriv('aes-256-gcm', key, buf.subarray(0, 12));
  d.setAuthTag(buf.subarray(12, 28));
  return Buffer.concat([d.update(buf.subarray(28)), d.final()]).toString('utf8');
}

export const sha256Hex = (s: string | Buffer) => crypto.createHash('sha256').update(s).digest('hex');

/** HMAC-SHA256 webhook signature over `${timestamp}.${body}` (header format: t=…,v1=…). */
export function signWebhook(secret: string, timestamp: number, body: string): string {
  return `t=${timestamp},v1=${crypto.createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex')}`;
}
