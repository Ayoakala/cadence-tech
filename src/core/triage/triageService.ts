import {
  buildExplanation,
  type TriageIssue,
  type TriageOutput,
} from '../../models/decision.js';
import type {PatientSubmission} from '../../models/submission.js';
import {buildContext, type Rule} from '../rules/rule.js';
import {DataCompletenessRule} from '../rules/dataCompleteness.js';
import {RequiredDocumentationRule} from '../rules/requiredDocumentation.js';
import {PreOpTestingRule} from '../rules/preOpTesting.js';
import {AnticoagulationRule} from '../rules/anticoagulation.js';
import {AcuteSafetyRule} from '../rules/acuteSafety.js';
import {orderIssues, resolveDecision} from './decisionResolver.js';
import type {DocumentEnricher} from './enrichment.js';
import {
  EMPTY_JUDGMENTS,
  type DocumentJudgments,
} from '../../llm/documentJudge.js';

/**
 * Runs the policy over one submission.
 *
 * The rules are independent and pure: each receives the resolved context and
 * returns the issues it found. There is no shared mutable state and no ordering
 * dependency between them, so the whole evaluation is a fold over a list — which
 * is what makes it trivially testable and bit-for-bit reproducible.
 *
 * DataCompletenessRule runs first by convention (it owns every
 * MISSING_REQUIRED_DATA issue) but the output does not depend on the order.
 */
export const DEFAULT_RULES: readonly Rule[] = [
  new DataCompletenessRule(),
  new RequiredDocumentationRule(),
  new PreOpTestingRule(),
  new AnticoagulationRule(),
  new AcuteSafetyRule(),
];

export class TriageService {
  constructor(
    private readonly rules: readonly Rule[] = DEFAULT_RULES,
    /**
     * Optional model-backed enrichment. When absent (the default) the service is
     * fully synchronous and makes no network calls, which is what the unit tests
     * and `TRIAGE_LLM_MODE=off` exercise.
     */
    private readonly enricher?: DocumentEnricher
  ) {}

  /**
   * Resolve any model judgments, then apply the policy. The two steps are kept
   * separate so the policy itself never awaits anything.
   */
  async triageAsync(submission: PatientSubmission): Promise<TriageOutput> {
    const judgments =
      this.enricher === undefined
        ? EMPTY_JUDGMENTS
        : await this.enricher.enrich(submission);
    return this.triage(submission, judgments);
  }

  triage(
    submission: PatientSubmission,
    judgments: DocumentJudgments = EMPTY_JUDGMENTS
  ): TriageOutput {
    const context = buildContext(submission, judgments);

    const issues: TriageIssue[] = [];
    for (const rule of this.rules) {
      issues.push(...rule.evaluate(context));
    }

    const ordered = orderIssues(issues);
    return {
      decision: resolveDecision(ordered),
      issues: ordered,
      explanation: buildExplanation(ordered),
    };
  }
}
