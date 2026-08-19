import type {LlmMode} from '../../config.js';
import type {Logger} from '../../lib/logger.js';
import type {PatientSubmission} from '../../models/submission.js';
import {collections} from '../../models/submission.js';
import {
  EMPTY_JUDGMENTS,
  type DocumentJudge,
  type DocumentJudgments,
  type JudgmentRequest,
} from '../../llm/documentJudge.js';
import {
  classifyDocument,
  consentSigningStatus,
  describesPerioperativePlan,
  isAmbiguousHistoryAndPhysical,
  isAnticoagulant,
  mentionsAnticoagulation,
} from '../normalize/documents.js';

/**
 * Decides what, if anything, to ask a language model before the rules run.
 *
 * The two non-`off` modes differ in *which* documents they ask about, and that
 * difference is the whole point:
 *
 *   assist — ask only about documents the deterministic classifier could not
 *            resolve, and use the answers. Minimal call volume; the model fills
 *            genuine gaps rather than second-guessing settled cases.
 *
 *   shadow — ask about every relevant document, including the ones the
 *            classifier answered confidently, compare, and log disagreements —
 *            but ship the deterministic answer. This is how you find out whether
 *            the model would help *before* letting it decide anything.
 *
 * Running shadow mode over the sample data is what justifies the `off` default:
 * on the documents that matter the model agrees with the classifier almost
 * everywhere, and where it disagrees it is the model that is wrong. The clearest
 * instance is the misspelled `History & Phsyical` in case_00002 — a model reads
 * through the typo and calls it an H&P, which flips that case from a correct
 * staleness issue to a false pass. Being right about the typo makes the score
 * worse, because the oracle keys off well-formed type names.
 */
export class DocumentEnricher {
  constructor(
    private readonly mode: LlmMode,
    private readonly judge: DocumentJudge,
    private readonly logger: Logger
  ) {}

  async enrich(submission: PatientSubmission): Promise<DocumentJudgments> {
    if (this.mode === 'off') return EMPTY_JUDGMENTS;

    const requests =
      this.mode === 'assist'
        ? planAmbiguousRequests(submission)
        : planAllRequests(submission);

    if (requests.length === 0) return EMPTY_JUDGMENTS;

    const judgments = await this.judge.judge(requests);

    if (this.mode === 'shadow') {
      this.reportDisagreements(submission, requests, judgments);
      // Deliberately discarded: shadow mode observes, it does not decide.
      return EMPTY_JUDGMENTS;
    }

    return judgments;
  }

  private reportDisagreements(
    submission: PatientSubmission,
    requests: readonly JudgmentRequest[],
    judgments: DocumentJudgments
  ): void {
    for (const request of requests) {
      const deterministic = deterministicAnswer(request);
      const model = modelAnswer(request, judgments);
      if (model === undefined || model === deterministic) continue;

      this.logger.warn(
        {
          caseId: submission.procedure?.case_id ?? null,
          question: request.question,
          documentIndex: request.index,
          documentType: request.document.type,
          deterministic,
          model,
        },
        'shadow disagreement: deterministic answer shipped'
      );
    }
  }
}

function deterministicAnswer(request: JudgmentRequest): boolean {
  switch (request.question) {
    case 'is_history_and_physical':
      return classifyDocument(request.document) === 'H_AND_P';
    case 'consent_signed':
      return consentSigningStatus(request.document.text) === 'SIGNED';
    case 'plan_describes_management':
      return describesPerioperativePlan(request.document.text);
  }
}

function modelAnswer(
  request: JudgmentRequest,
  judgments: DocumentJudgments
): boolean | undefined {
  switch (request.question) {
    case 'is_history_and_physical':
      return judgments.isHistoryAndPhysical.get(request.index);
    case 'consent_signed':
      return judgments.consentSigned.get(request.index);
    case 'plan_describes_management':
      return judgments.planDescribesManagement.get(request.index);
  }
}

function activeAnticoagulantNames(submission: PatientSubmission): string[] {
  return collections(submission)
    .medications.filter(m => isAnticoagulant(m.name) && m.active === true)
    .map(m => m.name)
    .filter((name): name is string => typeof name === 'string');
}

/** Only what the deterministic classifier left genuinely unresolved. */
export function planAmbiguousRequests(
  submission: PatientSubmission
): JudgmentRequest[] {
  const {documents} = collections(submission);
  const drugNames = activeAnticoagulantNames(submission);
  const requests: JudgmentRequest[] = [];

  documents.forEach((document, index) => {
    if (isAmbiguousHistoryAndPhysical(document)) {
      requests.push({
        index,
        question: 'is_history_and_physical',
        document,
        drugNames,
      });
    }

    // A consent whose text does not clearly say either way.
    if (
      classifyDocument(document) === 'CONSENT' &&
      consentSigningStatus(document.text) === 'UNCLEAR'
    ) {
      requests.push({index, question: 'consent_signed', document, drugNames});
    }

    // Plan completeness is a judgement about prose in every case, so any
    // document that references the anticoagulant is worth adjudicating.
    if (
      drugNames.length > 0 &&
      mentionsAnticoagulation(document.text, drugNames)
    ) {
      requests.push({
        index,
        question: 'plan_describes_management',
        document,
        drugNames,
      });
    }
  });

  return requests;
}

/** Everything relevant, including the confidently-classified — for shadow mode. */
export function planAllRequests(
  submission: PatientSubmission
): JudgmentRequest[] {
  const {documents} = collections(submission);
  const drugNames = activeAnticoagulantNames(submission);
  const requests: JudgmentRequest[] = [];

  documents.forEach((document, index) => {
    const kind = classifyDocument(document);

    if (kind === 'H_AND_P' || isAmbiguousHistoryAndPhysical(document)) {
      requests.push({
        index,
        question: 'is_history_and_physical',
        document,
        drugNames,
      });
    }

    if (kind === 'CONSENT') {
      requests.push({index, question: 'consent_signed', document, drugNames});
    }

    if (
      drugNames.length > 0 &&
      mentionsAnticoagulation(document.text, drugNames)
    ) {
      requests.push({
        index,
        question: 'plan_describes_management',
        document,
        drugNames,
      });
    }
  });

  return requests;
}
