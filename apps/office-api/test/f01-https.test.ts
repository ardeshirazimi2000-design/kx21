// Regression tests for F01 (HTTPS between browser and system): which proxies may set the client address and scheme,
// sign-in refused over plain HTTP when PUBLIC_HTTPS is on, HSTS / security headers, and the production start.
import { spawn } from 'node:child_process';
import net from 'node:net';
import path from 'node:path';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { config, parseTrustProxy } from '../src/config.js';
import { pool } from '../src/db/pool.js';
import { seed, SEED_PASSWORD } from '../src/db/seed.js';

const root = path.resolve(__dirname, '..');
const tsx = path.join(root, '../../node_modules/.bin/tsx');
const RANDOM_HEX = 'b7c41f0e9a2d58e3c6f1a0b9d8e7c6a5f4e3d2c1b0a99887766554433221100f';
const SPOOFED = '203.0.113.9';
// Production refuses the default database password, so production starts connect as a role with a random one.
const PROD_ROLE = 'kx_f01_prod';
const PROD_ROLE_PASSWORD = 'c81e4a90d2f7b356';

type Settings = Pick<typeof config, 'trustProxy' | 'publicHttps' | 'hstsMaxAge' | 'hstsIncludeSubDomains'>;
const defaults: Settings = { trustProxy: config.trustProxy, publicHttps: config.publicHttps, hstsMaxAge: config.hstsMaxAge, hstsIncludeSubDomains: config.hstsIncludeSubDomains };

/** An app built with these settings (they are read when the app is created); the shared config is restored after. */
function appWith(s: Partial<Settings>) {
  Object.assign(config, defaults, s);
  try {
    return createApp();
  } finally {
    Object.assign(config, defaults);
  }
}
/** The same, but the settings stay in force while `fn` runs (the sign-in check reads them per request). */
async function withSettings(s: Partial<Settings>, fn: (app: ReturnType<typeof createApp>) => Promise<void>) {
  Object.assign(config, defaults, s);
  try {
    await fn(createApp());
  } finally {
    Object.assign(config, defaults);
  }
}

async function lastFailedLoginIp(identifier: string) {
  const r = await pool.query(`SELECT ip FROM audit_logs WHERE action = 'auth.login_failed' AND after->>'identifier' = $1 ORDER BY id DESC LIMIT 1`, [identifier]);
  return r.rows[0]?.ip as string | undefined;
}

beforeAll(async () => {
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await seed();
  const owner = (await pool.query('SELECT current_user AS u')).rows[0].u;
  await pool.query(`DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${PROD_ROLE}') THEN
    CREATE ROLE ${PROD_ROLE} LOGIN PASSWORD '${PROD_ROLE_PASSWORD}'; END IF; END $$`);
  await pool.query(`GRANT ${owner} TO ${PROD_ROLE}`);
});

afterAll(async () => {
  await pool.end();
});

describe('TRUST_PROXY parsing', () => {
  it('trusts no proxy unless told to', () => {
    for (const v of [undefined, '', ' ', 'false', '0']) expect(parseTrustProxy(v)).toBe(false);
  });
  it('accepts a hop count, addresses, CIDR ranges and the express keywords', () => {
    expect(parseTrustProxy('1')).toBe(1);
    expect(parseTrustProxy('127.0.0.1, 172.18.0.0/16,::1,fd00::/8,loopback')).toEqual(['127.0.0.1', '172.18.0.0/16', '::1', 'fd00::/8', 'loopback']);
  });
  it('refuses "true" and anything that is not an address', () => {
    expect(() => parseTrustProxy('true')).toThrow(/TRUST_PROXY/);
    for (const v of ['caddy', '10.0.0.1/33', '10.0.0.0/8/1', '10.0.0.1;evil', '::1/129']) expect(() => parseTrustProxy(v), v).toThrow(/TRUST_PROXY/);
  });
});

