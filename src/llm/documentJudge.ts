import type {ClinicalDocument} from '../models/submission.js';

/**
 * Optional model-supplied judgments about individual documents.
 *
 * The rules stay synchronous and pure. Anything a language model contributes is
 * resolved *before* they run and handed to them as data — a lookup table keyed
 * by document index. That keeps three properties that would otherwise be lost:
 *
 *   - every rule remains a pure function, unit-testable with no mocking
 *   - the model is genuinely optional; `EMPTY` reproduces the deterministic path
 *     exactly, which is why `TRIAGE_LLM_MODE=off` is bit-for-bit reproducible
 *   - all network I/O happens in one place, in one batch, rather than scattered
 *     through the policy logic
 *
 * A missing entry means "no opinion, use the deterministic answer" — the map is
 * an override layer, not a replacement.
 */
export interface DocumentJudgments {
  readonly isHistoryAndPhysical: ReadonlyMap<number, boolean>;
  readonly consentSigned: ReadonlyMap<number, boolean>;
  readonly planDescribesManagement: ReadonlyMap<number, boolean>;
}

export const EMPTY_JUDGMENTS: DocumentJudgments = {
  isHistoryAndPhysical: new Map(),
  consentSigned: new Map(),
  planDescribesManagement: new Map(),
};

/** The three questions in the policy that are genuinely about prose. */
export type JudgmentQuestion =
  | 'is_history_and_physical'
  | 'consent_signed'
  | 'plan_describes_management';

export interface JudgmentRequest {
  readonly index: number;
  readonly question: JudgmentQuestion;
  readonly document: ClinicalDocument;
  /** Active anticoagulant names, for the plan question. */
  readonly drugNames: readonly string[];
}

export interface DocumentJudge {
  judge(requests: readonly JudgmentRequest[]): Promise<DocumentJudgments>;
}

/** Used when `TRIAGE_LLM_MODE=off`: no calls, no opinions. */
export class NullDocumentJudge implements DocumentJudge {
  async judge(): Promise<DocumentJudgments> {
    return EMPTY_JUDGMENTS;
  }
}

export function buildJudgments(
  answers: readonly {request: JudgmentRequest; verdict: boolean}[]
): DocumentJudgments {
  const isHistoryAndPhysical = new Map<number, boolean>();
  const consentSigned = new Map<number, boolean>();
  const planDescribesManagement = new Map<number, boolean>();

  for (const {request, verdict} of answers) {
    switch (request.question) {
      case 'is_history_and_physical':
        isHistoryAndPhysical.set(request.index, verdict);
        break;
      case 'consent_signed':
        consentSigned.set(request.index, verdict);
        break;
      case 'plan_describes_management':
        planDescribesManagement.set(request.index, verdict);
        break;
    }
  }

  return {isHistoryAndPhysical, consentSigned, planDescribesManagement};
}
