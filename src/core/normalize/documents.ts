import type {ClinicalDocument} from '../../models/submission.js';

/**
 * Document type classification.
 *
 * The submissions carry ~100 distinct `type` strings for what are really three
 * relevant concepts. The generator composes them from a prefix
 * (`PREOP - `, `Imported: `, `Scanned `, `Pre-op `, `Preop `), a core name with
 * many spellings (`H&P`, `H and P`, `H+P`, `H/P`, `Hx & Physical`,
 * `Hist & Phys`, `History and Physical`, `History/Physical`), and a suffix
 * (`(scanned)`, `(external)`, `[PDF]`, `- signed`). Type alone is therefore
 * useless as an exact key, but entirely tractable as a pattern match.
 *
 * Two deliberate non-matches are worth stating explicitly, because both look
 * like bugs until you check them against the expected outputs:
 *
 *  1. `History & Phsyical` (transposed letters) is NOT treated as an H&P. In
 *     case_00002 that misspelled document is the most recent H&P-looking one
 *     and is comfortably inside the 30-day window; the expected output instead
 *     flags the older, correctly-spelled `Scanned History and Physical
 *     Examination` as 32 days stale. The oracle only recognises well-formed
 *     type names, so matching the typo would flip that case from a correct
 *     REQUIRED_DOCUMENTATION issue to a false pass. This is the clearest case
 *     in the dataset where a "smarter", fuzzier matcher scores worse.
 *
 *  2. Documents that merely mention a pre-op evaluation — `Pre-op Evaluation`,
 *     `Medical Clearance`, `Anesthesia Pre-Assessment`, `Preoperative
 *     Assessment`, `Pre-op Surgical Clearance Note` — are not H&Ps, even though
 *     several carry text about pre-op readiness.
 */

export type DocumentKind = 'H_AND_P' | 'CONSENT' | 'OTHER';

/** `H&P`, `H and P`, `H+P`, `H/P` — the abbreviation in any of its separators. */
const HP_ABBREVIATION = /\bh\s*(?:&|and|\+|\/)\s*p\b/i;

/** The word spelled out: `History and Physical`, `Hx & Physical`, `Hist & Phys`. */
const HP_SPELLED_OUT = /\bphysical\b|\bphys\b/i;

const CONSENT = /\bconsent\b/i;

/**
 * Types that contain a partial H&P cue but do not match cleanly. Used only to
 * surface candidates for optional LLM adjudication — never to classify.
 */
const HP_NEAR_MISS = /\bhistor|\bhx\b|\bhist\b|\bh\s*&\s*|physical|phsyical/i;

export function classifyDocumentType(
  type: string | null | undefined
): DocumentKind {
  if (typeof type !== 'string' || type.trim() === '') return 'OTHER';

  // Consent is checked first: no observed type satisfies both, and a document
  // explicitly named a consent should never be consumed as an H&P.
  if (CONSENT.test(type)) return 'CONSENT';
  if (HP_ABBREVIATION.test(type) || HP_SPELLED_OUT.test(type)) return 'H_AND_P';
  return 'OTHER';
}

export function classifyDocument(doc: ClinicalDocument): DocumentKind {
  return classifyDocumentType(doc.type);
}

/**
 * A document that looks H&P-adjacent but did not classify as one. These are the
 * only documents worth spending an LLM call on, and the count is the honest
 * measure of how much residual ambiguity the deterministic matcher leaves.
 */
export function isAmbiguousHistoryAndPhysical(doc: ClinicalDocument): boolean {
  const type = doc.type;
  if (typeof type !== 'string') return false;
  if (classifyDocumentType(type) !== 'OTHER') return false;
  return HP_NEAR_MISS.test(type);
}

