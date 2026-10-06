import { describe, expect, it } from 'vitest';
import {
  availableActions,
  calculateQuorum,
  canTransition,
  DEFAULT_COMMISSION_SETTINGS,
  formatJalaliDate,
  jalaliMonthLength,
  nextStatus,
  parseJalali,
  requiredForQuorum,
  resolveCapabilities,
  tallyVotes,
  toGregorian,
  toJalali,
  type QuorumParticipant,
} from './index.js';

describe('meeting state machine', () => {
  it('follows the happy path', () => {
    let s = nextStatus('draft', 'schedule');
    s = nextStatus(s, 'send_invitations');
    s = nextStatus(s, 'open_checkin');
    s = nextStatus(s, 'start');
    s = nextStatus(s, 'begin_agenda');
    s = nextStatus(s, 'end');
    expect(s).toBe('minutes_draft');
    s = nextStatus(s, 'submit_minutes');
    s = nextStatus(s, 'return_minutes');
    s = nextStatus(s, 'submit_minutes');
    s = nextStatus(s, 'approve_minutes');
    s = nextStatus(s, 'archive');
    expect(s).toBe('archived');
  });
  it('only lets scheduled meetings start', () => {
    expect(canTransition('draft', 'start')).toBe(false);
    expect(canTransition('approved', 'start')).toBe(false);
    expect(canTransition('checkin_open', 'start')).toBe(true);
    expect(() => nextStatus('draft', 'start')).toThrow();
  });
  it('cannot cancel a running meeting', () => {
    expect(canTransition('in_progress', 'cancel')).toBe(false);
    expect(availableActions('scheduled')).toContain('cancel');
  });
});

describe('quorum', () => {
  const rule = DEFAULT_COMMISSION_SETTINGS.quorum;
  it('computes majority', () => {
    expect(requiredForQuorum(10, rule)).toBe(6);
    expect(requiredForQuorum(9, rule)).toBe(5);
    expect(requiredForQuorum(0, rule)).toBe(0);
    expect(requiredForQuorum(9, { ...rule, type: 'two_thirds' })).toBe(6);
    expect(requiredForQuorum(7, { ...rule, type: 'percent', value: 60 })).toBe(5);
    expect(requiredForQuorum(3, { ...rule, type: 'fixed', value: 5 })).toBe(3);
  });
  it('counts statuses according to rule', () => {
    const ps: QuorumParticipant[] = [
      { userId: 'a', hasVote: true, status: 'present' },
      { userId: 'b', hasVote: true, status: 'online' },
      { userId: 'c', hasVote: true, status: 'proxy' },
      { userId: 'd', hasVote: true, status: 'absent' },
      { userId: 'e', hasVote: true, status: 'pending' },
      { userId: 'f', hasVote: false, status: 'present' },
    ];
    const q = calculateQuorum(ps, rule);
    expect(q.eligible).toBe(5);
    expect(q.present).toBe(3);
    expect(q.required).toBe(3);
    expect(q.reached).toBe(true);
    expect(q.attendingTotal).toBe(4);
    const strict = calculateQuorum(ps, { ...rule, countOnline: false, countProxy: false });
    expect(strict.present).toBe(1);
    expect(strict.reached).toBe(false);
  });
});

describe('voting', () => {
  it('applies pass rules', () => {
    const votes = ['yes', 'yes', 'yes', 'no', 'abstain'];
    const opts = ['yes', 'no', 'abstain'];
    expect(tallyVotes(votes, opts, 7, 'majority_of_present').passed).toBe(false);
    expect(tallyVotes(votes, opts, 5, 'majority_of_present').passed).toBe(true);
    expect(tallyVotes(votes, opts, 7, 'simple_majority').passed).toBe(true);
    expect(tallyVotes(votes, opts, 7, 'majority_of_cast').passed).toBe(true);
    expect(tallyVotes(votes, opts, 4, 'two_thirds_of_present').passed).toBe(true);
    const t = tallyVotes(votes, opts, 5, 'simple_majority');
    expect(t.counts).toEqual({ yes: 3, no: 1, abstain: 1 });
    expect(t.participationPercent).toBe(100);
  });
  it('ignores unknown options', () => {
    expect(tallyVotes(['maybe', 'yes'], ['yes', 'no'], 2, 'simple_majority').totalCast).toBe(1);
  });
});

describe('permissions', () => {
  it('member can vote but not control', () => {
    const c = resolveCapabilities({ isSuperAdmin: false, isChamberAdmin: false, position: 'member', inviteeRole: 'member', hasVote: true });
    expect(c.has('vote.cast')).toBe(true);
    expect(c.has('meeting.control')).toBe(false);
    expect(c.has('attendance.view_all')).toBe(false);
  });
  it('secretary manages but does not approve minutes', () => {
    const c = resolveCapabilities({ isSuperAdmin: false, isChamberAdmin: false, position: 'secretary', inviteeRole: 'secretary' });
    expect(c.has('meeting.manage')).toBe(true);
    expect(c.has('minutes.approve')).toBe(false);
  });
  it('expert only sees meetings they are invited to', () => {
    expect(resolveCapabilities({ isSuperAdmin: false, isChamberAdmin: false, position: 'expert' }).has('meeting.view')).toBe(false);
    expect(
      resolveCapabilities({ isSuperAdmin: false, isChamberAdmin: false, position: 'expert', inviteeRole: 'expert' }).has('meeting.view'),
    ).toBe(true);
  });
  it('officer-only results hide results from members', () => {
    const c = resolveCapabilities({ isSuperAdmin: false, isChamberAdmin: false, position: 'member', inviteeRole: 'member', hasVote: true, resultVisibility: 'officers' });
    expect(c.has('vote.results.view')).toBe(false);
  });
  it('outsider sees nothing', () => {
    expect(resolveCapabilities({ isSuperAdmin: false, isChamberAdmin: false }).size).toBe(0);
  });
});

describe('jalali', () => {
  it('converts known dates', () => {
    expect(toJalali(2024, 3, 20)).toEqual([1403, 1, 1]);
    expect(toJalali(2026, 10, 6)).toEqual([1405, 7, 14]);
    expect(toGregorian(1405, 7, 14)).toEqual([2026, 10, 6]);
    expect(toGregorian(1403, 12, 30)).toEqual([2025, 3, 20]);
  });
  it('round-trips a range of days', () => {
    const start = Date.UTC(2020, 0, 1);
    for (let i = 0; i < 3000; i += 7) {
      const d = new Date(start + i * 86400000);
      const g: [number, number, number] = [d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate()];
      expect(toGregorian(...toJalali(...g))).toEqual(g);
    }
  });
  it('knows leap Esfand', () => {
    expect(jalaliMonthLength(1403, 12)).toBe(30);
    expect(jalaliMonthLength(1404, 12)).toBe(29);
  });
  it('parses and formats', () => {
    const d = parseJalali('۱۴۰۵/۰۷/۱۴', '۱۰:۳۰')!;
    expect(d.getFullYear()).toBe(2026);
    expect(d.getHours()).toBe(10);
    expect(formatJalaliDate(d, false)).toBe('1405/07/14');
    expect(parseJalali('1404/12/30')).toBeNull();
  });
});
