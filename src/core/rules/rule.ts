import type {TriageIssue} from '../../models/decision.js';
import type {
  ClinicalDocument,
  LabResult,
  Medication,
  PatientSubmission,
  ProcedureRisk,
  Vital,
} from '../../models/submission.js';
import {collections} from '../../models/submission.js';
import {parseCalendarDay, type CalendarDay} from '../../lib/dates.js';
import {
  EMPTY_JUDGMENTS,
  type DocumentJudgments,
} from '../../llm/documentJudge.js';

/**
 * Everything the rules need, resolved once.
 *
 * Two fields drive the policy's date and testing logic — `procedure_date` and
 * `procedure_risk` — and either may be absent. Rather than let each rule
 * rediscover that, the context resolves them up front and the rules consult
 * them. A rule whose *check* depends on a null prerequisite simply does not run
 * that check; it never invents a second issue about the same missing field.
 *
 * This is the single most consequential design decision in the service. The
 * scorer compares the *set* of issue categories for exact equality, and in all
 * seven sample cases where a prerequisite is null the expected set is exactly
 * `{MISSING_REQUIRED_DATA}` — never the downstream documentation or testing
 * categories those nulls also block. Reporting every rule a missing field
 * invalidates is the single easiest way to lose that metric.
 */
export interface PolicyContext {
  readonly submission: PatientSubmission;
  readonly procedureDate: CalendarDay | null;
  readonly procedureRisk: ProcedureRisk | null;
  readonly documents: readonly ClinicalDocument[];
  readonly labs: readonly LabResult[];
  readonly vitals: readonly Vital[];
  readonly medications: readonly Medication[];
  /**
   * Optional per-document overrides supplied by the language model, resolved
   * before the rules run. Empty by default, in which case every rule takes the
   * deterministic path — which is what makes the default configuration
   * reproducible bit-for-bit.
   */
  readonly judgments: DocumentJudgments;
}

export function buildContext(
  submission: PatientSubmission,
  judgments: DocumentJudgments = EMPTY_JUDGMENTS
): PolicyContext {
  const {documents, labs, vitals, medications} = collections(submission);
  return {
    submission,
    procedureDate: parseCalendarDay(submission.procedure?.procedure_date),
    procedureRisk: submission.procedure?.procedure_risk ?? null,
    documents,
    labs,
    vitals,
    medications,
    judgments,
  };
}

/**
 * A rule reports the issues it found. Returning an empty array means the rule
 * is satisfied *or* that it could not run — from the output's perspective those
 * are identical, which is exactly the parsimony the oracle exhibits.
 */
export interface Rule {
  readonly name: string;
  evaluate(context: PolicyContext): TriageIssue[];
}

/** An indexed element, so evidence can cite the position the harness resolves. */
export interface Indexed<T> {
  readonly index: number;
  readonly value: T;
}

export function indexed<T>(items: readonly T[]): Indexed<T>[] {
  return items.map((value, index) => ({index, value}));
}

/**
 * Pick the most recent element by a date accessor, discarding entries whose
 * date does not parse. "Only the most recent result for each required test
 * shall be considered" appears twice in the policy and applies to labs, vitals
 * and documents alike.
 *
 * Ties are broken by the later array position, so a submission that repeats a
 * record on the same day cites the one a reader would scroll to last.
 */
export function mostRecent<T>(
  items: readonly Indexed<T>[],
  toDate: (value: T) => string | null | undefined
): {entry: Indexed<T>; day: CalendarDay} | null {
  let best: {entry: Indexed<T>; day: CalendarDay} | null = null;
  for (const entry of items) {
    const day = parseCalendarDay(toDate(entry.value));
    if (day === null) continue;
    if (best === null || day >= best.day) {
      best = {entry, day};
    }
  }
  return best;
}

/** Short, quotable summary of a document, for grounding evidence details. */
export function describeDocument(doc: ClinicalDocument): string {
  const type = doc.type ?? 'untyped';
  const date = doc.date ?? 'no date';
  return `"${type}" dated ${date}`;
}
