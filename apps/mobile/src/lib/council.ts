import type { CaseStatus } from '@kx/shared';
import type { Tone } from '../components/ui';

/** Colour of each council case status. */
export const CASE_TONE: Record<CaseStatus, Tone> = {
  expert_review: 'info',
  on_agenda: 'accent',
  pending_approval: 'warning',
  resolved: 'success',
  returned: 'warning',
  closed: 'neutral',
};
