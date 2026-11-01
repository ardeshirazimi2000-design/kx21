import { describe, expect, it } from 'vitest';
import { availableCaseActions, CASE_ACTIONS, CASE_LEVELS, CASE_STATUSES, caseTransition } from './council.js';

describe('council case transitions', () => {
  it('runs a provincial case to the national council and back', () => {
    let s = { level: 'provincial', status: 'expert_review' } as const;
    const step = (a: Parameters<typeof caseTransition>[0], st: any) => caseTransition(a, st)!.next;
    let n = step('schedule', s);
    expect(n).toEqual({ level: 'provincial', status: 'on_agenda' });
    n = step('propose_escalation', n);
    expect(n.status).toBe('pending_approval');
    expect(caseTransition('reject_escalation', n)!.next).toEqual({ level: 'provincial', status: 'on_agenda' });
    n = step('approve_escalation', n);
    expect(n).toEqual({ level: 'national', status: 'expert_review' });
    n = step('schedule', n);
    expect(step('send_back', n)).toEqual({ level: 'provincial', status: 'expert_review' });
    n = step('resolve', n);
    n = step('close', n);
    expect(n).toEqual({ level: 'national', status: 'closed' });
    expect(step('reopen', n)).toEqual({ level: 'national', status: 'expert_review' });
    void s;
  });

  it('returns a provincial case under review to its origin, but a national one only a step back', () => {
    expect(caseTransition('return', { level: 'provincial', status: 'expert_review' })!.next).toEqual({ level: 'provincial', status: 'returned' });
    expect(caseTransition('return', { level: 'provincial', status: 'on_agenda' })!.next.status).toBe('expert_review');
    expect(caseTransition('return', { level: 'national', status: 'expert_review' })).toBeNull();
    expect(caseTransition('resubmit', { level: 'provincial', status: 'returned' })!.next.status).toBe('expert_review');
  });

  it('refuses what the rules do not allow', () => {
    expect(caseTransition('propose_escalation', { level: 'national', status: 'on_agenda' })).toBeNull();
    expect(caseTransition('approve_escalation', { level: 'provincial', status: 'on_agenda' })).toBeNull();
    expect(caseTransition('close', { level: 'provincial', status: 'on_agenda' })).toBeNull();
    expect(caseTransition('reopen', { level: 'provincial', status: 'resolved' })).toBeNull();
    // Every action leads somewhere from at least one state, and nothing leaves a closed case except reopening.
    for (const a of CASE_ACTIONS) {
      expect(CASE_LEVELS.some((level) => CASE_STATUSES.some((status) => caseTransition(a, { level, status })))).toBe(true);
    }
    for (const level of CASE_LEVELS) expect(availableCaseActions({ level, status: 'closed' }, ['secretariat', 'president', 'origin'])).toEqual(['reopen']);
  });

  it('gives each actor only their own actions', () => {
    const s = { level: 'provincial', status: 'pending_approval' } as const;
    expect(availableCaseActions(s, ['secretariat'])).toEqual([]);
    expect(availableCaseActions(s, ['president'])).toEqual(['approve_escalation', 'reject_escalation']);
    expect(availableCaseActions({ level: 'provincial', status: 'returned' }, ['secretariat'])).toEqual([]);
  });
});
