/**
 * Workflow engine (BPMN-lite). A definition is an ordered list of steps; each step is assigned to a
 * user, a position, a role or a unit manager, may be skipped by a condition, has an SLA with reminder
 * and escalation, and on rejection either ends the instance or jumps back to an earlier step.
 * Definitions are versioned: editing creates a new version, running instances keep their own.
 */
import { formatJalaliDateTime } from '@kx/shared';
import type { Request } from 'express';
import { z } from 'zod';
import type { AuthUser } from '../auth/middleware.js';
import { one, query, type Db } from '../db/pool.js';
import { audit } from '../lib/audit.js';
import { badRequest, conflict, forbidden, notFound } from '../lib/errors.js';
import { archiveLetter } from './archive.js';
import { LETTER_HASH_VERSION, letterContentHash, managerPositionOf, primaryUnitOf } from './letters.js';
import { notify, positionHolders } from './notifications.js';
import { signContent } from './signatures.js';

const assigneeSchema = z.object({
  kind: z.enum(['user', 'position', 'role', 'unit_manager', 'owner_unit_manager', 'initiator_manager', 'context_user']),
  value: z.string().optional(),
});

export const stepSchema = z.object({
  key: z.string().regex(/^[a-z0-9_-]{1,40}$/i, 'کلید گام فقط حروف لاتین، عدد، - و _'),
  name: z.string().min(2).max(100),
  type: z.enum(['review', 'approve', 'sign', 'archive', 'notify']),
  assignee: assigneeSchema,
  slaHours: z.number().positive().max(24 * 90).optional(),
  remindBeforeHours: z.number().positive().optional(),
  /** Who gets the step when the SLA passes; default: manager of the current assignee. */
  escalateTo: assigneeSchema.optional(),
  onReject: z.string().optional(), // 'end' (default) or a previous step key
  condition: z
    .object({ field: z.enum(['priority', 'kind', 'confidentiality', 'source']), op: z.enum(['eq', 'neq', 'in']), value: z.union([z.string(), z.number(), z.array(z.union([z.string(), z.number()]))]) })
    .optional(),
  archiveFolderId: z.string().uuid().optional(),
});

export const definitionSchema = z
  .object({
    steps: z.array(stepSchema).min(1).max(30),
    /** Letter status after successful completion. */
    completeStatus: z.enum(['approved', 'signed', 'archived']).optional(),
  })
  .superRefine((d, ctx) => {
    const keys = d.steps.map((s) => s.key);
    if (new Set(keys).size !== keys.length) ctx.addIssue({ code: 'custom', message: 'کلید گام‌ها باید یکتا باشد' });
    d.steps.forEach((s, i) => {
      if (s.onReject && s.onReject !== 'end' && !keys.slice(0, i).includes(s.onReject)) {
        ctx.addIssue({ code: 'custom', message: `بازگشت گام «${s.name}» باید به یکی از گام‌های قبلی باشد` });
      }
      if (['user', 'position', 'role', 'unit_manager', 'context_user'].includes(s.assignee.kind) && !s.assignee.value) {
        ctx.addIssue({ code: 'custom', message: `مسئول گام «${s.name}» مشخص نشده است` });
      }
    });
  });

export type WorkflowDefinition = z.infer<typeof definitionSchema>;
type Step = z.infer<typeof stepSchema>;
type Assignee = { userId: string | null; positionId: string | null };

const ROUTING_ACTION: Record<Step['type'], string> = { review: 'review', approve: 'approve', sign: 'sign', archive: 'archive', notify: 'info' };

/** Hooks run inside the transaction when an instance finishes (e.g. feedback to the meetings system). */
type Hook = (db: Db, inst: any, letter: any, outcome: 'completed' | 'rejected' | 'cancelled') => Promise<void>;
const hooks: Hook[] = [];
export const onWorkflowFinished = (h: Hook) => hooks.push(h);

