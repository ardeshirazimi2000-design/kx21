process.env.NODE_ENV = 'test';
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL ?? 'postgres://crisis:crisis@localhost:5432/crisis_test';
process.env.APIIR_MODE = 'mock';
process.env.BCRYPT_COST = '4';
process.env.OTP_RESEND_COOLDOWN_SEC = '0';
process.env.OTP_MAX_PER_HOUR = '1000';