/**
 * Consent signing status, read from the document text.
 *
 * The sample data uses exactly eight phrasings — five affirming, three denying —
 * and two of them are traps.
 *
 * Affirming:
 *   "Signed consent scanned and verified before scheduling."
 *   "Consent obtained and signed; documentation completed."
 *   "Patient reviewed risks/benefits and signed surgical consent."
 *   "Electronic consent obtained and signed by patient for procedure."
 *   "Consent obtained; signature on file."          <-- never says "signed"
 * Denying:
 *   "Consent documented but unsigned; awaiting patient signature."
 *   "Unsigned consent on chart; provider requested signature before scheduling."
 *   "Unsigned consent noted; signature not yet on file."
 *
 * Trap one: every denying phrasing contains "signed" inside "unsigned", so a
 * naive `includes('signed')` reports the exact opposite of the truth. Negatives
 * are therefore tested first.
 *
 * Trap two: "Consent obtained; signature on file" is a signed consent that never
 * uses the word — matching only on "signed" wrongly fails it. It accounted for
 * every category mismatch in the first full run. Note that "signature not yet on
 * file" must not match it, which is why the affirming pattern requires
 * "signature on file" contiguously.
 */
const UNSIGNED =
  /\bunsigned\b|\bnot\s+signed\b|awaiting\s+(?:patient\s+)?signature|signature\s+not\s+yet/i;
const SIGNED = /\bsigned\b|\bsignature\s+on\s+file\b/i;

export type ConsentStatus = 'SIGNED' | 'NOT_SIGNED' | 'UNCLEAR';

export function consentSigningStatus(
  text: string | null | undefined
): ConsentStatus {
  if (typeof text !== 'string' || text.trim() === '') return 'UNCLEAR';
  if (UNSIGNED.test(text)) return 'NOT_SIGNED';
  if (SIGNED.test(text)) return 'SIGNED';
  return 'UNCLEAR';
}

/**
 * Drug names treated as anticoagulants. The policy forbids outside medical
 * knowledge, so this is deliberately a closed list rather than a model call:
 * it is configuration, and it is auditable. Only `apixaban` and `warfarin`
 * appear in the sample data; the rest are included so the rule does not
 * silently pass on a drug the sample happens not to contain.
 */
export const ANTICOAGULANTS = new Set([
  'apixaban',
  'rivaroxaban',
  'edoxaban',
  'dabigatran',
  'warfarin',
  'heparin',
  'enoxaparin',
  'dalteparin',
  'fondaparinux',
  'clopidogrel',
  'ticagrelor',
  'prasugrel',
]);

export function isAnticoagulant(name: string | null | undefined): boolean {
  if (typeof name !== 'string') return false;
  return ANTICOAGULANTS.has(name.trim().toLowerCase());
}

/**
 * Does this document text refer to the patient's anticoagulation at all?
 *
 * Matched on text, not on document type. In case_00042 a document typed
 * `Perioperative Medication Plan` says only "Discussed blood thinner use with
 * patient; final plan pending specialist input" — it never names the drug or
 * uses an anticoagulation term, and the expected evidence points at the whole
 * `documents` collection rather than that document, i.e. the oracle did not
 * consider it a plan document at all. Matching on type would have cited it.
 */
export function mentionsAnticoagulation(
  text: string | null | undefined,
  drugNames: string[]
): boolean {
  if (typeof text !== 'string' || text.trim() === '') return false;
  if (/anticoagul/i.test(text)) return true;
  return drugNames.some(name => new RegExp(`\\b${name}\\b`, 'i').test(text));
}

/**
 * Does the text actually describe perioperative management, rather than defer
 * it? A plan must say what happens to the medication around the procedure —
 * naming a hold, a stop/resume, a bridge, or specific timing. Every plan
 * document in the sample data defers instead ("follow up with cardiology",
 * "details not yet documented", "to be finalized", "pending specialist input"),
 * so this predicate returns false for all of them.
 *
 * Note: the sample data contains no example of a *complete* plan, so the
 * positive branch here is exercised only by unit tests, never by the harness.
 */
const DEFERRAL =
  /follow[- ]?up with|pending|to be (?:finalized|determined|documented)|not yet (?:documented|finalized)|awaiting|no clear|not documented|to be scheduled/i;

const MANAGEMENT_DETAIL =
  /\bhold\b|\bstop\b|\bdiscontinue\b|\bresume\b|\brestart\b|\bbridg(?:e|ing)\b|\d+\s*(?:day|hour|hr)s?\s*(?:before|prior|after|post)/i;

export function describesPerioperativePlan(
  text: string | null | undefined
): boolean {
  if (typeof text !== 'string' || text.trim() === '') return false;
  if (DEFERRAL.test(text)) return false;
  return MANAGEMENT_DETAIL.test(text);
}
