/**
 * Initial data:
 *   npm run seed               → districts + first security administrator (from BOOTSTRAP_* env, Shahkar-verified)
 *   npm run seed -- --demo     → also one demo user per role (mock api.ir only, never in production)
 */
import { config } from '../config.js';
import { audit } from '../lib/audit.js';
import { isValidNationalCode, normalizeMobile } from '../lib/identity.js';
import { setPassword, temporaryPassword } from '../security/password.js';
import { requireShahkarMatch } from '../services/shahkar.js';
import { migrate } from './migrate.js';
import { one, pool, tx } from './pool.js';

const PERSIAN = '۰۱۲۳۴۵۶۷۸۹';
const fa = (n: number) => String(n).replace(/\d/g, (d) => PERSIAN[Number(d)]);

export async function seedDistricts(count = 22): Promise<void> {
  for (let i = 1; i <= count; i++) {
    await pool.query('INSERT INTO districts (id, code, name) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING', [i, `D${String(i).padStart(2, '0')}`, `منطقه ${fa(i)}`]);
  }
  await pool.query(`SELECT setval('districts_id_seq', (SELECT max(id) FROM districts))`);
}

interface NewStaff {
  nationalCode: string;
  mobile: string;
  firstName: string;
  lastName: string;
  username?: string;
  roles: string[];
  districtId?: number | null;
  organization?: string;
  password?: string;
  mustChange?: boolean;
}

export async function createStaff(s: NewStaff): Promise<string> {
  return tx(async (db) => {
    const u = await one<{ id: string }>(
      `INSERT INTO users (national_code, mobile, first_name, last_name, kind, organization, district_id, username, console_access, app_access, shahkar_verified_at)
       VALUES ($1,$2,$3,$4,'staff',$5,$6,$7,$8,true,now()) RETURNING id`,
      [s.nationalCode, s.mobile, s.firstName, s.lastName, s.organization ?? null, s.districtId ?? null, s.username ?? null, !!s.username],
      db,
    );
    if (s.username) await setPassword(db, u!.id, s.password ?? temporaryPassword(), s.mustChange ?? true);
    for (const r of s.roles) await db.query('INSERT INTO user_roles (user_id, role_key) VALUES ($1,$2)', [u!.id, r]);
    return u!.id;
  });
}

async function bootstrapAdmin(): Promise<void> {
  if (await one(`SELECT 1 FROM user_roles WHERE role_key = 'security_admin'`)) return;
  const nc = process.env.BOOTSTRAP_ADMIN_NATIONAL_CODE ?? '';
  const mobile = normalizeMobile(process.env.BOOTSTRAP_ADMIN_MOBILE ?? '');
  const username = (process.env.BOOTSTRAP_ADMIN_USERNAME ?? 'secadmin').toLowerCase();
  if (!isValidNationalCode(nc) || !mobile) {
    console.log('⚠ مدیر امنیت تعریف نشده است. BOOTSTRAP_ADMIN_NATIONAL_CODE و BOOTSTRAP_ADMIN_MOBILE را تنظیم و seed را دوباره اجرا کنید.');
    return;
  }
  await requireShahkarMatch({ nationalCode: nc, mobile, context: 'console_user_create' });
  const password = temporaryPassword();
  const id = await createStaff({
    nationalCode: nc,
    mobile,
    firstName: process.env.BOOTSTRAP_ADMIN_FIRST_NAME ?? 'مدیر',
    lastName: process.env.BOOTSTRAP_ADMIN_LAST_NAME ?? 'امنیت',
    username,
    roles: ['security_admin'],
    password,
  });
  await audit({ action: 'bootstrap.security_admin', targetType: 'user', targetId: id, details: { username } });
  console.log(`✔ مدیر امنیت ایجاد شد. نام کاربری: ${username} — رمز موقت (یک‌بار نمایش): ${password}`);
}

/** Valid-checksum national code derived from a 9-digit prefix (demo data only). */
function demoNationalCode(prefix: string): string {
  const d = prefix.split('').map(Number);
  const s = d.reduce((a, x, i) => a + x * (10 - i), 0) % 11;
  return prefix + String(s < 2 ? s : 11 - s);
}

async function demo(): Promise<void> {
  if (config.NODE_ENV === 'production' || config.APIIR_MODE !== 'mock') throw new Error('demo data is only allowed with the mock api.ir gateway');
  const password = 'Demo-Pass-1234!';
  const people: [string, string, string, string[], number | null][] = [
    ['security', 'مریم', 'رضایی', ['security_admin'], null],
    ['auditor', 'حسین', 'کریمی', ['security_auditor'], null],
    ['sysadmin', 'علی', 'احمدی', ['system_admin'], null],
    ['director', 'محمد', 'موسوی', ['crisis_director'], null],
    ['opschief', 'زهرا', 'حسینی', ['operations_chief'], null],
    ['operator', 'سارا', 'محمدی', ['operator'], null],
    ['district3', 'رضا', 'نوری', ['district_coordinator'], 3],
    ['observer', 'نرگس', 'جعفری', ['observer'], null],
    ['responder', 'امیر', 'صادقی', ['responder'], 3],
  ];
  let i = 0;
  for (const [username, first, last, roles, district] of people) {
    i++;
    if (await one('SELECT 1 FROM users WHERE username = $1', [username])) continue;
    const nc = demoNationalCode(`00${String(1000000 + i)}`.slice(0, 9));
    await createStaff({
      nationalCode: nc,
      mobile: `0912000${String(1000 + i).slice(-4)}`,
      firstName: first,
      lastName: last,
      username: roles.includes('responder') ? undefined : username,
      roles,
      districtId: district,
      organization: 'سازمان پیشگیری و مدیریت بحران',
      password,
      mustChange: false,
    });
    console.log(`  ${username.padEnd(10)} ${roles.join(',').padEnd(22)} کد ملی ${nc}  موبایل 0912000${String(1000 + i).slice(-4)}`);
  }
  console.log(`✔ کاربران نمایشی (رمز کنسول: ${password}) — کد OTP در حالت mock در لاگ سرور چاپ می‌شود.`);
}

async function main() {
  await migrate();
  await seedDistricts();
  if (process.argv.includes('--demo')) await demo();
  await bootstrapAdmin();
}

if (process.argv[1]?.endsWith('seed.ts') || process.argv[1]?.endsWith('seed.js')) {
  main()
    .then(() => pool.end())
    .catch(async (e) => {
      console.error(e);
      await pool.end();
      process.exit(1);
    });
}
