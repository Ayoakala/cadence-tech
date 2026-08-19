import {describe, expect, it} from 'vitest';
import {
  classifyDocumentType,
  consentSigningStatus,
  describesPerioperativePlan,
  isAmbiguousHistoryAndPhysical,
  isAnticoagulant,
  mentionsAnticoagulation,
} from './documents.js';

describe('classifyDocumentType', () => {
  // A representative slice of the ~100 type strings in the sample data,
  // covering every prefix, core spelling and suffix the generator combines.
  it.each([
    'History and Physical',
    'H&P Note',
    'H&P [PDF]',
    'Pre-op H and P',
    'PREOP - H and P - signed',
    'H+P (H&P) (external)',
    'H/P (H&P) (external)',
    'Hx & Physical (H&P)',
    'Hist & Phys (H&P)',
    'History/Physical (H&P)',
    'Scanned History and Physical Examination',
    'Preop History and Physical Examination (external)',
    'History & Physical Exam (H&P) (scanned)',
    'Imported: Pre-anesthesia H&P (external)',
    'Scanned Hospitalist H&P',
    'History and Physical Examination - signed',
  ])('recognises %j as an H&P', type => {
    expect(classifyDocumentType(type)).toBe('H_AND_P');
  });

  it.each([
    'Surgical Consent',
    'Consent for Surgery',
    'Consent Counseling Note',
    'Procedure Consent Packet',
    'Surgery Consent (scanned)',
    'Consent - Elective Procedure',
    'Procedure Consent Form',
    'Pre-op Consent Discussion',
  ])('recognises %j as a consent', type => {
    expect(classifyDocumentType(type)).toBe('CONSENT');
  });

  it.each([
    'Pre-op Nursing Intake',
    'Anesthesia Pre-Assessment',
    'Clinic Follow-up Note',
    'Preop Pre-anesthesia Evaluation [PDF]',
    'Medical Clearance [PDF]',
    'Pre-op Evaluation [PDF]',
    'Imported: Preoperative Assessment [PDF]',
    'Pre-op Surgical Clearance Note [PDF]',
    'Cardiology Progress Note - Anticoag',
  ])('treats %j as neither', type => {
    expect(classifyDocumentType(type)).toBe('OTHER');
  });

  // Regression guard for case_00002. The misspelled document is the most recent
  // H&P-looking one and is inside the 30-day window; recognising it would flip
  // that case from a correct staleness issue to a false pass.
  it('does not recognise the misspelled "History & Phsyical"', () => {
    expect(classifyDocumentType('History & Phsyical')).toBe('OTHER');
  });

  it('flags the misspelling as ambiguous for optional LLM adjudication', () => {
    expect(isAmbiguousHistoryAndPhysical({type: 'History & Phsyical'})).toBe(
      true
    );
    expect(isAmbiguousHistoryAndPhysical({type: 'Pre-op Nursing Intake'})).toBe(
      false
    );
    expect(isAmbiguousHistoryAndPhysical({type: 'H&P Note'})).toBe(false);
  });

  it('classifies a consent before an H&P when both cues appear', () => {
    expect(classifyDocumentType('Consent for Physical Procedure')).toBe(
      'CONSENT'
    );
  });

  it.each([null, undefined, '', '   '])('treats %j as OTHER', type => {
    expect(classifyDocumentType(type)).toBe('OTHER');
  });
});

describe('consentSigningStatus', () => {
  it.each([
    'Signed consent scanned and verified before scheduling.',
    'Consent obtained and signed; documentation completed.',
    'Patient reviewed risks/benefits and signed surgical consent.',
    'Electronic consent obtained and signed by patient for procedure.',
    // Signed without ever using the word — this one phrasing accounted for
    // every category mismatch in the first full eval run.
    'Consent obtained; signature on file.',
  ])('reads %j as SIGNED', text => {
    expect(consentSigningStatus(text)).toBe('SIGNED');
  });

  it.each([
    'Consent documented but unsigned; awaiting patient signature.',
    'Unsigned consent on chart; provider requested signature before scheduling.',
    'Unsigned consent noted; signature not yet on file.',
  ])('reads %j as NOT_SIGNED', text => {
    expect(consentSigningStatus(text)).toBe('NOT_SIGNED');
  });

  it('does not let "signature not yet on file" match "signature on file"', () => {
    expect(
      consentSigningStatus('Unsigned consent noted; signature not yet on file.')
    ).toBe('NOT_SIGNED');
  });

  it.each([null, undefined, ''])('reads %j as UNCLEAR', text => {
    expect(consentSigningStatus(text)).toBe('UNCLEAR');
  });

  it('reads a consent that says nothing about signing as UNCLEAR', () => {
    expect(consentSigningStatus('Consent discussion documented.')).toBe(
      'UNCLEAR'
    );
  });
});

describe('isAnticoagulant', () => {
  it.each(['apixaban', 'warfarin', 'Apixaban', ' WARFARIN '])(
    'recognises %j',
    name => {
      expect(isAnticoagulant(name)).toBe(true);
    }
  );

  it.each(['lisinopril', 'metformin', null, undefined, ''])(
    'does not recognise %j',
    name => {
      expect(isAnticoagulant(name)).toBe(false);
    }
  );
});

describe('mentionsAnticoagulation', () => {
  const drugs = ['apixaban'];

  it('matches an explicit anticoagulation term', () => {
    expect(
      mentionsAnticoagulation(
        'Anticoagulation mentioned; no clear hold/resume guidance documented.',
        drugs
      )
    ).toBe(true);
  });

  it('matches the drug by name', () => {
    expect(
      mentionsAnticoagulation(
        'Apixaban listed; perioperative management plan to be finalized.',
        drugs
      )
    ).toBe(true);
  });

  // Regression guard for case_00042: a document typed "Perioperative Medication
  // Plan" that only says "blood thinner". The expected evidence points at the
  // whole documents collection, so the oracle did not treat it as a plan doc.
  it('does not match the "blood thinner" euphemism', () => {
    expect(
      mentionsAnticoagulation(
        'Discussed blood thinner use with patient; final plan pending specialist input.',
        drugs
      )
    ).toBe(false);
  });
});

describe('describesPerioperativePlan', () => {
  it.each([
    'Patient takes apixaban for atrial fibrillation. Follow up with cardiology for peri-op recommendations.',
    'Anticoagulation mentioned; no clear hold/resume guidance documented.',
    'Anticoagulant noted in medication list; perioperative management details not yet documented.',
    'Apixaban listed; perioperative management plan to be finalized.',
    'Discussed blood thinner use with patient; final plan pending specialist input.',
  ])('rejects the deferral %j', text => {
    expect(describesPerioperativePlan(text)).toBe(false);
  });

  // The sample data contains no complete plan, so the positive branch is
  // exercised only here. Without these cases the rule would be indistinguishable
  // from "always fail when an anticoagulant is active".
  it.each([
    'Hold apixaban 48 hours before the procedure and resume 24 hours after.',
    'Stop warfarin 5 days prior; bridge with enoxaparin; restart post-op day 1.',
  ])('accepts the complete plan %j', text => {
    expect(describesPerioperativePlan(text)).toBe(true);
  });
});