async function resolveAssignee(db: Db, a: z.infer<typeof assigneeSchema>, letter: any, inst: any): Promise<Assignee> {
  switch (a.kind) {
    case 'user':
      return { userId: a.value!, positionId: null };
    case 'position':
      return { userId: null, positionId: a.value! };
    case 'context_user': {
      const id = inst.context?.[a.value!];
      if (id) return { userId: id, positionId: null };
      break;
    }
    case 'role': {
      // Least-loaded active holder of the role.
      const r = await one(
        `SELECT u.id FROM users u JOIN user_roles ur ON ur.user_id = u.id JOIN roles ro ON ro.id = ur.role_id
          WHERE ro.key = $1 AND u.is_active
          ORDER BY (SELECT count(*) FROM workflow_steps ws WHERE ws.assignee_user_id = u.id AND ws.status = 'active'), u.created_at LIMIT 1`,
        [a.value],
        db,
      );
      if (r) return { userId: r.id, positionId: null };
      break;
    }
    case 'unit_manager': {
      const p = await managerPositionOf(a.value!, db);
      if (p) return { userId: null, positionId: p };
      break;
    }
    case 'initiator_manager': {
      const unit = inst.started_by ? await primaryUnitOf(inst.started_by, db) : null;
      if (unit) {
        let p = await managerPositionOf(unit, db);
        // The initiator is the manager: go one level up.
        if (p && (await positionHolders(p, db)).includes(inst.started_by)) {
          const parent = await one('SELECT parent_id FROM org_units WHERE id = $1', [unit], db);
          p = parent?.parent_id ? await managerPositionOf(parent.parent_id, db) : p;
        }
        if (p) return { userId: null, positionId: p };
      }
      break;
    }
    case 'owner_unit_manager':
      break;
  }
  // Fallback: manager of the letter's owner unit.
  const p = letter.owner_unit_id ? await managerPositionOf(letter.owner_unit_id, db) : null;
  if (p) return { userId: null, positionId: p };
  throw badRequest(`مسئول گام قابل تعیین نیست (${a.kind})`);
}

function conditionHolds(step: Step, letter: any) {
  const c = step.condition;
  if (!c) return true;
  const v = letter[c.field];
  if (c.op === 'eq') return String(v) === String(c.value);
  if (c.op === 'neq') return String(v) !== String(c.value);
  return Array.isArray(c.value) && c.value.map(String).includes(String(v));
}

async function stepVars(db: Db, letter: any, step: { name: string; due_at?: Date | null }, inst: any) {
  const def = await one('SELECT name FROM workflow_definitions WHERE id = $1', [inst.definition_id], db);
  return {
    subject: letter.subject,
    number: letter.number ?? 'پیش‌نویس',
    step: step.name,
    workflow: def?.name,
    due: step.due_at ? formatJalaliDateTime(step.due_at) : 'بدون مهلت',
  };
}

async function assigneeUsers(db: Db, a: Assignee) {
  return a.userId ? [a.userId] : a.positionId ? await positionHolders(a.positionId, db) : [];
}

