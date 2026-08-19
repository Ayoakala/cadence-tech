import {z} from 'zod';

/**
 * The output contract. This mirrors `TriageOutput` in `core.py` exactly — the
 * Python harness re-validates our JSON against its own pydantic model, so any
 * drift here shows up as a `json_schema_valid` failure in the eval report.
 */

export const DecisionSchema = z.enum([
  'READY',
  'NEEDS_FOLLOW_UP',
  'NOT_CLEARED',
]);
export type Decision = z.infer<typeof DecisionSchema>;

/**
 * Fixed by the harness (`core.py: IssueCategory`). The scorer compares the
 * *set* of categories against the oracle for exact equality, so emitting an
 * extra plausible-but-unexpected category costs the same as missing one.
 */
export const IssueCategorySchema = z.enum([
  'REQUIRED_DOCUMENTATION',
  'REQUIRED_TESTING',
  'ANTICOAGULATION_MANAGEMENT',
  'ACUTE_SAFETY_EXCLUSION',
  'MISSING_REQUIRED_DATA',
]);
export type IssueCategory = z.infer<typeof IssueCategorySchema>;

export const TriageIssueEvidenceSchema = z.object({
  source: z.string(),
  details: z.string(),
});
export type TriageIssueEvidence = z.infer<typeof TriageIssueEvidenceSchema>;

export const TriageIssueSchema = z.object({
  category: IssueCategorySchema,
  description: z.string(),
  evidence: TriageIssueEvidenceSchema,
});
export type TriageIssue = z.infer<typeof TriageIssueSchema>;

export const TriageOutputSchema = z.object({
  decision: DecisionSchema,
  issues: z.array(TriageIssueSchema),
  explanation: z.string(),
});
export type TriageOutput = z.infer<typeof TriageOutputSchema>;

/**
 * The explanation is a mechanical join of the issues, never model-authored.
 * Format is taken from the worked example in the exercise brief:
 *   "CATEGORY: description | CATEGORY: description"
 */
export function buildExplanation(issues: TriageIssue[]): string {
  if (issues.length === 0) {
    return 'All required documentation, testing, anticoagulation planning, and safety checks are satisfied.';
  }
  return issues
    .map(issue => `${issue.category}: ${issue.description}`)
    .join(' | ');
}
