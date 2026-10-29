/**
 * Production secrets that are known samples or too weak to protect anything: the example values shipped in the
 * repository (.env.example, docker-compose defaults, development fallbacks) and values with almost no randomness.
 * Messages name the variable, never its value.
 */
const SAMPLE_SECRETS = new Set([
  'change-me-in-production-with-a-long-random-secret',
  'dev-only-secret-do-not-use-in-production',
  'dev-only-office-secret-do-not-use-in-production',
]);
const SAMPLE_MARKERS = /change[-_ ]?me|example|do[-_ ]?not[-_ ]?use|placeholder|your[-_ ]?secret/i;
const WEAK_DB_PASSWORDS = new Set(['', 'kx', 'postgres', 'password', 'changeme', 'secret', 'admin']);

export interface SecretsToCheck {
  jwtSecret?: string;
  dataEncryptionKey?: string;
  databaseUrl?: string;
}

export function sampleSecretProblems(s: SecretsToCheck): string[] {
  const problems: string[] = [];
  if (s.jwtSecret !== undefined) {
    const v = s.jwtSecret;
    if (SAMPLE_SECRETS.has(v) || SAMPLE_MARKERS.test(v)) problems.push('JWT_SECRET is a sample value: generate one with `openssl rand -hex 32`');
    else if (v.length < 32) problems.push('JWT_SECRET must be at least 32 characters');
    else if (new Set(v).size < 10) problems.push('JWT_SECRET is not random enough: generate one with `openssl rand -hex 32`');
  }
  if (s.dataEncryptionKey && new Set(s.dataEncryptionKey.toLowerCase()).size < 8) {
    problems.push('DATA_ENCRYPTION_KEY is not random enough: generate one with `openssl rand -hex 32`');
  }
  if (s.databaseUrl) {
    let password: string | null = null;
    try {
      password = decodeURIComponent(new URL(s.databaseUrl).password);
    } catch {
      /* not a URL: left to the database driver */
    }
    if (password !== null && WEAK_DB_PASSWORDS.has(password.toLowerCase())) {
      problems.push('DATABASE_URL uses a default or empty database password: set a random one (openssl rand -hex 16)');
    }
  }
  return problems;
}

/** Password of the demo accounts created by the seed scripts (public: it is in the README). */
export const DEMO_PASSWORD = 'Passw0rd!';

/** Why a first administrator password is unacceptable, or null when it is fine. */
export function weakAdminPassword(password: string): string | null {
  if (password.length < 12) return 'the first administrator password must be at least 12 characters';
  if (password.toLowerCase().includes(DEMO_PASSWORD.toLowerCase())) return 'the first administrator password must not contain the demo password';
  if (new Set(password).size < 6) return 'the first administrator password is too repetitive';
  return null;
}
