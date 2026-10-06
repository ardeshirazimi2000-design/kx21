/**
 * Development seed data. Creates one chamber, an active term, two commissions with officers
 * and members, an upcoming meeting with agenda and a past meeting with resolutions.
 * All accounts use the password printed at the end.
 */
import bcrypt from 'bcryptjs';
import { DEFAULT_COMMISSION_SETTINGS } from '@kx/shared';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { migrate } from './migrate.js';
import { pool } from './pool.js';

export const SEED_PASSWORD = 'Passw0rd!';

export async function seed() {
  await migrate(false);
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    const exists = await c.query(`SELECT 1 FROM users WHERE email = 'admin@kx.local'`);
    if (exists.rowCount) {
      console.log('seed data already present');
      await c.query('ROLLBACK');
      return;
    }
    const hash = await bcrypt.hash(SEED_PASSWORD, 10);
    const ins = async (sql: string, params: unknown[]) => (await c.query(sql, params)).rows[0];

    const chamber = await ins(
      `INSERT INTO chambers (name, province, phone, email, address) VALUES ($1,$2,$3,$4,$5) RETURNING id`,
      ['اتاق بازرگانی، صنایع، معادن و کشاورزی استان نمونه', 'استان نمونه', '021-00000000', 'info@chamber.local', 'خیابان نمونه، پلاک ۱'],
    );
    const person = async (fullName: string, email: string, mobile: string, org: string, opts: { superAdmin?: boolean } = {}) =>
      (
        await ins(
          `INSERT INTO users (chamber_id, full_name, email, mobile, organization, password_hash, is_super_admin) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
          [opts.superAdmin ? null : chamber.id, fullName, email, mobile, org, hash, !!opts.superAdmin],
        )
      ).id as string;

    const superAdmin = await person('مدیر سامانه', 'root@kx.local', '09120000000', 'واحد فناوری', { superAdmin: true });
    const admin = await person('مدیر اتاق', 'admin@kx.local', '09120000001', 'دبیرخانه اتاق');
    await c.query('INSERT INTO chamber_admins (chamber_id, user_id) VALUES ($1,$2)', [chamber.id, admin]);
    const chair = await person('دکتر علی رضایی', 'chair@kx.local', '09120000002', 'شرکت صنایع غذایی آریا');
    const vice = await person('مهندس مریم احمدی', 'vice@kx.local', '09120000003', 'گروه صنعتی پارس');
    const secretary = await person('حسین کریمی', 'secretary@kx.local', '09120000004', 'دبیرخانه کمیسیون');
    const members: string[] = [];
    const names = ['زهرا محمدی', 'رضا حسینی', 'فاطمه نوری', 'امیر جعفری', 'سارا موسوی', 'محمد صادقی'];
    for (let i = 0; i < names.length; i++) {
      members.push(await person(names[i], `member${i + 1}@kx.local`, `0912000001${i}`, `شرکت عضو ${i + 1}`));
    }
    const expert = await person('کارشناس اقتصادی', 'expert@kx.local', '09120000020', 'معاونت بررسی‌های اقتصادی');
    const guest = await person('نماینده سازمان توسعه تجارت', 'guest@kx.local', '09120000021', 'سازمان توسعه تجارت');

    const term = await ins(
      `INSERT INTO terms (chamber_id, number, title, start_date, status) VALUES ($1, 10, 'دوره دهم', '2023-04-21', 'active') RETURNING id`,
      [chamber.id],
    );
    const commission = await ins(
      `INSERT INTO commissions (chamber_id, term_id, name, code, domain, settings) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
      [chamber.id, term.id, 'کمیسیون صادرات و تجارت خارجی', 'EXP', 'صادرات، گمرک و تجارت بین‌الملل', JSON.stringify(DEFAULT_COMMISSION_SETTINGS)],
    );
    const commission2 = await ins(
      `INSERT INTO commissions (chamber_id, term_id, name, code, domain, settings) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
      [chamber.id, term.id, 'کمیسیون انرژی و محیط زیست', 'ENR', 'انرژی، آب و محیط زیست', JSON.stringify({ ...DEFAULT_COMMISSION_SETTINGS, quorum: { ...DEFAULT_COMMISSION_SETTINGS.quorum, type: 'two_thirds' } })],
    );
    const member = (commissionId: string, userId: string, position: string, hasVote: boolean) =>
      c.query(
        `INSERT INTO commission_memberships (chamber_id, commission_id, user_id, position, has_vote, start_date) VALUES ($1,$2,$3,$4,$5,'2023-04-21')`,
        [chamber.id, commissionId, userId, position, hasVote],
      );
    await member(commission.id, chair, 'chair', true);
    await member(commission.id, vice, 'vice_chair', true);
    await member(commission.id, secretary, 'secretary', false);
    for (const m of members) await member(commission.id, m, 'member', true);
    await member(commission.id, expert, 'expert', false);
    await member(commission2.id, vice, 'chair', true);
    await member(commission2.id, secretary, 'secretary', false);
    for (const m of members.slice(0, 4)) await member(commission2.id, m, 'member', true);

    // Upcoming meeting (tomorrow 10:00), invitations sent.
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    tomorrow.setHours(10, 0, 0, 0);
    const meeting = await ins(
      `INSERT INTO meetings (chamber_id, commission_id, number, title, scheduled_at, location, type, status, created_by)
       VALUES ($1,$2,13,'بررسی موانع صادرات محصولات کشاورزی',$3,'سالن جلسات طبقه سوم اتاق','hybrid','invitation_sent',$4) RETURNING id`,
      [chamber.id, commission.id, tomorrow, secretary],
    );
    await c.query(
      `INSERT INTO meeting_invitees (meeting_id, user_id, role, has_vote, invited_at)
       SELECT $1, user_id, position, has_vote, now() FROM commission_memberships WHERE commission_id = $2 AND position <> 'expert'`,
      [meeting.id, commission.id],
    );
    await c.query(`INSERT INTO meeting_invitees (meeting_id, user_id, role, has_vote, invited_at) VALUES ($1,$2,'guest',false,now())`, [meeting.id, guest]);
    await c.query(`INSERT INTO attendance (meeting_id, user_id) SELECT meeting_id, user_id FROM meeting_invitees WHERE meeting_id = $1`, [meeting.id]);
    const items = [
      ['گزارش دبیر از پیگیری مصوبات جلسه قبل', 'normal'],
      ['بررسی مشکلات رفع تعهد ارزی صادرکنندگان', 'high'],
      ['پیشنهاد تشکیل کارگروه صادرات به کشورهای همسایه', 'normal'],
    ];
    for (let i = 0; i < items.length; i++) {
      await c.query(
        `INSERT INTO agenda_items (chamber_id, meeting_id, order_no, title, priority, duration_minutes, presenter_id) VALUES ($1,$2,$3,$4,$5,20,$6)`,
        [chamber.id, meeting.id, i + 1, items[i][0], items[i][1], i === 0 ? secretary : chair],
      );
    }

    // A past, approved meeting with resolutions (one overdue).
    const past = new Date();
    past.setDate(past.getDate() - 30);
    past.setHours(10, 0, 0, 0);
    const pastMeeting = await ins(
      `INSERT INTO meetings (chamber_id, commission_id, number, title, scheduled_at, location, status, started_at, ended_at, created_by)
       VALUES ($1,$2,12,'جلسه عادی ماهانه',$3,'سالن جلسات','approved',$3,$3::timestamptz + interval '90 minutes',$4) RETURNING id`,
      [chamber.id, commission.id, past, secretary],
    );
    await c.query(
      `INSERT INTO minutes (chamber_id, meeting_id, minutes_number, body, status, approved_by, approved_at)
       VALUES ($1,$2,'EXP/1405/12','# صورتجلسه نمونه\n\nاین صورتجلسه به‌عنوان داده نمونه ثبت شده است.','approved',$3,now())`,
      [chamber.id, pastMeeting.id, chair],
    );
    const res1 = await ins(
      `INSERT INTO resolutions (chamber_id, commission_id, meeting_id, number, text, owner_id, addressee, due_date, priority, status, progress, created_by)
       VALUES ($1,$2,$3,'EXP-001','مکاتبه با بانک مرکزی درباره تمدید مهلت رفع تعهد ارزی صادرکنندگان خرد',$4,'بانک مرکزی',current_date - 5,'high','in_progress',40,$5) RETURNING id, owner_id, due_date`,
      [chamber.id, commission.id, pastMeeting.id, secretary, secretary],
    );
    const res2 = await ins(
      `INSERT INTO resolutions (chamber_id, commission_id, meeting_id, number, text, owner_id, addressee, due_date, status, created_by)
       VALUES ($1,$2,$3,'EXP-002','تهیه گزارش کارشناسی از ظرفیت‌های صادراتی استان به عراق',$4,'معاونت بررسی‌ها',current_date + 20,'open',$5) RETURNING id, owner_id, due_date`,
      [chamber.id, commission.id, pastMeeting.id, members[0], secretary],
    );
    for (const r of [res1, res2]) {
      await c.query(`INSERT INTO tasks (chamber_id, resolution_id, title, assignee_id, due_date) VALUES ($1,$2,'اجرای مصوبه',$3,$4)`, [
        chamber.id, r.id, r.owner_id, r.due_date,
      ]);
    }
    await c.query(
      `INSERT INTO issues (chamber_id, commission_id, title, description, created_by) VALUES ($1,$2,$3,$4,$5)`,
      [chamber.id, commission.id, 'افزایش هزینه‌های حمل‌ونقل صادراتی', 'گزارش اعضا از افزایش ۴۰ درصدی کرایه حمل جاده‌ای', members[1]],
    );
    await c.query('COMMIT');
    console.log('Seed complete. Accounts (password: %s):', SEED_PASSWORD);
    console.table([
      ['root@kx.local', 'Super Admin'],
      ['admin@kx.local', 'Chamber Admin'],
      ['chair@kx.local', 'رئیس کمیسیون صادرات'],
      ['secretary@kx.local', 'دبیر'],
      ['member1@kx.local … member6@kx.local', 'اعضا'],
      ['expert@kx.local', 'کارشناس'],
      ['guest@kx.local', 'مدعو'],
    ]);
    void superAdmin;
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
