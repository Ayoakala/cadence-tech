import type {TriageIssue} from '../../models/decision.js';
import {collectionPath, elementPath} from '../evidence.js';
import {
  TESTING_REQUIREMENTS,
  isLabCode,
  normalizeLabCode,
} from '../normalize/labs.js';
import {daysPriorTo, formatCalendarDay} from '../../lib/dates.js';
import {indexed, mostRecent, type PolicyContext, type Rule} from './rule.js';
import type {LabResult} from '../../models/submission.js';

/**
 * Rule 2 — Required pre-operative testing by procedure risk.
 *
 *   LOW / MODERATE : CBC within 30 days of the procedure date.
 *   HIGH           : CBC within 14 days and CMP within 14 days.
 *
 * "Only the most recent result for each required test shall be considered", so
 * an in-window recent result is not invalidated by an older stale one — and,
 * conversely, an old result is not rescued by the presence of a newer test of a
 * different type.
 *
 * Without a risk level there is no way to know which panels are required, so
 * the whole rule stands down (DataCompletenessRule reports the null). Without a
 * procedure date the presence check still runs but the window check does not.
 */
export class PreOpTestingRule implements Rule {
  readonly name = 'preop_testing';

  evaluate(context: PolicyContext): TriageIssue[] {
    const risk = context.procedureRisk;
    if (risk === null) return [];

    const issues: TriageIssue[] = [];

    for (const requirement of TESTING_REQUIREMENTS[risk]) {
      const candidates = indexed(context.labs).filter(({value}) =>
        isLabCode(value, requirement.code)
      );
      const latest = mostRecent(candidates, lab => lab.effective_at);

      if (latest === null) {
        issues.push({
          category: 'REQUIRED_TESTING',
          description: `${requirement.code} missing`,
          evidence: {
            source: collectionPath('labs'),
            details: `No ${requirement.code} result with a valid effective_at found for procedure_risk ${risk} (${summarizeLabs(context.labs)})`,
          },
        });
        continue;
      }

      if (context.procedureDate === null) continue;

      const daysPrior = daysPriorTo(context.procedureDate, latest.day);
      if (daysPrior <= requirement.windowDays) continue;

      const lab = latest.entry.value;
      issues.push({
        category: 'REQUIRED_TESTING',
        description: `${requirement.code} outside ${requirement.windowDays}-day window for ${risk} risk procedure`,
        evidence: {
          source: elementPath('labs', latest.entry.index),
          details: `${requirement.code} effective_at ${lab.effective_at} is ${daysPrior} days before procedure_date ${formatCalendarDay(context.procedureDate)}; policy requires within ${requirement.windowDays} days for ${risk} risk`,
        },
      });
    }

    return issues;
  }
}

/** Grounds a "not found" issue by quoting the labs that *are* present. */
function summarizeLabs(labs: readonly LabResult[]): string {
  if (labs.length === 0) return 'the labs collection is empty';
  const seen = labs.map(
    lab =>
      `${normalizeLabCode(lab.code) ?? 'uncoded'}@${lab.effective_at ?? 'no date'}`
  );
  return `labs present: ${seen.join(', ')}`;
}
