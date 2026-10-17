import bcrypt from 'bcryptjs';
import { logger } from '../lib/logger.js';
import { PERMISSIONS, SYSTEM_ROLES } from '../services/permissions.js';
import type { WorkflowDefinition } from '../services/workflow.js';
import { tx } from './pool.js';

/** Built-in workflows created on first start (editable afterwards; edits create new versions). */
export const DEFAULT_WORKFLOWS: { key: string; name: string; description: string; appliesTo: string[]; definition: WorkflowDefinition }[] = [
  {
    key: 'resolution-followup',
    name: 'پیگیری اجرای مصوبه کمیسیون',
    description: 'برای هر مصوبه دریافتی از سامانه جلسات: اقدام مسئول اجرا، تأیید مدیر واحد، بازخورد خودکار به سامانه جلسات',
    appliesTo: ['internal'],
    definition: {
      steps: [
        { key: 'execute', name: 'اقدام مسئول اجرا', type: 'review', assignee: { kind: 'context_user', value: 'ownerUserId' }, slaHours: 120 },
        { key: 'approve', name: 'تأیید مدیر واحد', type: 'approve', assignee: { kind: 'owner_unit_manager' }, slaHours: 48, onReject: 'execute' },
      ],
      completeStatus: 'approved',
    },
  },
  {
    key: 'outgoing-approval',
    name: 'تأیید و امضای نامه صادره',
    description: 'بررسی مدیر واحد، امضای رئیس/معاون (برای نامه‌های فوری یا محرمانه)، سپس دبیرخانه',
    appliesTo: ['outgoing'],
    definition: {
      steps: [
        { key: 'manager', name: 'بررسی مدیر واحد', type: 'approve', assignee: { kind: 'initiator_manager' }, slaHours: 24 },
        { key: 'sign', name: 'امضا', type: 'sign', assignee: { kind: 'role', value: 'president' }, slaHours: 48, onReject: 'manager' },
      ],
      completeStatus: 'signed',
    },
  },
  {
    key: 'incoming-handling',
    name: 'رسیدگی به نامه وارده',
    description: 'ارجاع دبیرخانه به مدیر واحد، اقدام کارشناس و بایگانی',
    appliesTo: ['incoming'],
    definition: {
      steps: [
        { key: 'manager', name: 'دستور مدیر واحد', type: 'review', assignee: { kind: 'owner_unit_manager' }, slaHours: 24 },
        { key: 'archive', name: 'بایگانی', type: 'archive', assignee: { kind: 'role', value: 'secretariat' }, slaHours: 72 },
      ],
    },
  },
];

/**
 * Base data needed by every install (idempotent): permission catalogue, built-in roles, default workflows,
 * retention policies and — when the database has no users — the first administrator from
 * ADMIN_USERNAME / ADMIN_PASSWORD.
 */
export async function ensureBaseData() {
  await tx(async (c) => {
    for (const p of PERMISSIONS) {
      await c.query(`INSERT INTO permissions (key, name, module) VALUES ($1,$2,$3) ON CONFLICT (key) DO UPDATE SET name = EXCLUDED.name, module = EXCLUDED.module`, [p.key, p.name, p.module]);
    }
    for (const r of SYSTEM_ROLES) {
      const row = (
        await c.query(`INSERT INTO roles (key, name, description, is_system) VALUES ($1,$2,$3,true) ON CONFLICT (key) DO NOTHING RETURNING id`, [r.key, r.name, r.description])
      ).rows[0];
      // Only a newly created role gets its default permissions; later edits are kept.
      if (row) for (const p of r.permissions) await c.query(`INSERT INTO role_permissions (role_id, permission_key) VALUES ($1,$2) ON CONFLICT DO NOTHING`, [row.id, p]);
    }
    // The admin role always holds every permission (new permissions included).
    await c.query(`INSERT INTO role_permissions (role_id, permission_key) SELECT r.id, p.key FROM roles r, permissions p WHERE r.key = 'admin' ON CONFLICT DO NOTHING`);
    for (const w of DEFAULT_WORKFLOWS) {
      await c.query(
        `INSERT INTO workflow_definitions (key, version, name, description, applies_to, definition) SELECT $1, 1, $2, $3, $4, $5
          WHERE NOT EXISTS (SELECT 1 FROM workflow_definitions WHERE key = $1)`,
        [w.key, w.name, w.description, w.appliesTo, JSON.stringify(w.definition)],
      );
    }
    for (const [name, years, action] of [
      ['مکاتبات عادی — ۵ سال', 5, 'review'],
      ['اسناد مالی — ۱۰ سال', 10, 'destroy'],
      ['اسناد دائمی', 0, 'permanent'],
    ] as const) {
      await c.query(`INSERT INTO retention_policies (name, retain_years, action) VALUES ($1,$2,$3) ON CONFLICT (name) DO NOTHING`, [name, years, action]);
    }
    await c.query(`INSERT INTO users (username, full_name) VALUES ('system', 'سامانه (خودکار)') ON CONFLICT DO NOTHING`);
    const users = (await c.query(`SELECT count(*)::int AS n FROM users WHERE username <> 'system'`)).rows[0].n;
    if (!users && process.env.ADMIN_USERNAME && process.env.ADMIN_PASSWORD) {
      const u = (
        await c.query(`INSERT INTO users (username, full_name, password_hash, clearance) VALUES ($1, 'مدیر سیستم', $2, 2) RETURNING id`, [
          process.env.ADMIN_USERNAME,
          await bcrypt.hash(process.env.ADMIN_PASSWORD, 10),
        ])
      ).rows[0];
      await c.query(`INSERT INTO user_roles (user_id, role_id) SELECT $1, id FROM roles WHERE key = 'admin'`, [u.id]);
      logger.info({ username: process.env.ADMIN_USERNAME }, 'created first administrator');
    }
  });
}
