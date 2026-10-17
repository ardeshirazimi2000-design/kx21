import pg from 'pg';

/** Creates the office test database next to the meetings test database (CI provides only one). */
export default async function setup() {
  const url = new URL(process.env.OFFICE_TEST_DATABASE_URL ?? 'postgres://kx:kx@localhost:5432/kx_office_test');
  const dbName = url.pathname.slice(1);
  const admin = new URL(url);
  admin.pathname = `/${process.env.OFFICE_TEST_ADMIN_DB ?? 'kx_test'}`;
  const c = new pg.Client({ connectionString: admin.toString() });
  await c.connect();
  try {
    const r = await c.query('SELECT 1 FROM pg_database WHERE datname = $1', [dbName]);
    if (!r.rowCount) await c.query(`CREATE DATABASE "${dbName.replace(/"/g, '')}"`);
  } finally {
    await c.end();
  }
}
