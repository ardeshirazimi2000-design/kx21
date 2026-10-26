/**
 * Creates the first administrator of an empty installation (no demo data). The password is read from standard
 * input (first line), so it is never in the process list, the container environment or a log:
 *
 *   ADMIN_USERNAME=admin node dist/db/create-admin.js < password-file
 *
 * Does nothing when the database already has users.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createFirstAdmin, ensureBaseData } from './bootstrap.js';
import { migrate } from './migrate.js';
import { pool, tx } from './pool.js';

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) throw new Error('pipe the password on standard input');
  let s = '';
  for await (const chunk of process.stdin) s += chunk;
  return s.split(/\r?\n/)[0];
}

export async function createAdminFromInput(username: string, password: string) {
  await migrate(false);
  await ensureBaseData();
  return tx((c) => createFirstAdmin(c, username, password));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  (async () => {
    const username = process.env.ADMIN_USERNAME || 'admin';
    const created = await createAdminFromInput(username, await readStdin());
    console.log(created ? `first administrator "${username}" created` : 'the database already has users: nothing changed');
    await pool.end();
  })().catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  });
}
