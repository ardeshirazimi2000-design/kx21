import type { AttendanceStatus, QuorumRule } from './domain.js';

export interface QuorumParticipant {
  userId: string;
  hasVote: boolean;
  status: AttendanceStatus;
}

export interface QuorumResult {
  /** Number of invitees with voting right. */
  eligible: number;
  /** Number of voting members whose attendance counts toward quorum. */
  present: number;
  /** Number of voting members required. */
  required: number;
  reached: boolean;
  rule: QuorumRule;
  /** Attendance status → count (voting members only). */
  breakdown: Record<AttendanceStatus, number>;
  /** Total invitees (voting or not) currently attending. */
  attendingTotal: number;
  /** Human-readable explanation of the calculation (Persian). */
  explanation: string;
}

const ATTENDING: AttendanceStatus[] = ['present', 'online', 'proxy', 'manual_present'];

export function isAttending(status: AttendanceStatus): boolean {
  return ATTENDING.includes(status);
}

export function countsTowardQuorum(status: AttendanceStatus, rule: QuorumRule): boolean {
  if (status === 'present' || status === 'manual_present') return true;
  if (status === 'online') return rule.countOnline;
  if (status === 'proxy') return rule.countProxy;
  return false;
}

export function requiredForQuorum(eligible: number, rule: QuorumRule): number {
  if (eligible <= 0) return 0;
  switch (rule.type) {
    case 'majority':
      return Math.floor(eligible / 2) + 1;
    case 'two_thirds':
      return Math.ceil((eligible * 2) / 3);
    case 'percent': {
      const pct = Math.min(Math.max(rule.value ?? 50, 0), 100);
      return Math.max(1, Math.ceil((eligible * pct) / 100));
    }
    case 'fixed':
      return Math.min(Math.max(rule.value ?? 1, 1), eligible);
    default:
      return Math.floor(eligible / 2) + 1;
  }
}

const RULE_LABEL: Record<QuorumRule['type'], (r: QuorumRule) => string> = {
  majority: () => 'نصف به‌علاوه یک اعضای دارای حق رأی',
  two_thirds: () => 'دو سوم اعضای دارای حق رأی',
  percent: (r) => `${r.value ?? 50} درصد اعضای دارای حق رأی`,
  fixed: (r) => `حداقل ${r.value ?? 1} نفر`,
};

export function calculateQuorum(participants: QuorumParticipant[], rule: QuorumRule): QuorumResult {
  const breakdown = {
    pending: 0,
    present: 0,
    online: 0,
    proxy: 0,
    manual_present: 0,
    absent: 0,
    excused: 0,
  } as Record<AttendanceStatus, number>;

  let eligible = 0;
  let present = 0;
  let attendingTotal = 0;
  for (const p of participants) {
    if (isAttending(p.status)) attendingTotal++;
    if (!p.hasVote) continue;
    eligible++;
    breakdown[p.status]++;
    if (countsTowardQuorum(p.status, rule)) present++;
  }
  const required = requiredForQuorum(eligible, rule);
  const reached = eligible > 0 && present >= required;
  const explanation =
    `قاعده نصاب: ${RULE_LABEL[rule.type](rule)}. ` +
    `اعضای دارای حق رأی: ${eligible}، حاضرین قابل احتساب: ${present}، حد نصاب لازم: ${required}` +
    `${rule.countOnline ? '' : ' (حضور آنلاین احتساب نمی‌شود)'}` +
    `${rule.countProxy ? '' : ' (حضور نماینده احتساب نمی‌شود)'}.`;
  return { eligible, present, required, reached, rule, breakdown, attendingTotal, explanation };
}
