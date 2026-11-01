/**
 * شورای گفت‌وگو: cases (پرونده) referred from a chamber's commissions or secretariat, reviewed by an expert meeting
 * (جلسهٔ کارشناسی) and decided in a council meeting, provincially and then, when needed, nationally.
 *
 * A case has a level (provincial / national) and a status within that level. The rules below are the single
 * source of truth for what may happen next and who may do it; the API enforces them and the apps show them.
 */

export const BODY_TYPES = ['commission', 'expert_group', 'council'] as const;
export type BodyType = (typeof BODY_TYPES)[number];
export const BODY_TYPE_LABELS: Record<BodyType, string> = {
  commission: 'کمیسیون',
  expert_group: 'کارگروه کارشناسی',
  council: 'شورای گفت‌وگوی دولت و بخش خصوصی',
};

export const CHAMBER_KINDS = ['provincial', 'national'] as const;
export type ChamberKind = (typeof CHAMBER_KINDS)[number];

export const CASE_LEVELS = ['provincial', 'national'] as const;
export type CaseLevel = (typeof CASE_LEVELS)[number];
export const CASE_LEVEL_LABELS: Record<CaseLevel, string> = { provincial: 'استانی', national: 'ملی' };

export const CASE_STATUSES = ['expert_review', 'on_agenda', 'pending_approval', 'resolved', 'returned', 'closed'] as const;
export type CaseStatus = (typeof CASE_STATUSES)[number];
export const CASE_STATUS_LABELS: Record<CaseStatus, string> = {
  expert_review: 'بررسی کارشناسی',
  on_agenda: 'در دستور جلسهٔ شورا',
  pending_approval: 'در انتظار تأیید دبیر شورا',
  resolved: 'حل‌شده',
  returned: 'بازگشت به مبدأ برای تکمیل',
  closed: 'مختومه',
};
/** Statuses in which the case still waits on someone (deadlines apply). */
export const OPEN_CASE_STATUSES: readonly CaseStatus[] = ['expert_review', 'on_agenda', 'pending_approval', 'returned'];

export const CASE_PRIORITIES = ['normal', 'high', 'urgent'] as const;
export type CasePriority = (typeof CASE_PRIORITIES)[number];
export const CASE_PRIORITY_LABELS: Record<CasePriority, string> = { normal: 'عادی', high: 'زیاد', urgent: 'فوری' };

/**
 * Who acts:
 *  secretariat  دبیرخانهٔ شورای همان سطح (the case's current level)
 *  president    دبیر شورای همان سطح: the chamber's president, who records their own approvals
 *  origin       the originating commission's secretariat (resolution managers), or the provincial secretariat
 */
export type CaseActor = 'secretariat' | 'president' | 'origin';

export const CASE_ACTIONS = [
  'schedule',
  'resolve',
  'propose_escalation',
  'approve_escalation',
  'reject_escalation',
  'send_back',
  'return',
  'resubmit',
  'close',
  'reopen',
] as const;
export type CaseAction = (typeof CASE_ACTIONS)[number];

export interface CaseTransition {
  action: CaseAction;
  label: string;
  from: readonly CaseStatus[];
  levels: readonly CaseLevel[];
  to: { status: CaseStatus; level?: CaseLevel };
  actor: CaseActor;
  /** The decision is a resolution of a meeting where the case was on the agenda. */
  needsResolution: 'council' | 'expert_or_council' | null;
  /** A council meeting to put the case on. */
  needsMeeting: boolean;
  needsReason: boolean;
  /** The written outcome (close). */
  needsOutcome?: boolean;
}

