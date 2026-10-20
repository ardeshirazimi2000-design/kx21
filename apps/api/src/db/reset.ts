/**
 * Clears the platform for production use: deletes every chamber, person, commission, meeting, resolution,
 * network, notification and uploaded file — the demo data included — and keeps only the super admin
 * account(s). The database structure (migrations) stays as it is.
 *
 *   CONFIRM_RESET=DELETE-ALL-DATA ROOT_PASSWORD='…' node dist/db/reset.js
 *
 * Optional: ROOT_EMAIL, ROOT_MOBILE, ROOT_NAME change the remaining super admin's details (only when
 * exactly one super admin remains). ROOT_PASSWORD is required while the account still has the demo password.
 */
import bcrypt from 'bcryptjs';
import { readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from '../config.js';
import { migrate } from './migrate.js';
import { pool } from './pool.js';
import { SEED_PASSWORD } from './seed.js';

const CONFIRM = 'DELETE-ALL-DATA';

export async function resetToRoot(env: NodeJS.ProcessEnv = process.env) {
  if (env.CONFIRM_RESET !== CONFIRM) {
    throw new Error(`Refusing to delete data: set CONFIRM_RESET=${CONFIRM} to confirm.`);
  }
  const password = env.ROOT_PASSWORD;
  if (password !== undefined && (password.length < 10 || password === SEED_PASSWORD)) {
    throw new Error('ROOT_PASSWORD must be at least 10 characters and differ from the demo password.');
  }
  await migrate(false);
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    const roots = (await c.query<{ id: string; password_hash: string | null }>('SELECT id, password_hash FROM users WHERE is_super_admin')).rows;
    if (!roots.length) throw new Error('No super admin account exists; nothing would be left to sign in with.');
    const demo = await Promise.all(roots.map((r) => (r.password_hash ? bcrypt.compare(SEED_PASSWORD, r.password_hash) : false)));
    if (demo.some(Boolean) && !password) {
      throw new Error('The super admin still has the demo password: set ROOT_PASSWORD to a new password.');
    }
    if ((env.ROOT_EMAIL || env.ROOT_MOBILE || env.ROOT_NAME) && roots.length !== 1) {
      throw new Error('ROOT_EMAIL / ROOT_MOBILE / ROOT_NAME need exactly one super admin.');
    }

    await c.query('CREATE TEMP TABLE keep_users ON COMMIT DROP AS SELECT * FROM users WHERE is_super_admin');
    const tables = (
      await c.query<{ t: string }>(
        `SELECT quote_ident(tablename) AS t FROM pg_tables WHERE schemaname = 'public' AND tablename <> 'schema_migrations'`,
      )
    ).rows.map((r) => r.t);
    await c.query(`TRUNCATE ${tables.join(', ')} RESTART IDENTITY CASCADE`);
    await c.query('INSERT INTO users SELECT * FROM keep_users');
    await c.query('UPDATE users SET chamber_id = NULL, last_login_at = NULL, updated_at = now()');
    if (password) await c.query('UPDATE users SET password_hash = $1', [await bcrypt.hash(password, 12)]);
    if (env.ROOT_EMAIL) await c.query('UPDATE users SET email = $1', [env.ROOT_EMAIL.trim().toLowerCase()]);
    if (env.ROOT_MOBILE) await c.query('UPDATE users SET mobile = $1', [env.ROOT_MOBILE.trim()]);
    if (env.ROOT_NAME) await c.query('UPDATE users SET full_name = $1', [env.ROOT_NAME.trim()]);
    await c.query('COMMIT');
  } catch (e) {
    await c.query('ROLLBACK');
    throw e;
  } finally {
    c.release();
  }

  // Uploaded files (documents, recordings, rendered pages) belong to the deleted records.
  const dir = path.resolve(config.uploadDir);
  const entries = await readdir(dir).catch(() => [] as string[]);
  for (const e of entries) await rm(path.join(dir, e), { recursive: true, force: true });

  return (await pool.query<{ full_name: string; email: string | null; mobile: string | null }>('SELECT full_name, email, mobile FROM users')).rows;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  resetToRoot()
    .then((left) => {
      console.log('All data deleted. Remaining accounts:');
      for (const u of left) console.log(`  ${u.full_name} — ${u.email ?? ''} ${u.mobile ?? ''}`);
    })
    .catch((e) => {
      console.error(e.message);
      process.exitCode = 1;
    })
    .finally(() => pool.end());
}
