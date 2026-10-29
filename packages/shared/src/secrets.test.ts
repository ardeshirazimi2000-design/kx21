import { describe, expect, it } from 'vitest';
import { sampleSecretProblems } from './secrets.js';

const random = 'b7c41f0e9a2d58e3c6f1a0b9d8e7c6a5f4e3d2c1b0a99887766554433221100f';

describe('sample secrets in production (R5)', () => {
  it('rejects the sample and development secrets shipped in the repository', () => {
    for (const s of ['change-me-in-production-with-a-long-random-secret', 'dev-only-secret-do-not-use-in-production', 'dev-only-office-secret-do-not-use-in-production']) {
      expect(sampleSecretProblems({ jwtSecret: s })).toHaveLength(1);
    }
    expect(sampleSecretProblems({ jwtSecret: 'please-CHANGEME-this-is-long-enough-for-the-check' })).toHaveLength(1);
  });

  it('rejects short or repetitive secrets and keys', () => {
    expect(sampleSecretProblems({ jwtSecret: 'short' })[0]).toContain('at least 32');
    expect(sampleSecretProblems({ jwtSecret: 'a'.repeat(64) })[0]).toContain('not random');
    expect(sampleSecretProblems({ dataEncryptionKey: '0'.repeat(64) })[0]).toContain('DATA_ENCRYPTION_KEY');
    expect(sampleSecretProblems({ dataEncryptionKey: 'ab'.repeat(32) })[0]).toContain('DATA_ENCRYPTION_KEY');
  });

  it('rejects default database passwords', () => {
    expect(sampleSecretProblems({ databaseUrl: 'postgres://kx:kx@db:5432/kx' })[0]).toContain('DATABASE_URL');
    expect(sampleSecretProblems({ databaseUrl: 'postgres://kx@db:5432/kx' })[0]).toContain('DATABASE_URL');
    expect(sampleSecretProblems({ databaseUrl: 'postgres://kx:3f9c0a7b1e2d4c5f@db:5432/kx' })).toEqual([]);
  });

  it('accepts random values and never echoes a value', () => {
    expect(sampleSecretProblems({ jwtSecret: random, dataEncryptionKey: random, databaseUrl: 'postgres://kx:3f9c0a7b1e2d4c5f@db:5432/kx' })).toEqual([]);
    const all = sampleSecretProblems({ jwtSecret: 'change-me-in-production-with-a-long-random-secret', databaseUrl: 'postgres://kx:kx@db/kx' }).join(' ');
    expect(all).not.toContain('change-me-in-production');
    expect(all).not.toContain('kx:kx');
  });
});