describe('client address (X-Forwarded-For)', () => {
  it('with no trusted proxy (systemd default) a client-sent X-Forwarded-For is ignored', async () => {
    const app = appWith({ trustProxy: false });
    await request(app).post('/api/auth/login').set('X-Forwarded-For', SPOOFED).send({ identifier: 'f01-nobody-1', password: 'x' }).expect(401);
    const ip = await lastFailedLoginIp('f01-nobody-1');
    expect(ip).toBeTruthy();
    expect(ip).not.toContain(SPOOFED);
    expect(ip).toMatch(/127\.0\.0\.1|::1/);
  });

  it('behind one proxy only the address that proxy added is used, not what the client prepended', async () => {
    const app = appWith({ trustProxy: 1 });
    await request(app).post('/api/auth/login').set('X-Forwarded-For', `198.51.100.1, ${SPOOFED}`).send({ identifier: 'f01-nobody-2', password: 'x' }).expect(401);
    expect(await lastFailedLoginIp('f01-nobody-2')).toBe(SPOOFED);
  });

  it('with a proxy address list, a request from an address not on it cannot set its own address', async () => {
    const app = appWith({ trustProxy: ['10.9.8.7'] });
    await request(app).post('/api/auth/login').set('X-Forwarded-For', SPOOFED).send({ identifier: 'f01-nobody-3', password: 'x' }).expect(401);
    expect(await lastFailedLoginIp('f01-nobody-3')).not.toContain(SPOOFED);
  });
});

describe('sign-in only over HTTPS when PUBLIC_HTTPS is on', () => {
  const login = { identifier: 'admin', password: SEED_PASSWORD };

  it('plain HTTP sign-in is refused with https_required, before the password is checked', async () => {
    await withSettings({ publicHttps: true, trustProxy: 1 }, async (app) => {
      const r = await request(app).post('/api/auth/login').send(login).expect(403);
      expect(r.body.error.code).toBe('https_required');
      expect(r.body).not.toHaveProperty('accessToken');
      for (const p of ['/api/auth/refresh', '/api/auth/mfa/verify']) expect((await request(app).post(p).send({})).body.error.code).toBe('https_required');
    });
  });

  it('a client cannot claim HTTPS itself when no proxy is trusted', async () => {
    await withSettings({ publicHttps: true, trustProxy: false }, async (app) => {
      const r = await request(app).post('/api/auth/login').set('X-Forwarded-Proto', 'https').send(login).expect(403);
      expect(r.body.error.code).toBe('https_required');
    });
  });

  it('sign-in works when the trusted proxy reports HTTPS', async () => {
    await withSettings({ publicHttps: true, trustProxy: 1 }, async (app) => {
      const r = await request(app).post('/api/auth/login').set('X-Forwarded-Proto', 'https').send(login).expect(200);
      expect(r.body.accessToken).toBeTruthy();
    });
  });

  it('without PUBLIC_HTTPS (existing installs) plain HTTP sign-in still works', async () => {
    await withSettings({ publicHttps: false, trustProxy: false }, async (app) => {
      await request(app).post('/api/auth/login').send(login).expect(200);
    });
  });

  it('other routes are not affected (health check over internal HTTP)', async () => {
    await withSettings({ publicHttps: true, trustProxy: false }, async (app) => {
      await request(app).get('/health').expect(200);
    });
  });
});

describe('security headers', () => {
  it('no HSTS without PUBLIC_HTTPS', async () => {
    const r = await request(appWith({ publicHttps: false })).get('/health').expect(200);
    expect(r.headers['strict-transport-security']).toBeUndefined();
    expect(r.headers['x-content-type-options']).toBe('nosniff');
    expect(r.headers['x-powered-by']).toBeUndefined();
    expect(r.headers['content-security-policy']).not.toContain('upgrade-insecure-requests');
  });

  it('HSTS with the configured max-age, without includeSubDomains or preload by default', async () => {
    const r = await request(appWith({ publicHttps: true, hstsMaxAge: 300 })).get('/health').expect(200);
    expect(r.headers['strict-transport-security']).toBe('max-age=300');
    expect(r.headers['content-security-policy']).toContain('upgrade-insecure-requests');
  });

  it('includeSubDomains only when asked; HSTS_MAX_AGE=off turns it off', async () => {
    const sub = await request(appWith({ publicHttps: true, hstsMaxAge: 31536000, hstsIncludeSubDomains: true })).get('/health');
    expect(sub.headers['strict-transport-security']).toBe('max-age=31536000; includeSubDomains');
    const off = await request(appWith({ publicHttps: true, hstsMaxAge: null })).get('/health');
    expect(off.headers['strict-transport-security']).toBeUndefined();
  });

  it('accepts browser CSP violation reports without authentication and stores nothing', async () => {
    const app = appWith({});
    await request(app)
      .post('/api/csp-report')
      .set('Content-Type', 'application/csp-report')
      .send(JSON.stringify({ 'csp-report': { 'violated-directive': 'script-src', 'blocked-uri': 'https://evil.example/x.js' } }))
      .expect(204);
    await request(app)
      .post('/api/csp-report')
      .set('Content-Type', 'application/reports+json')
      .send(JSON.stringify([{ type: 'csp-violation', body: { effectiveDirective: 'img-src', blockedURL: 'data' } }]))
      .expect(204);
    await request(app).post('/api/csp-report').set('Content-Type', 'application/csp-report').send('x'.repeat(20000)).expect(413);
  });
});

