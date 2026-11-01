import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';

/** AFTA 2-9: with PUBLIC_HTTPS, signing in over plain HTTP is refused before the password is looked at. */
process.env.PUBLIC_HTTPS = 'true';
process.env.TRUST_PROXY = '1';
let app: any;

beforeAll(async () => {
  const { migrate } = await import('../src/db/migrate.js');
  const { pool } = await import('../src/db/pool.js');
  const { seed } = await import('../src/db/seed.js');
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await migrate(false);
  await seed();
  app = (await import('../src/app.js')).createApp();
});

describe('HTTPS only', () => {
  it('refuses sign-in over HTTP and accepts it through the TLS proxy', async () => {
    const plain = await request(app).post('/api/auth/login').send({ identifier: 'chair@kx.local', password: 'Passw0rd!' });
    expect(plain.status).toBe(403);
    expect(plain.body.error.code).toBe('https_required');
    // Through the web container's nginx (the one hop the API trusts), which sets X-Forwarded-Proto itself and
    // replaces whatever the browser sent, the same sign-in works.
    const viaProxy = await request(app).post('/api/auth/login').set('X-Forwarded-Proto', 'https').send({ identifier: 'chair@kx.local', password: 'Passw0rd!' });
    expect(viaProxy.status).toBe(200);
    expect(viaProxy.headers['strict-transport-security']).toBeTruthy();
  });
});
