/**
 * Creates the first super admin of an empty installation (no demo data). The password is read from standard input
 * (first line), so it is never in the process list, the container environment or a log:
 *
 *   ADMIN_EMAIL=root@example.org node dist/db/create-admin.js < password-file
 *
 * The super admin then creates the chamber and its administrators from the web interface.
 * Does nothing when the database already has users.
 */
import bcrypt from 'bcryptjs';
import { weakAdminPassword } from '@kx/shared';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { migrate } from './migrate.js';
import { pool } from './pool.js';

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) throw new Error('pipe the password on standard input');
  let s = '';
  for await (const chunk of process.stdin) s += chunk;
  return s.split(/\r?\n/)[0];
}

/** Returns whether the account was created. */
export async function createFirstSuperAdmin(email: string, password: string): Promise<boolean> {
  await migrate(false);
  const weak = weakAdminPassword(password);
  if (weak) throw new Error(weak);
  if (!/^[^\s@]+@[^\s@]+$/.test(email)) throw new Error('ADMIN_EMAIL is not an email address');
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    // Serialises concurrent runs, so two installs can never both create an account.
    await c.query('LOCK TABLE users IN EXCLUSIVE MODE');
    if ((await c.query('SELECT 1 FROM users LIMIT 1')).rowCount) {
      await c.query('ROLLBACK');
      return false;
    }
    await c.query(`INSERT INTO users (full_name, email, password_hash, is_super_admin) VALUES ('مدیر سامانه', $1, $2, true)`, [
      email.toLowerCase(),
      await bcrypt.hash(password, 10),
    ]);
    await c.query('COMMIT');
    return true;
  } catch (e) {
    await c.query('ROLLBACK');
    throw e;
  } finally {
    c.release();
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  (async () => {
    const email = process.env.ADMIN_EMAIL || 'root@kx.local';
    const created = await createFirstSuperAdmin(email, await readStdin());
    console.log(created ? `first super admin "${email}" created` : 'the database already has users: nothing changed');
    await pool.end();
  })().catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  });
}