/** Starts the API as production would (systemd install: no TRUST_PROXY), returns its log and port, then stops it. */
async function startProd(env: Record<string, string>, probe?: (port: number) => Promise<void>) {
  const port = await new Promise<number>((resolve) => {
    const s = net.createServer().listen(0, '127.0.0.1', () => {
      const p = (s.address() as net.AddressInfo).port;
      s.close(() => resolve(p));
    });
  });
  const dbUrl = new URL(process.env.DATABASE_URL!);
  dbUrl.username = PROD_ROLE;
  dbUrl.password = PROD_ROLE_PASSWORD;
  const child = spawn(tsx, ['src/server.ts'], {
    cwd: root,
    env: {
      PATH: process.env.PATH,
      NODE_ENV: 'production',
      JWT_SECRET: RANDOM_HEX,
      DATA_ENCRYPTION_KEY: RANDOM_HEX,
      DATABASE_URL: dbUrl.toString(),
      STORAGE_DIR: './.test-storage',
      PORT: String(port),
      HOST: '127.0.0.1',
      WORKER_ENABLED: 'false',
      SCHEDULER_ENABLED: 'false',
      ...env,
    },
  });
  let log = '';
  child.stdout.on('data', (d) => (log += d));
  child.stderr.on('data', (d) => (log += d));
  const exited = new Promise<number | null>((resolve) => child.on('exit', (code) => resolve(code)));
  try {
    const started = await Promise.race([
      (async () => {
        for (let i = 0; i < 200 && !log.includes('listening'); i++) await new Promise((r) => setTimeout(r, 100));
        return log.includes('listening');
      })(),
      exited.then(() => false),
    ]);
    if (started && probe) await probe(port);
    return { started, log };
  } finally {
    child.kill();
    await exited;
  }
}

describe('production start (systemd install)', () => {
  it('starts on the given HOST, trusts no proxy, and refuses plain-HTTP sign-in with PUBLIC_HTTPS', async () => {
    const r = await startProd({ PUBLIC_HTTPS: 'true' }, async (port) => {
      const res = await fetch(`http://127.0.0.1:${port}/api/auth/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-forwarded-proto': 'https', 'x-forwarded-for': SPOOFED },
        body: JSON.stringify({ identifier: 'admin', password: SEED_PASSWORD }),
      });
      expect(res.status).toBe(403);
      expect(((await res.json()) as any).error.code).toBe('https_required');
      expect((await fetch(`http://127.0.0.1:${port}/health`)).status).toBe(200);
    });
    expect(r.started, r.log).toBe(true);
    expect(r.log).toContain('127.0.0.1');
    expect(r.log).not.toContain('PUBLIC_HTTPS is not set');
  }, 60_000);

  it('warns when HTTPS is not configured, so the operator knows sign-in is still over plain HTTP', async () => {
    const r = await startProd({});
    expect(r.started, r.log).toBe(true);
    expect(r.log).toContain('PUBLIC_HTTPS is not set');
  }, 60_000);

  it('refuses to start with TRUST_PROXY=true or a malformed proxy list, and never prints secrets', async () => {
    for (const v of ['true', 'caddy']) {
      const r = await startProd({ TRUST_PROXY: v });
      expect(r.started).toBe(false);
      expect(r.log).toContain('TRUST_PROXY');
      expect(r.log).not.toContain(RANDOM_HEX);
      expect(r.log).not.toContain(PROD_ROLE_PASSWORD);
    }
  }, 60_000);
});