/** Activates the first applicable step at or after index `from`; completes the instance when none is left. */
async function activateFrom(db: Db, req: Request | null, inst: any, from: number) {
  const def = await one('SELECT definition FROM workflow_definitions WHERE id = $1', [inst.definition_id], db);
  const steps: Step[] = def!.definition.steps;
  const letter = await one('SELECT * FROM letters WHERE id = $1', [inst.letter_id], db);
  for (let i = from; i < steps.length; i++) {
    const s = steps[i];
    if (!conditionHolds(s, letter)) {
      await query(
        `INSERT INTO workflow_steps (instance_id, step_key, name, type, seq, status, acted_at, comment) VALUES ($1,$2,$3,$4,$5,'skipped',now(),'شرط گام برقرار نبود')`,
        [inst.id, s.key, s.name, s.type, i],
        db,
      );
      continue;
    }
    const a = await resolveAssignee(db, s.assignee, letter, inst);
    const dueAt = s.slaHours ? new Date(Date.now() + s.slaHours * 3600_000) : null;
    if (s.type === 'notify') {
      await query(
        `INSERT INTO workflow_steps (instance_id, step_key, name, type, seq, assignee_user_id, assignee_position_id, status, acted_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,'approved',now())`,
        [inst.id, s.key, s.name, s.type, i, a.userId, a.positionId],
        db,
      );
      await query(
        `INSERT INTO letter_routing (letter_id, from_user_id, to_user_id, to_position_id, action, instruction, status)
         VALUES ($1,$2,$3,$4,'info',$5,'pending')`,
        [letter.id, inst.started_by, a.userId, a.positionId, `اطلاع: ${s.name}`],
        db,
      );
      await notify({ userIds: await assigneeUsers(db, a), event: 'workflow.step_assigned', vars: await stepVars(db, letter, s, inst), data: { letterId: letter.id } }, db);
      continue;
    }
    const step = await one(
      `INSERT INTO workflow_steps (instance_id, step_key, name, type, seq, assignee_user_id, assignee_position_id, due_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [inst.id, s.key, s.name, s.type, i, a.userId, a.positionId, dueAt],
      db,
    );
    const routing = await one(
      `INSERT INTO letter_routing (letter_id, from_user_id, to_user_id, to_position_id, action, instruction, due_at, workflow_step_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
      [letter.id, inst.started_by, a.userId, a.positionId, ROUTING_ACTION[s.type], s.name, dueAt, step.id],
      db,
    );
    await query('UPDATE workflow_steps SET routing_id = $2 WHERE id = $1', [step.id, routing!.id], db);
    await query('UPDATE workflow_instances SET current_step_key = $2 WHERE id = $1', [inst.id, s.key], db);
    await notify({ userIds: await assigneeUsers(db, a), event: 'workflow.step_assigned', vars: await stepVars(db, letter, step, inst), data: { letterId: letter.id, stepId: step.id } }, db);
    return step;
  }
  await finish(db, req, inst, letter, 'completed', def!.definition.completeStatus);
  return null;
}

async function finish(db: Db, req: Request | null, inst: any, letter: any, outcome: 'completed' | 'rejected' | 'cancelled', completeStatus?: string) {
  const status = outcome;
  const done = await one(
    `UPDATE workflow_instances SET status = $2, completed_at = now(), current_step_key = NULL WHERE id = $1 RETURNING *`,
    [inst.id, status],
    db,
  );
  let letterStatus: string | null = null;
  if (outcome === 'completed') {
    const fresh = await one('SELECT status FROM letters WHERE id = $1', [letter.id], db);
    // Archive/sign steps set their own status; otherwise the definition decides (default: approved).
    if (fresh.status === 'in_progress') letterStatus = completeStatus ?? 'approved';
  } else if (outcome === 'rejected') {
    letterStatus = letter.number ? 'registered' : 'draft';
  }
  if (letterStatus) await query('UPDATE letters SET status = $2, updated_at = now() WHERE id = $1', [letter.id, letterStatus], db);
  await query(`UPDATE letter_routing SET status = 'cancelled' WHERE letter_id = $1 AND workflow_step_id IN (SELECT id FROM workflow_steps WHERE instance_id = $2 AND status = 'active')`, [letter.id, inst.id], db);
  await query(`UPDATE workflow_steps SET status = 'cancelled' WHERE instance_id = $1 AND status = 'active'`, [inst.id], db);
  await audit(db, req, { action: `workflow.${outcome}`, entity: 'workflow_instance', entityId: inst.id, after: { letterId: letter.id, status } });
  if (outcome !== 'cancelled') {
    await notify(
      { userIds: [inst.started_by, letter.created_by], event: outcome === 'completed' ? 'workflow.completed' : 'workflow.rejected', vars: await stepVars(db, letter, { name: inst.current_step_key ?? '' }, inst), data: { letterId: letter.id } },
      db,
    );
  }
  for (const h of hooks) await h(db, done, letter, outcome);
}

export async function latestDefinition(db: Db, keyOrId: string) {
  const isId = /^[0-9a-f-]{36}$/i.test(keyOrId);
  const d = isId
    ? await one('SELECT * FROM workflow_definitions WHERE id = $1', [keyOrId], db)
    : await one('SELECT * FROM workflow_definitions WHERE key = $1 AND is_active ORDER BY version DESC LIMIT 1', [keyOrId], db);
  if (!d || !d.is_active) throw notFound('تعریف گردش کار فعال یافت نشد');
  return d;
}

export async function startWorkflow(
  db: Db,
  req: Request | null,
  input: { letterId: string; definition: string; startedBy: string; context?: Record<string, unknown> },
) {
  const def = await latestDefinition(db, input.definition);
  const letter = await one('SELECT * FROM letters WHERE id = $1 FOR UPDATE', [input.letterId], db);
  if (!letter) throw notFound('نامه یافت نشد');
  if (['cancelled', 'archived', 'sent'].includes(letter.status)) throw conflict('برای نامه در این وضعیت گردش کار شروع نمی‌شود');
  if (!def.applies_to.includes(letter.kind)) throw badRequest('این گردش کار برای این نوع نامه تعریف نشده است');
  if (await one(`SELECT 1 FROM workflow_instances WHERE letter_id = $1 AND status = 'running'`, [letter.id], db)) {
    throw conflict('برای این نامه یک گردش کار در حال اجراست');
  }
  const inst = await one(
    `INSERT INTO workflow_instances (definition_id, letter_id, context, started_by) VALUES ($1,$2,$3,$4) RETURNING *`,
    [def.id, letter.id, JSON.stringify(input.context ?? {}), input.startedBy],
    db,
  );
  await query(`UPDATE letters SET status = 'in_progress', updated_at = now() WHERE id = $1`, [letter.id], db);
  await audit(db, req, { action: 'workflow.started', entity: 'workflow_instance', entityId: inst.id, after: { letterId: letter.id, definition: `${def.key}@${def.version}` }, userId: input.startedBy });
  await activateFrom(db, req, inst, 0);
  return one('SELECT * FROM workflow_instances WHERE id = $1', [inst.id], db);
}

/** Whether the user may act on a step (assignee user or a current holder of the assignee position). */
export async function canActOnStep(db: Db, u: AuthUser, step: any) {
  if (step.assignee_user_id === u.id) return true;
  return !!step.assignee_position_id && u.positions.some((p) => p.positionId === step.assignee_position_id);
}

export async function actOnStep(
  db: Db,
  req: Request | null,
  u: AuthUser,
  stepId: string,
  input: { decision: 'approve' | 'reject'; comment?: string | null; archiveFolderId?: string | null },
) {
  const step = await one('SELECT * FROM workflow_steps WHERE id = $1 FOR UPDATE', [stepId], db);
  if (!step) throw notFound('گام یافت نشد');
  if (!(await canActOnStep(db, u, step))) throw forbidden('این گام به شما ارجاع نشده است');
  if (step.status !== 'active') throw conflict('روی این گام قبلاً اقدام شده است');
  const inst = await one('SELECT * FROM workflow_instances WHERE id = $1 FOR UPDATE', [step.instance_id], db);
  if (inst.status !== 'running') throw conflict('گردش کار فعال نیست');
  const def = await one('SELECT definition FROM workflow_definitions WHERE id = $1', [inst.definition_id], db);
  const steps: Step[] = def!.definition.steps;
  const s = steps[step.seq];
  const letter = await one('SELECT * FROM letters WHERE id = $1 FOR UPDATE', [inst.letter_id], db);
  if (input.decision === 'reject' && !(input.comment && input.comment.trim().length >= 3)) throw badRequest('برای رد، توضیح لازم است');

  if (input.decision === 'approve' && s.type === 'sign') {
    const pos = u.positions.find((p) => p.positionId === step.assignee_position_id) ?? u.positions[0];
    await signContent(db, { userId: u.id, entityType: 'letter', entityId: letter.id, contentHash: await letterContentHash(db, letter.id), hashVersion: LETTER_HASH_VERSION, positionTitle: pos?.title });
    await query(`UPDATE letters SET signer_id = $2, status = 'signed', updated_at = now() WHERE id = $1`, [letter.id, u.id], db);
  }
  if (input.decision === 'approve' && s.type === 'archive') {
    await archiveLetter(db, req, u, letter, input.archiveFolderId ?? s.archiveFolderId ?? null);
  }

  await query(
    `UPDATE workflow_steps SET status = $2, acted_by = $3, acted_at = now(), comment = $4 WHERE id = $1`,
    [step.id, input.decision === 'approve' ? 'approved' : 'rejected', u.id, input.comment ?? null],
    db,
  );
  await query(
    `UPDATE letter_routing SET status = $2, response = $3, done_at = now(), done_by = $4 WHERE id = $1`,
    [step.routing_id, input.decision === 'approve' ? 'done' : 'returned', input.comment ?? null, u.id],
    db,
  );
  await audit(db, req, { action: `workflow.step.${input.decision}`, entity: 'workflow_step', entityId: step.id, after: { letterId: letter.id, step: s.key, comment: input.comment } });

  if (input.decision === 'approve') return activateFrom(db, req, inst, step.seq + 1);
  const back = s.onReject && s.onReject !== 'end' ? steps.findIndex((x) => x.key === s.onReject) : -1;
  if (back >= 0) {
    await notify({ userIds: [inst.started_by], event: 'workflow.rejected', vars: { ...(await stepVars(db, letter, s, inst)), comment: input.comment }, data: { letterId: letter.id } }, db);
    return activateFrom(db, req, inst, back);
  }
  await finish(db, req, { ...inst, current_step_key: s.name }, letter, 'rejected');
  return null;
}

export async function cancelWorkflow(db: Db, req: Request | null, instanceId: string, reason: string) {
  const inst = await one('SELECT * FROM workflow_instances WHERE id = $1 FOR UPDATE', [instanceId], db);
  if (!inst || inst.status !== 'running') throw conflict('گردش کار فعال نیست');
  const letter = await one('SELECT * FROM letters WHERE id = $1', [inst.letter_id], db);
  await finish(db, req, inst, letter, 'cancelled');
  await query(`UPDATE letters SET status = CASE WHEN number IS NULL THEN 'draft' ELSE 'registered' END WHERE id = $1 AND status = 'in_progress'`, [letter.id], db);
  await audit(db, req, { action: 'workflow.cancel_reason', entity: 'workflow_instance', entityId: inst.id, reason });
}

/**
 * SLA handling (scheduler): reminder before the due time, escalation after it. Escalation moves the
 * step to the configured target or to the manager of the current assignee, and restarts the SLA.
 */
export async function runWorkflowTimers(db: Db) {
  const remind = await query(
    `SELECT ws.*, wi.definition_id, wi.letter_id, wi.started_by FROM workflow_steps ws JOIN workflow_instances wi ON wi.id = ws.instance_id
      WHERE ws.status = 'active' AND ws.due_at IS NOT NULL AND ws.reminded_at IS NULL AND ws.due_at > now()
        AND ws.due_at - now() <= make_interval(hours => COALESCE(
          ((SELECT d.definition FROM workflow_definitions d WHERE d.id = wi.definition_id)->'steps'->ws.seq->>'remindBeforeHours')::numeric,
          GREATEST(1, EXTRACT(epoch FROM ws.due_at - ws.created_at) / 3600 * 0.2))::int)`,
    [],
    db,
  );
  for (const s of remind) {
    await query('UPDATE workflow_steps SET reminded_at = now() WHERE id = $1', [s.id], db);
    const letter = await one('SELECT * FROM letters WHERE id = $1', [s.letter_id], db);
    await notify({ userIds: await assigneeUsers(db, { userId: s.assignee_user_id, positionId: s.assignee_position_id }), event: 'workflow.reminder', vars: await stepVars(db, letter, s, s), data: { letterId: s.letter_id } }, db);
  }
  const overdue = await query(
    `SELECT ws.*, wi.definition_id, wi.letter_id, wi.started_by, wi.context FROM workflow_steps ws JOIN workflow_instances wi ON wi.id = ws.instance_id
      WHERE ws.status = 'active' AND ws.due_at < now() AND wi.status = 'running' AND ws.escalation_level < 3 FOR UPDATE OF ws SKIP LOCKED`,
    [],
    db,
  );
  for (const s of overdue) {
    const def = await one('SELECT definition FROM workflow_definitions WHERE id = $1', [s.definition_id], db);
    const sdef: Step = def!.definition.steps[s.seq];
    const letter = await one('SELECT * FROM letters WHERE id = $1', [s.letter_id], db);
    let target: Assignee | null = null;
    if (sdef.escalateTo && s.escalation_level === 0) target = await resolveAssignee(db, sdef.escalateTo, letter, s).catch(() => null);
    if (!target) {
      // Manager of the current assignee's unit; one level up when the assignee already is that manager.
      const unit = s.assignee_position_id
        ? (await one('SELECT unit_id FROM positions WHERE id = $1', [s.assignee_position_id], db))?.unit_id
        : await primaryUnitOf(s.assignee_user_id, db);
      let p = unit ? await managerPositionOf(unit, db) : null;
      if (p && p === s.assignee_position_id) {
        const parent = await one('SELECT parent_id FROM org_units WHERE id = $1', [unit], db);
        p = parent?.parent_id ? await managerPositionOf(parent.parent_id, db) : null;
      }
      if (p) target = { userId: null, positionId: p };
    }
    const due = new Date(Date.now() + (sdef.slaHours ?? 24) * 3600_000);
    if (!target) {
      await query('UPDATE workflow_steps SET escalation_level = 3, escalated_at = now() WHERE id = $1', [s.id], db);
      continue;
    }
    await query(
      `UPDATE workflow_steps SET assignee_user_id = $2, assignee_position_id = $3, due_at = $4, reminded_at = NULL, escalated_at = now(),
         escalation_level = escalation_level + 1 WHERE id = $1`,
      [s.id, target.userId, target.positionId, due],
      db,
    );
    await query(`UPDATE letter_routing SET status = 'cancelled' WHERE id = $1`, [s.routing_id], db);
    const routing = await one(
      `INSERT INTO letter_routing (letter_id, parent_id, from_user_id, to_user_id, to_position_id, action, instruction, due_at, workflow_step_id)
       VALUES ($1,$2,NULL,$3,$4,$5,$6,$7,$8) RETURNING id`,
      [s.letter_id, s.routing_id, target.userId, target.positionId, ROUTING_ACTION[sdef.type], `ارجاع خودکار به‌دلیل تأخیر: ${s.name}`, due, s.id],
      db,
    );
    await query('UPDATE workflow_steps SET routing_id = $2 WHERE id = $1', [s.id, routing!.id], db);
    await audit(db, null, { action: 'workflow.escalated', entity: 'workflow_step', entityId: s.id, after: { to: target, level: s.escalation_level + 1 } });
    await notify({ userIds: await assigneeUsers(db, target), event: 'workflow.escalated', vars: await stepVars(db, letter, s, s), data: { letterId: s.letter_id } }, db);
  }
  return { reminded: remind.length, escalated: overdue.length };
}
