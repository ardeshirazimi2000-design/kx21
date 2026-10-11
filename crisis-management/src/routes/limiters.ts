import { rateLimit } from 'express-rate-limit';
import { config } from '../config.js';

const common = {
  standardHeaders: 'draft-8' as const,
  legacyHeaders: false,
  skip: () => config.NODE_ENV === 'test',
  message: { error: { code: 'too_many_requests', message: 'تعداد درخواست‌ها بیش از حد مجاز است' } },
};

/** Password / identity submissions per IP. */
export const loginLimiter = rateLimit({ ...common, windowMs: 15 * 60_000, limit: 20 });
/** OTP verifications per IP (per-challenge attempts are limited separately). */
export const otpLimiter = rateLimit({ ...common, windowMs: 15 * 60_000, limit: 30 });
/** General API traffic per IP. */
export const apiLimiter = rateLimit({ ...common, windowMs: 60_000, limit: 300 });
