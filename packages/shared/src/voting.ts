import type { PassRule } from './domain.js';

export interface VoteTally {
  /** option → count */
  counts: Record<string, number>;
  totalCast: number;
  /** Voting members present when the vote was closed. */
  eligiblePresent: number;
  /** totalCast / eligiblePresent, 0..100 */
  participationPercent: number;
  passed: boolean;
  passRule: PassRule;
  /** Persian summary line suitable for the minutes. */
  summary: string;
}

export function tallyVotes(
  choices: string[],
  options: readonly string[],
  eligiblePresent: number,
  passRule: PassRule,
): VoteTally {
  const counts: Record<string, number> = {};
  for (const o of options) counts[o] = 0;
  for (const c of choices) {
    if (c in counts) counts[c]++;
  }
  const totalCast = choices.filter((c) => c in counts).length;
  const yes = counts.yes ?? 0;
  const no = counts.no ?? 0;
  let passed: boolean;
  switch (passRule) {
    case 'majority_of_present':
      passed = eligiblePresent > 0 && yes > eligiblePresent / 2;
      break;
    case 'majority_of_cast':
      passed = totalCast > 0 && yes > totalCast / 2;
      break;
    case 'simple_majority':
      passed = yes > no;
      break;
    case 'two_thirds_of_present':
      passed = eligiblePresent > 0 && yes * 3 >= eligiblePresent * 2;
      break;
    default:
      passed = false;
  }
  const participationPercent = eligiblePresent > 0 ? Math.round((totalCast / eligiblePresent) * 1000) / 10 : 0;
  const parts = options.map((o) => `${VOTE_OPTION_LABELS[o] ?? o}: ${counts[o]}`).join('، ');
  const summary = `نتیجه رأی‌گیری — ${parts}؛ مجموع آرا: ${totalCast} از ${eligiblePresent} حاضر؛ ${
    passed ? 'تصویب شد' : 'تصویب نشد'
  }.`;
  return { counts, totalCast, eligiblePresent, participationPercent, passed, passRule, summary };
}

export const VOTE_OPTION_LABELS: Record<string, string> = {
  yes: 'موافق',
  no: 'مخالف',
  abstain: 'ممتنع',
};
