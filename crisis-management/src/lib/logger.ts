import { pino } from 'pino';
import { config } from '../config.js';

export const logger = pino({
  level: process.env.LOG_LEVEL ?? (config.NODE_ENV === 'test' ? 'silent' : 'info'),
  // Never write credentials, OTPs or tokens to logs.
  redact: ['req.headers.authorization', '*.password', '*.otp', '*.code', '*.refreshToken', '*.accessToken'],
});
