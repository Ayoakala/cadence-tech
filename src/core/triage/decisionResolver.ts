import type {
  Decision,
  IssueCategory,
  TriageIssue,
} from '../../models/decision.js';

/**
 * Maps a set of issues onto exactly one clearance status.
 *
 * The policy defines three statuses and requires exactly one, so precedence has
 * to be explicit:
 *
 *   NOT_CLEARED      an acute safety exclusion is present — a hard stop that
 *                    outranks every paperwork problem
 *   NEEDS_FOLLOW_UP  anything else outstanding
 *   READY            nothing outstanding
 *
 * NOT_CLEARED does not suppress the other issues. case_00002 is NOT_CLEARED for
 * a temperature of 101.0 *and* still reports its stale H&P — the scheduler needs
 * the full list of what to chase, not just the blocking item.
 */

/** Stable presentation order, most blocking first. */
const CATEGORY_ORDER: readonly IssueCategory[] = [
  'ACUTE_SAFETY_EXCLUSION',
  'MISSING_REQUIRED_DATA',
  'REQUIRED_DOCUMENTATION',
  'REQUIRED_TESTING',
  'ANTICOAGULATION_MANAGEMENT',
];

export function resolveDecision(issues: readonly TriageIssue[]): Decision {
  if (issues.some(issue => issue.category === 'ACUTE_SAFETY_EXCLUSION')) {
    return 'NOT_CLEARED';
  }
  return issues.length === 0 ? 'READY' : 'NEEDS_FOLLOW_UP';
}

/**
 * Sort issues into a stable order. Rules run in a fixed sequence already, so
 * this is about presentation rather than determinism — but it also means the
 * explanation string reads blocking-first.
 */
export function orderIssues(issues: readonly TriageIssue[]): TriageIssue[] {
  return [...issues].sort((a, b) => {
    const rank =
      CATEGORY_ORDER.indexOf(a.category) - CATEGORY_ORDER.indexOf(b.category);
    return rank !== 0 ? rank : a.description.localeCompare(b.description);
  });
}
