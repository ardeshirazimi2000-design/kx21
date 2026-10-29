// Demo data: staff accounts, a few doctors and a rolling 7-day calendar. Idempotent — safe on
// every start; tops up future slots when they run low.
import { uuid, nowIso } from './lib/db.js';

export const DEMO_ACCOUNTS = {
  admin: { phone: '09120000010', full_name: 'مدیر سامانه' },
  operator: { phone: '09120000009', full_name: 'اپراتور پشتیبانی' },
  doctors: [
    { phone: '09120000001', full_name: 'دکتر سارا احمدی', specialty: 'general', license_no: 'N-100201', bio: 'پزشک عمومی با ۱۲ سال سابقه' },
    { phone: '09120000002', full_name: 'دکتر رضا کریمی', specialty: 'cardiology', license_no: 'N-100202', bio: 'متخصص قلب و عروق' },
    { phone: '09120000003', full_name: 'دکتر مریم رضایی', specialty: 'dermatology', license_no: 'N-100203', bio: 'متخصص پوست و مو' },
    { phone: '09120000004', full_name: 'دکتر علی موسوی', specialty: 'pediatrics', license_no: 'N-100204', bio: 'متخصص کودکان' },
    { phone: '09120000005', full_name: 'دکتر نگار حسینی', specialty: 'psychiatry', license_no: 'N-100205', bio: 'روان‌پزشک' },
    { phone: '09120000006', full_name: 'دکتر حمید نوری', specialty: 'gastroenterology', license_no: 'N-100206', bio: 'فوق تخصص گوارش' },
    { phone: '09120000007', full_name: 'دکتر لیلا صادقی', specialty: 'ent', license_no: 'N-100207', bio: 'متخصص گوش، حلق و بینی' },
    { phone: '09120000008', full_name: 'دکتر بهرام شریفی', specialty: 'neurology', license_no: 'N-100208', bio: 'متخصص مغز و اعصاب' },
  ],
};

const TEHRAN_OFFSET_MIN = 210; // UTC+03:30
const DAILY_HOURS = [9, 10, 11, 17, 18, 19];

export function seed({ db, config, domain }) {
  const t = config.defaultTenant;
  const exists = (phone) => db.get('SELECT id FROM users WHERE tenant_id = ? AND phone = ?', t, phone);
  for (const role of ['admin', 'operator']) {
    const a = DEMO_ACCOUNTS[role];
    if (!exists(a.phone)) {
      db.run('INSERT INTO users (id, tenant_id, role, phone, full_name, email, created_at) VALUES (?,?,?,?,?,?,?)',
        uuid(), t, role, a.phone, a.full_name, `${role}@example.ir`, nowIso());
    }
  }
  for (const d of DEMO_ACCOUNTS.doctors) {
    if (!exists(d.phone)) domain.patient.createDoctor(t, { ...d, email: `${d.license_no.toLowerCase()}@example.ir` });
  }

  // Rolling calendar.
  const doctors = db.all('SELECT id FROM doctors WHERE tenant_id = ? AND deleted_at IS NULL', t);
  const now = Date.now();
  for (const { id } of doctors) {
    const future = db.get('SELECT COUNT(*) AS n FROM slots WHERE doctor_id = ? AND starts_at > ?', id, nowIso()).n;
    if (future >= 15) continue;
    const starts = [];
    // Two near-term slots so the visit room can be tried right away.
    const soon = Math.ceil((now + 5 * 60000) / (5 * 60000)) * 5 * 60000;
    starts.push(soon, soon + 30 * 60000);
    for (let day = 0; day < 7; day++) {
      const base = new Date(now + day * 864e5);
      for (const h of DAILY_HOURS) {
        // Local Tehran wall time → UTC.
        const local = Date.UTC(base.getUTCFullYear(), base.getUTCMonth(), base.getUTCDate(), h, 0) - TEHRAN_OFFSET_MIN * 60000;
        if (local > now + 60 * 60000) starts.push(local);
      }
    }
    db.tx(() => {
      for (const s of starts) {
        const sIso = new Date(s).toISOString();
        const eIso = new Date(s + 30 * 60000).toISOString();
        const overlap = db.get('SELECT 1 FROM slots WHERE doctor_id = ? AND starts_at < ? AND ends_at > ?', id, eIso, sIso);
        if (!overlap) db.run('INSERT INTO slots (id, tenant_id, doctor_id, starts_at, ends_at) VALUES (?,?,?,?,?)', uuid(), t, id, sIso, eIso);
      }
    });
  }
}

// Production: make sure the real administrator exists and that demo accounts (fake numbers)
// can neither log in nor be booked. Their data is kept, only disabled.
export function bootstrapProduction({ db, config }) {
  const t = config.defaultTenant;
  const admin = String(config.adminPhone ?? '').trim();
  if (admin) {
    const u = db.get('SELECT id, role FROM users WHERE tenant_id = ? AND phone = ?', t, admin);
    if (!u) {
      db.run('INSERT INTO users (id, tenant_id, role, phone, full_name, created_at) VALUES (?,?,?,?,?,?)', uuid(), t, 'admin', admin, 'مدیر سامانه', nowIso());
    } else if (u.role === 'patient' && config.adminTakeover) {
      // The owner signed up as a patient with their own number first (ADMIN_TAKEOVER=1 confirms it).
      db.run("UPDATE users SET role = 'admin', staff_role_id = NULL, disabled_at = NULL, deleted_at = NULL WHERE id = ?", u.id);
      console.warn(`[bootstrap] ADMIN_PHONE ${admin}: patient account converted to administrator`);
    } else if (u.role !== 'admin') {
      console.warn(`[bootstrap] ADMIN_PHONE ${admin} already belongs to a ${u.role} account; not changed`
        + (u.role === 'patient' ? ' (re-run the installer with ADMIN_TAKEOVER=1 to make it the administrator)' : ''));
    } else {
      db.run('UPDATE users SET deleted_at = NULL WHERE id = ?', u.id);
    }
  }
  const demo = [DEMO_ACCOUNTS.admin.phone, DEMO_ACCOUNTS.operator.phone, ...DEMO_ACCOUNTS.doctors.map((d) => d.phone)].filter((ph) => ph !== admin);
  const now = nowIso();
  for (const phone of demo) {
    const u = db.get('SELECT id FROM users WHERE tenant_id = ? AND phone = ? AND deleted_at IS NULL', t, phone);
    if (!u) continue;
    db.run('UPDATE users SET deleted_at = ? WHERE id = ?', now, u.id);
    db.run('UPDATE doctors SET deleted_at = ? WHERE user_id = ? AND deleted_at IS NULL', now, u.id);
  }
}
