/**
 * Upgrade an existing installation:  npm run upgrade   (production: node dist/db/upgrade.js)
 *  1. refuses to continue while any user holds more than one role (the new schema allows exactly one);
 *  2. applies pending migrations and re-synchronises the locked security roles;
 *  3. seals incident records created before integrity seals existed, and records that in the audit trail.
 * Run it with the schema owner account, after a database backup.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { audit } from '../lib/audit.js';
import { sealIncident } from '../services/integrity.js';
import { migrate } from './migrate.js';
import { pool, query } from './pool.js';

async function main() {
  const hasRoles = await query(`SELECT 1 FROM information_schema.tables WHERE table_name = 'user_roles'`);
  if (hasRoles.length) {
    const multi = await query<{ username: string | null; name: string; roles: string[] }>(
      `SELECT u.username, u.first_name || ' ' || u.last_name AS name, array_agg(ur.role_key) AS roles
         FROM user_roles ur JOIN users u ON u.id = ur.user_id GROUP BY u.id HAVING count(*) > 1`,
    );
    if (multi.length) {
      console.error('✗ این کاربران بیش از یک نقش دارند؛ در نسخه جدید هر کاربر فقط یک نقش دارد. ابتدا با نسخه فعلی کنسول برای هر کدام یک نقش نگه دارید:');
      for (const m of multi) console.error(`   - ${m.name} (${m.username ?? 'بدون نام کاربری'}): ${m.roles.join('، ')}`);
      process.exitCode = 1;
      return;
    }
  }
  await migrate();
  console.log('✔ مهاجرت پایگاه داده انجام شد');

  const legacy = await query<{ id: string }>('SELECT id FROM incidents WHERE integrity_mac IS NULL');
  for (const r of legacy) await sealIncident(r.id);
  await audit({ action: 'upgrade.applied', details: { sealedLegacyIncidents: legacy.length } });
  console.log(`✔ ${legacy.length} رکورد حادثه قدیمی مهر صحت گرفت`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main()
    .catch((e) => {
      console.error(e);
      process.exitCode = 1;
    })
    .finally(() => pool.end());
}
