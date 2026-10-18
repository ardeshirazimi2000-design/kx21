/**
 * Demo data: organisation chart of a chamber, users for every stakeholder, archive folders.
 * Password of all accounts: Passw0rd!  (emails match the meetings demo accounts, so participants map automatically)
 */
import bcrypt from 'bcryptjs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ensureBaseData } from './bootstrap.js';
import { migrate } from './migrate.js';
import { pool } from './pool.js';

export const SEED_PASSWORD = 'Passw0rd!';

export async function seed() {
  await migrate(false);
  await ensureBaseData();
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    if ((await c.query(`SELECT 1 FROM users WHERE username = 'admin'`)).rowCount) {
      await c.query('ROLLBACK');
      console.log('seed data already present');
      return;
    }
    const hash = await bcrypt.hash(SEED_PASSWORD, 10);
    const one = async (sql: string, params: unknown[]) => (await c.query(sql, params)).rows[0];
    const unit = async (name: string, code: string, kind: string, parentId: string | null = null) =>
      (await one(`INSERT INTO org_units (parent_id, name, code, kind) VALUES ($1,$2,$3,$4) RETURNING id`, [parentId, name, code, kind])).id as string;
    const position = async (unitId: string, title: string, isManager = false, parentId: string | null = null) =>
      (await one(`INSERT INTO positions (unit_id, title, is_manager, parent_id) VALUES ($1,$2,$3,$4) RETURNING id`, [unitId, title, isManager, parentId])).id as string;
    const role = async (key: string) => (await one(`SELECT id FROM roles WHERE key = $1`, [key])).id as string;
    const user = async (username: string, fullName: string, opts: { email?: string; mobile?: string; nationalId?: string; clearance?: number; positionId?: string; roles?: [string, string | null][] }) => {
      const u = await one(
        `INSERT INTO users (username, full_name, email, mobile, national_id, password_hash, clearance) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
        [username, fullName, opts.email ?? null, opts.mobile ?? null, opts.nationalId ?? null, hash, opts.clearance ?? 0],
      );
      if (opts.positionId) await c.query(`INSERT INTO user_positions (user_id, position_id, is_primary) VALUES ($1,$2,true)`, [u.id, opts.positionId]);
      for (const [r, scope] of opts.roles ?? []) await c.query(`INSERT INTO user_roles (user_id, role_id, scope_unit_id) VALUES ($1,$2,$3)`, [u.id, await role(r), scope]);
      return u.id as string;
    };

    // ساختار سازمانی
    const presidency = await unit('ریاست اتاق', 'PRS', 'presidency');
    const deputy = await unit('معاونت امور اعضا و تشکل‌ها', 'DEP-M', 'deputy', presidency);
    const secretariat = await unit('دبیرخانه مرکزی', 'SEC', 'secretariat', presidency);
    const commissions = await unit('اداره امور کمیسیون‌ها', 'CMS', 'department', deputy);
    const research = await unit('مرکز پژوهش‌ها و بررسی‌های اقتصادی', 'RES', 'department', presidency);
    const it = await unit('واحد فناوری اطلاعات', 'IT', 'office', presidency);

    const pPresident = await position(presidency, 'رئیس اتاق', true);
    const pDeputy = await position(deputy, 'معاون امور اعضا', true, pPresident);
    const pSecHead = await position(secretariat, 'رئیس دبیرخانه', true, pPresident);
    const pSecClerk = await position(secretariat, 'کارشناس دبیرخانه', false, pSecHead);
    const pCmsHead = await position(commissions, 'مدیر امور کمیسیون‌ها', true, pDeputy);
    const pCmsExpert = await position(commissions, 'کارشناس امور کمیسیون‌ها', false, pCmsHead);
    const pResHead = await position(research, 'رئیس مرکز پژوهش‌ها', true, pPresident);
    const pResExpert = await position(research, 'کارشناس اقتصادی', false, pResHead);
    const pIt = await position(it, 'مسئول فناوری اطلاعات', true, pPresident);

    await user('admin', 'مدیر سیستم', { email: 'admin@office.local', clearance: 2, roles: [['admin', null]], positionId: pIt });
    await user('president', 'دکتر محمد رستمی', { email: 'president@office.local', mobile: '09121000001', clearance: 2, positionId: pPresident, roles: [['president', null]] });
    await user('deputy', 'مهندس سعید فرهادی', { email: 'deputy@office.local', clearance: 1, positionId: pDeputy, roles: [['manager', deputy]] });
    await user('sechead', 'لیلا کاظمی', { email: 'sechead@office.local', clearance: 1, positionId: pSecHead, roles: [['secretariat', null], ['manager', secretariat]] });
    await user('clerk', 'نرگس امینی', { email: 'clerk@office.local', positionId: pSecClerk, roles: [['secretariat', null]] });
    // Same e-mail as the meetings demo secretary/chair → mapped automatically (نگاشت شرکت‌کنندگان).
    await user('cmshead', 'حسین کریمی', { email: 'secretary@kx.local', mobile: '09120000004', positionId: pCmsHead, roles: [['manager', commissions]] });
    await user('cmsexpert', 'زهرا محمدی', { email: 'member1@kx.local', positionId: pCmsExpert, roles: [['expert', null]] });
    await user('reshead', 'دکتر علی رضایی', { email: 'chair@kx.local', positionId: pResHead, roles: [['manager', research]] });
    await user('expert', 'کارشناس اقتصادی', { email: 'expert@kx.local', positionId: pResExpert, roles: [['expert', null]] });
    await user('it', 'مسئول فناوری', { email: 'it@office.local', positionId: pIt, roles: [['it', null]] });

    // بایگانی
    const root = (await one(`INSERT INTO archive_folders (name, code) VALUES ('مکاتبات', 'LTR') RETURNING id`, [])).id;
    const policy = (await one(`SELECT id FROM retention_policies WHERE retain_years = 5`, [])).id;
    for (const [u, name, code] of [[secretariat, 'دبیرخانه مرکزی', 'SEC'], [commissions, 'اداره امور کمیسیون‌ها', 'CMS'], [research, 'مرکز پژوهش‌ها و بررسی‌های اقتصادی', 'RES']] as const) {
      await c.query(`INSERT INTO archive_folders (parent_id, name, code, unit_id, retention_policy_id) VALUES ($1,$2,$3,$4,$5)`, [root, name, code, u, policy]);
    }
    const contracts = (await one(`INSERT INTO archive_folders (name, code) VALUES ('قراردادها', 'CTR') RETURNING id`, [])).id;
    await c.query(`INSERT INTO archive_folders (parent_id, name, code, retention_policy_id) VALUES ($1, 'قراردادهای ۱۴۰۵', 'CTR-1405', (SELECT id FROM retention_policies WHERE retain_years = 10))`, [contracts]);

    await c.query(`INSERT INTO integrations (kind, name, settings, is_active) VALUES ('meetings', 'سامانه جلسات کمیسیون‌ها', $1, false)`, [
      JSON.stringify({ resolutionWorkflowKey: 'resolution-followup', defaultUnitId: commissions, autoFeedback: true, auth: 'apikey' }),
    ]);
    await c.query('COMMIT');
    console.table([
      ['admin', 'مدیر سیستم'], ['president', 'رئیس اتاق'], ['deputy', 'معاون'], ['sechead / clerk', 'دبیرخانه'],
      ['cmshead / cmsexpert', 'امور کمیسیون‌ها'], ['reshead / expert', 'مرکز پژوهش‌ها'], ['it', 'فناوری اطلاعات'],
    ]);
    console.log(`password for all accounts: ${SEED_PASSWORD}`);
  } catch (e) {
    await c.query('ROLLBACK');
    throw e;
  } finally {
    c.release();
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  seed()
    .then(() => pool.end())
    .catch((e) => {
      console.error(e);
      process.exit(1);
    });
}
