import type {TriageIssue} from '../../models/decision.js';
import {collectionPath, elementPath} from '../evidence.js';
import {
  classifyDocument,
  consentSigningStatus,
} from '../normalize/documents.js';
import {daysPriorTo, formatCalendarDay} from '../../lib/dates.js';
import {
  describeDocument,
  indexed,
  mostRecent,
  type Indexed,
  type PolicyContext,
  type Rule,
} from './rule.js';
import type {ClinicalDocument} from '../../models/submission.js';

const HP_WINDOW_DAYS = 30;

/**
 * Rule 1 — Required documentation.
 *
 *   1. History and Physical, completed within 30 days of the procedure date.
 *   2. Signed Surgical Consent.
 *
 * Split into presence and freshness. Presence does not depend on the procedure
 * date, so a submission with a null `procedure_date` is still checked for the
 * existence of both documents; only the 30-day comparison is skipped. That
 * keeps a genuinely absent consent visible even when the date is missing,
 * without inventing a staleness claim that cannot be computed.
 */
export class RequiredDocumentationRule implements Rule {
  readonly name = 'required_documentation';

  evaluate(context: PolicyContext): TriageIssue[] {
    return [
      ...this.historyAndPhysical(context),
      ...this.surgicalConsent(context),
    ];
  }

  private historyAndPhysical(context: PolicyContext): TriageIssue[] {
    const candidates = indexed(context.documents).filter(
      ({index, value}) =>
        // A model judgment, when present, overrides the classifier for this one
        // document; absent one, the deterministic answer stands.
        context.judgments.isHistoryAndPhysical.get(index) ??
        classifyDocument(value) === 'H_AND_P'
    );

    const latest = mostRecent(candidates, doc => doc.date);
    if (latest === null) {
      return [
        {
          category: 'REQUIRED_DOCUMENTATION',
          description: 'History and Physical document missing',
          evidence: {
            source: collectionPath('documents'),
            details: `No History and Physical document with a valid date found among ${context.documents.length} documents (${summarizeTypes(context.documents)})`,
          },
        },
      ];
    }

    // Freshness needs the procedure date; DataCompletenessRule already reports
    // its absence, so stop here rather than duplicating that signal.
    if (context.procedureDate === null) return [];

    const daysPrior = daysPriorTo(context.procedureDate, latest.day);
    if (daysPrior <= HP_WINDOW_DAYS) return [];

    const doc = latest.entry.value;
    return [
      {
        category: 'REQUIRED_DOCUMENTATION',
        description: `H&P outside ${HP_WINDOW_DAYS}-day window`,
        evidence: {
          source: elementPath('documents', latest.entry.index),
          details: `H&P ${describeDocument(doc)} is ${daysPrior} days before procedure_date ${formatCalendarDay(context.procedureDate)}; policy requires completion within ${HP_WINDOW_DAYS} days`,
        },
      },
    ];
  }

  private surgicalConsent(context: PolicyContext): TriageIssue[] {
    const candidates = indexed(context.documents).filter(
      ({value}) => classifyDocument(value) === 'CONSENT'
    );

    if (candidates.length === 0) {
      return [
        {
          category: 'REQUIRED_DOCUMENTATION',
          description: 'Signed surgical consent missing',
          evidence: {
            source: collectionPath('documents'),
            details: `No Surgical Consent document found among ${context.documents.length} documents (${summarizeTypes(context.documents)})`,
          },
        },
      ];
    }

    // The policy requires a *signed* consent, so a consent whose text says it is
    // unsigned does not satisfy it. Any single clearly-signed consent is enough.
    const signed = candidates.find(
      ({index, value}) =>
        context.judgments.consentSigned.get(index) ??
        consentSigningStatus(value.text) === 'SIGNED'
    );
    if (signed !== undefined) return [];

    const cited = pickCitedConsent(candidates);
    const doc = cited.value;
    return [
      {
        category: 'REQUIRED_DOCUMENTATION',
        description: 'Surgical consent not clearly signed',
        evidence: {
          source: elementPath('documents', cited.index),
          details: `Consent ${describeDocument(doc)} does not clearly indicate signed consent: ${JSON.stringify(doc.text ?? '')}`,
        },
      },
    ];
  }
}

/**
 * Which consent to point at when none is signed: prefer an explicitly unsigned
 * one over a merely silent one, since that is the document a scheduler would
 * need to chase. Falls back to the most recent.
 */
function pickCitedConsent(
  candidates: Indexed<ClinicalDocument>[]
): Indexed<ClinicalDocument> {
  const explicit = candidates.find(
    ({value}) => consentSigningStatus(value.text) === 'NOT_SIGNED'
  );
  if (explicit !== undefined) return explicit;

  const latest = mostRecent(candidates, doc => doc.date);
  // `candidates` is non-empty here, so the final fallback is always defined.
  return latest?.entry ?? (candidates[0] as Indexed<ClinicalDocument>);
}

/**
 * Quote the document types actually present. Beyond being useful to a reader,
 * this is what grounds a "not found" issue: the harness requires that every
 * non-MISSING issue's details cite a concrete value from the submission, and a
 * missing document has no value of its own to cite.
 */
function summarizeTypes(documents: readonly ClinicalDocument[]): string {
  if (documents.length === 0) return 'the documents collection is empty';
  const types = documents.map(d => JSON.stringify(d.type ?? 'untyped'));
  return `types present: ${types.join(', ')}`;
}
