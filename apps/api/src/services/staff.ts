import { one, pool, query, type Db } from '../db/pool.js';
import { conflict } from '../lib/errors.js';

/**
 * Administrative roles and their separation (AFTA): the security auditor never also administers the system or a
 * chamber, so administrators' actions are reviewed by someone else.
 *   system_it      مدیر فناوری اطلاعات سامانه (users.is_super_admin)
 *   chamber_admin  مدیر اتاق (chamber_admins): the chamber's processes
 *   it_admin       مدیر فناوری اطلاعات اتاق: the chamber's logins and roles
 *   auditor        ممیز امنیت (of one chamber, or of all)
 *   national       دبیرخانهٔ ملی (اتاق ایران)
 */
export const STAFF_ROLES = ['system_it', 'chamber_admin', 'it_admin', 'auditor', 'national'] as const;
export type StaffRole = (typeof STAFF_ROLES)[number];
export const ADMIN_ROLES: readonly StaffRole[] = ['system_it', 'chamber_admin', 'it_admin'];

export const STAFF_ROLE_LABELS: Record<StaffRole, string> = {
  system_it: 'مدیر فناوری اطلاعات سامانه',
  chamber_admin: 'مدیر اتاق',
  it_admin: 'مدیر فناوری اطلاعات اتاق',
  auditor: 'ممیز امنیت',
  national: 'دبیرخانهٔ ملی',
};

export interface StaffRow {
  userId: string;
  fullName: string;
  email: string | null;
  role: StaffRole;
  chamberId: string | null;
  chamberName: string | null;
  grantedAt: string | null;
}

export async function listStaff(db: Db = pool): Promise<StaffRow[]> {
  return query<StaffRow>(
    `SELECT u.id AS "userId", u.full_name AS "fullName", u.email, 'system_it' AS role, NULL::uuid AS "chamberId", NULL AS "chamberName", NULL::timestamptz AS "grantedAt"
       FROM users u WHERE u.is_super_admin
     UNION ALL
     SELECT u.id, u.full_name, u.email, 'chamber_admin', c.id, c.name, a.created_at
       FROM chamber_admins a JOIN users u ON u.id = a.user_id JOIN chambers c ON c.id = a.chamber_id
     UNION ALL
     SELECT u.id, u.full_name, u.email, s.role, c.id, c.name, s.granted_at
       FROM staff_roles s JOIN users u ON u.id = s.user_id LEFT JOIN chambers c ON c.id = s.chamber_id
     ORDER BY 2, 4`,
    [],
    db,
  );
}

/** The roles a person holds now. */
export async function rolesOf(db: Db, userId: string): Promise<StaffRow[]> {
  return (await listStaff(db)).filter((r) => r.userId === userId);
}

/** An auditor may not be made an administrator. */
export async function assertNotAuditor(db: Db, userId: string): Promise<void> {
  if (await one(`SELECT 1 FROM staff_roles WHERE user_id = $1 AND role = 'auditor'`, [userId], db)) {
    throw conflict('این شخص ممیز امنیت است و طبق اصل تفکیک وظایف نمی‌تواند نقش مدیریتی هم داشته باشد', 'separation_of_duties');
  }
}

/** An administrator may not be made an auditor. */
export async function assertNotAdmin(db: Db, userId: string): Promise<void> {
  const held = (await rolesOf(db, userId)).filter((r) => ADMIN_ROLES.includes(r.role));
  if (held.length) {
    throw conflict(
      `این شخص «${STAFF_ROLE_LABELS[held[0].role]}» است و طبق اصل تفکیک وظایف نمی‌تواند ممیز امنیت هم باشد`,
      'separation_of_duties',
    );
  }
}

/** Advice shown with the role list: what still leaves duties combined. */
export function separationWarnings(rows: StaffRow[]): string[] {
  const out: string[] = [];
  if (!rows.some((r) => r.role === 'auditor')) out.push('هنوز ممیز امنیت تعیین نشده است؛ رویدادنگاری را تنها ممیز امنیت می‌بیند.');
  const byUser = new Map<string, StaffRow[]>();
  for (const r of rows) byUser.set(r.userId, [...(byUser.get(r.userId) ?? []), r]);
  for (const list of byUser.values()) {
    const has = (role: StaffRole) => list.some((r) => r.role === role);
    if (has('system_it') && (has('chamber_admin') || has('national'))) {
      out.push(`${list[0].fullName} هم مدیر فناوری اطلاعات سامانه است و هم در فرآیندها نقش دارد؛ این نقش‌ها را به اشخاص جدا بسپارید.`);
    } else {
      const both = list.filter((r) => r.role === 'chamber_admin').filter((r) => list.some((x) => x.role === 'it_admin' && x.chamberId === r.chamberId));
      if (both.length) out.push(`${list[0].fullName} در ${both.map((r) => r.chamberName).join('، ')} هم مدیر اتاق است و هم مدیر فناوری اطلاعات اتاق.`);
    }
  }
  return out;
}