export const CASE_TRANSITIONS: readonly CaseTransition[] = [
  {
    action: 'schedule',
    label: 'قرار دادن در دستور جلسهٔ شورا',
    from: ['expert_review'],
    levels: ['provincial', 'national'],
    to: { status: 'on_agenda' },
    actor: 'secretariat',
    needsResolution: null,
    needsMeeting: true,
    needsReason: false,
  },
  {
    action: 'resolve',
    label: 'ثبت حل پرونده با مصوبه',
    from: ['expert_review', 'on_agenda'],
    levels: ['provincial', 'national'],
    to: { status: 'resolved' },
    actor: 'secretariat',
    needsResolution: 'expert_or_council',
    needsMeeting: false,
    needsReason: false,
  },
  {
    action: 'propose_escalation',
    label: 'ارجاع به شورای ملی (برای تأیید دبیر شورا)',
    from: ['on_agenda'],
    levels: ['provincial'],
    to: { status: 'pending_approval' },
    actor: 'secretariat',
    needsResolution: 'council',
    needsMeeting: false,
    needsReason: false,
  },
  {
    action: 'approve_escalation',
    label: 'تأیید ارجاع به شورای ملی',
    from: ['pending_approval'],
    levels: ['provincial'],
    to: { status: 'expert_review', level: 'national' },
    actor: 'president',
    needsResolution: null,
    needsMeeting: false,
    needsReason: false,
  },
  {
    action: 'reject_escalation',
    label: 'عدم تأیید ارجاع به شورای ملی',
    from: ['pending_approval'],
    levels: ['provincial'],
    to: { status: 'on_agenda' },
    actor: 'president',
    needsResolution: null,
    needsMeeting: false,
    needsReason: true,
  },
  {
    action: 'send_back',
    label: 'بازگرداندن به استان با مصوبهٔ شورای ملی',
    from: ['on_agenda'],
    levels: ['national'],
    to: { status: 'expert_review', level: 'provincial' },
    actor: 'secretariat',
    needsResolution: 'council',
    needsMeeting: false,
    needsReason: true,
  },
  {
    action: 'return',
    label: 'بازگشت برای تکمیل',
    from: ['expert_review', 'on_agenda'],
    levels: ['provincial', 'national'],
    // from on_agenda → expert_review; from provincial expert_review → returned (see caseTransition)
    to: { status: 'expert_review' },
    actor: 'secretariat',
    needsResolution: null,
    needsMeeting: false,
    needsReason: true,
  },
  {
    action: 'resubmit',
    label: 'ارسال دوبارهٔ پرونده پس از تکمیل',
    from: ['returned'],
    levels: ['provincial'],
    to: { status: 'expert_review' },
    actor: 'origin',
    needsResolution: null,
    needsMeeting: false,
    needsReason: false,
  },
  {
    action: 'close',
    label: 'مختومه کردن و ابلاغ نتیجه به مبدأ',
    from: ['resolved'],
    levels: ['provincial', 'national'],
    to: { status: 'closed' },
    actor: 'secretariat',
    needsResolution: null,
    needsMeeting: false,
    needsReason: false,
    needsOutcome: true,
  },
  {
    action: 'reopen',
    label: 'بازگشایی پرونده',
    from: ['closed'],
    levels: ['provincial', 'national'],
    to: { status: 'expert_review' },
    actor: 'president',
    needsResolution: null,
    needsMeeting: false,
    needsReason: true,
  },
];

export interface CaseState {
  level: CaseLevel;
  status: CaseStatus;
}

/** The transition `action` would make from `state`, with its resulting level and status; null when not allowed. */
export function caseTransition(action: CaseAction, state: CaseState): (CaseTransition & { next: CaseState }) | null {
  const t = CASE_TRANSITIONS.find((x) => x.action === action);
  if (!t || !t.from.includes(state.status) || !t.levels.includes(state.level)) return null;
  let next: CaseState = { level: t.to.level ?? state.level, status: t.to.status };
  // Returning a provincial case still under expert review sends it back to where it came from.
  if (action === 'return' && state.status === 'expert_review') {
    if (state.level === 'national') return null;
    next = { level: 'provincial', status: 'returned' };
  }
  return { ...t, next };
}

/** Actions open to someone acting as these actors on a case in this state. */
export function availableCaseActions(state: CaseState, actors: readonly CaseActor[]): CaseAction[] {
  return CASE_TRANSITIONS.filter((t) => actors.includes(t.actor) && caseTransition(t.action, state)).map((t) => t.action);
}

export const CASE_EVENT_LABELS: Record<string, string> = {
  opened: 'ثبت پرونده',
  expert_meeting: 'طرح در جلسهٔ کارشناسی',
  schedule: 'قرار گرفتن در دستور جلسهٔ شورا',
  resolve: 'حل پرونده',
  propose_escalation: 'پیشنهاد ارجاع به شورای ملی',
  approve_escalation: 'ارجاع به شورای ملی',
  reject_escalation: 'عدم تأیید ارجاع به شورای ملی',
  send_back: 'بازگشت به استان',
  return: 'بازگشت برای تکمیل',
  resubmit: 'ارسال دوباره',
  close: 'مختومه',
  reopen: 'بازگشایی',
};
