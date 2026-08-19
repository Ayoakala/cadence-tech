import {describe, expect, it} from 'vitest';
import type {IssueCategory} from '../../models/decision.js';
import {PatientSubmissionSchema} from '../../models/submission.js';
import {isResolvableSource} from '../evidence.js';
import {AcuteSafetyRule} from './acuteSafety.js';
import {AnticoagulationRule} from './anticoagulation.js';
import {DataCompletenessRule} from './dataCompleteness.js';
import {PreOpTestingRule} from './preOpTesting.js';
import {RequiredDocumentationRule} from './requiredDocumentation.js';
import {buildContext, type Rule} from './rule.js';

/**
 * Builds a minimal submission that satisfies every rule, so each test can break
 * exactly one thing. Without this baseline, a test for (say) a stale CBC would
 * also trip the documentation and vitals rules and assert nothing useful.
 */
function submission(overrides: Record<string, unknown> = {}) {
  return PatientSubmissionSchema.parse({
    procedure: {
      case_id: 'case-test',
      procedure_risk: 'MODERATE',
      procedure_date: '2026-03-01',
    },
    vitals: [
      {
        type: 'blood_pressure',
        systolic: 120,
        diastolic: 78,
        date: '2026-02-24T10:12:00Z',
      },
      {type: 'temperature', value_f: 98.6, date: '2026-02-24T10:15:00Z'},
    ],
    labs: [
      {code: 'CBC', effective_at: '2026-02-21T08:10:00Z', status: 'final'},
    ],
    medications: [{name: 'lisinopril', active: true}],
    conditions: [],
    documents: [
      {
        type: 'History and Physical',
        date: '2026-02-19',
        text: 'HISTORY AND PHYSICAL: pre-op evaluation complete.',
      },
      {
        type: 'Surgical Consent',
        date: '2026-02-23',
        text: 'Consent obtained and signed; documentation completed.',
      },
    ],
    ...overrides,
  });
}

function run(rule: Rule, overrides: Record<string, unknown> = {}) {
  return rule.evaluate(buildContext(submission(overrides)));
}

function categories(rule: Rule, overrides: Record<string, unknown> = {}) {
  return run(rule, overrides).map(i => i.category);
}

/** Every rule must emit sources the harness can actually resolve. */
function expectResolvableSources(
  rule: Rule,
  overrides: Record<string, unknown> = {}
) {
  for (const issue of run(rule, overrides)) {
    expect(
      isResolvableSource(issue.evidence.source),
      `unresolvable source ${issue.evidence.source}`
    ).toBe(true);
  }
}

describe('the satisfied baseline', () => {
  it('produces no issues from any rule', () => {
    const rules: Rule[] = [
      new DataCompletenessRule(),
      new RequiredDocumentationRule(),
      new PreOpTestingRule(),
      new AnticoagulationRule(),
      new AcuteSafetyRule(),
    ];
    for (const rule of rules) {
      expect(run(rule), `${rule.name} should be satisfied`).toEqual([]);
    }
  });
});

describe('DataCompletenessRule', () => {
  const rule = new DataCompletenessRule();

  it('reports a null procedure date', () => {
    const issues = run(rule, {
      procedure: {procedure_risk: 'MODERATE', procedure_date: null},
    });
    expect(issues).toHaveLength(1);
    expect(issues[0]?.category).toBe('MISSING_REQUIRED_DATA');
    expect(issues[0]?.evidence.source).toBe('procedure.procedure_date');
  });

  it('reports a null procedure risk', () => {
    const issues = run(rule, {
      procedure: {procedure_risk: null, procedure_date: '2026-03-01'},
    });
    expect(issues.map(i => i.evidence.source)).toEqual([
      'procedure.procedure_risk',
    ]);
  });

  it('reports an unparseable risk the same as a missing one', () => {
    const issues = run(rule, {
      procedure: {procedure_risk: 'CRITICAL', procedure_date: '2026-03-01'},
    });
    expect(issues.map(i => i.evidence.source)).toEqual([
      'procedure.procedure_risk',
    ]);
  });

  // `active: null` means "cannot tell", which is a different outcome from
  // "not taking". Treating it as false would silently skip Rule 3.
  it('reports an anticoagulant with unknown active status', () => {
    const issues = run(rule, {
      medications: [
        {name: 'lisinopril', active: true},
        {name: 'warfarin', active: null},
      ],
    });
    expect(issues).toHaveLength(1);
    expect(issues[0]?.description).toBe('Unknown anticoagulant active status');
    expect(issues[0]?.evidence.source).toBe('medications[1]');
    expect(issues[0]?.evidence.details).toContain('warfarin');
  });

  it('does not report an anticoagulant that is explicitly inactive', () => {
    expect(
      run(rule, {
        medications: [
          {name: 'lisinopril', active: true},
          {name: 'warfarin', active: false},
        ],
      })
    ).toEqual([]);
  });

  it('reports missing blood pressure and temperature separately', () => {
    const issues = run(rule, {vitals: []});
    expect(issues.map(i => i.description)).toEqual([
      'Missing latest blood pressure',
      'Missing latest temperature',
    ]);
  });

  it('treats a vital with an unparseable date as absent', () => {
    const issues = run(rule, {
      vitals: [
        {type: 'blood_pressure', systolic: 120, diastolic: 78, date: 'unknown'},
        {type: 'temperature', value_f: 98.6, date: '2026-02-24T10:15:00Z'},
      ],
    });
    expect(issues.map(i => i.description)).toEqual([
      'Missing latest blood pressure',
    ]);
  });
});

describe('RequiredDocumentationRule', () => {
  const rule = new RequiredDocumentationRule();

  it('reports a missing H&P', () => {
    const issues = run(rule, {
      documents: [
        {
          type: 'Surgical Consent',
          date: '2026-02-23',
          text: 'Consent obtained and signed.',
        },
      ],
    });
    expect(issues.map(i => i.description)).toEqual([
      'History and Physical document missing',
    ]);
    expect(issues[0]?.evidence.source).toBe('documents');
    // A "not found" issue has no value of its own to cite, so it grounds itself
    // by quoting what *is* present.
    expect(issues[0]?.evidence.details).toContain('Surgical Consent');
  });

  it('reports a missing consent', () => {
    const issues = run(rule, {
      documents: [{type: 'H&P Note', date: '2026-02-19', text: 'H&P done.'}],
    });
    expect(issues.map(i => i.description)).toEqual([
      'Signed surgical consent missing',
    ]);
  });

  it('accepts an H&P exactly 30 days before the procedure', () => {
    expect(
      run(rule, {
        documents: [
          {type: 'H&P Note', date: '2026-01-30', text: 'H&P done.'},
          {
            type: 'Surgical Consent',
            date: '2026-02-23',
            text: 'Consent obtained and signed.',
          },
        ],
        procedure: {procedure_risk: 'MODERATE', procedure_date: '2026-03-01'},
      })
    ).toEqual([]);
  });

  it('rejects an H&P 31 days before the procedure', () => {
    const issues = run(rule, {
      documents: [
        {type: 'H&P Note', date: '2026-01-29', text: 'H&P done.'},
        {
          type: 'Surgical Consent',
          date: '2026-02-23',
          text: 'Consent obtained and signed.',
        },
      ],
      procedure: {procedure_risk: 'MODERATE', procedure_date: '2026-03-01'},
    });
    expect(issues.map(i => i.description)).toEqual([
      'H&P outside 30-day window',
    ]);
    expect(issues[0]?.evidence.source).toBe('documents[0]');
    expect(issues[0]?.evidence.details).toContain('2026-01-29');
  });

  // The presence check does not depend on the procedure date, but the freshness
  // check does. With a null date the rule must stay silent about staleness
  // rather than duplicate the MISSING_REQUIRED_DATA signal.
  it('skips the freshness check when the procedure date is null', () => {
    expect(
      run(rule, {
        documents: [
          {type: 'H&P Note', date: '2020-01-01', text: 'Ancient H&P.'},
          {
            type: 'Surgical Consent',
            date: '2026-02-23',
            text: 'Consent obtained and signed.',
          },
        ],
        procedure: {procedure_risk: 'MODERATE', procedure_date: null},
      })
    ).toEqual([]);
  });

  it('still reports an absent consent when the procedure date is null', () => {
    const issues = run(rule, {
      documents: [{type: 'H&P Note', date: '2026-02-19', text: 'H&P done.'}],
      procedure: {procedure_risk: 'MODERATE', procedure_date: null},
    });
    expect(issues.map(i => i.description)).toEqual([
      'Signed surgical consent missing',
    ]);
  });

  it('considers only the most recent H&P', () => {
    // The older document is stale but irrelevant; the recent one governs.
    expect(
      run(rule, {
        documents: [
          {type: 'H&P Note', date: '2026-02-19', text: 'Current H&P.'},
          {
            type: 'Preop H&P (external)',
            date: '2025-11-01',
            text: 'Prior pre-op H&P retained for longitudinal chart context.',
          },
          {
            type: 'Surgical Consent',
            date: '2026-02-23',
            text: 'Consent obtained and signed.',
          },
        ],
      })
    ).toEqual([]);
  });

  it('reports an unsigned consent and cites it', () => {
    const issues = run(rule, {
      documents: [
        {type: 'H&P Note', date: '2026-02-19', text: 'H&P done.'},
        {
          type: 'Surgical Consent',
          date: '2026-02-23',
          text: 'Consent documented but unsigned; awaiting patient signature.',
        },
      ],
    });
    expect(issues.map(i => i.description)).toEqual([
      'Surgical consent not clearly signed',
    ]);
    expect(issues[0]?.evidence.source).toBe('documents[1]');
    expect(issues[0]?.evidence.details).toContain('unsigned');
  });

  it('accepts one signed consent among several unsigned ones', () => {
    expect(
      run(rule, {
        documents: [
          {type: 'H&P Note', date: '2026-02-19', text: 'H&P done.'},
          {
            type: 'Consent Counseling Note',
            date: '2026-02-20',
            text: 'Unsigned consent noted; signature not yet on file.',
          },
          {
            type: 'Surgical Consent',
            date: '2026-02-23',
            text: 'Consent obtained; signature on file.',
          },
        ],
      })
    ).toEqual([]);
  });

  it('emits resolvable sources in every failure mode', () => {
    expectResolvableSources(rule, {documents: []});
    expectResolvableSources(rule, {
      documents: [
        {type: 'H&P Note', date: '2026-01-01', text: 'Stale.'},
        {type: 'Surgical Consent', date: '2026-02-23', text: 'Unsigned.'},
      ],
    });
  });
});

describe('PreOpTestingRule', () => {
  const rule = new PreOpTestingRule();

  it('stands down entirely when the risk level is unknown', () => {
    // Without a risk level there is no way to know which panels are required,
    // so inventing a testing issue would contradict the oracle's parsimony.
    expect(
      run(rule, {
        procedure: {procedure_risk: null, procedure_date: '2026-03-01'},
        labs: [],
      })
    ).toEqual([]);
  });

  it('requires only a CBC for MODERATE risk', () => {
    expect(categories(rule, {labs: []})).toEqual<IssueCategory[]>([
      'REQUIRED_TESTING',
    ]);
    expect(run(rule, {labs: []})[0]?.description).toBe('CBC missing');
  });

  it('requires both CBC and CMP for HIGH risk', () => {
    const issues = run(rule, {
      procedure: {procedure_risk: 'HIGH', procedure_date: '2026-03-01'},
      labs: [],
    });
    expect(issues.map(i => i.description)).toEqual([
      'CBC missing',
      'CMP missing',
    ]);
  });

  it('accepts LAB-CBC as a CBC', () => {
    expect(
      run(rule, {
        labs: [{code: 'LAB-CBC', effective_at: '2026-02-21T08:10:00Z'}],
      })
    ).toEqual([]);
  });

  it('uses only the most recent result of a panel', () => {
    // The stale CBC must not fail the rule when a fresh one exists...
    expect(
      run(rule, {
        labs: [
          {code: 'CBC', effective_at: '2026-01-01T08:00:00Z'},
          {code: 'CBC', effective_at: '2026-02-21T08:10:00Z'},
        ],
      })
    ).toEqual([]);
    // ...and a fresh result of a *different* panel must not rescue a stale CBC.
    const stale = run(rule, {
      labs: [
        {code: 'CBC', effective_at: '2026-01-01T08:00:00Z'},
        {code: 'HBA1C', effective_at: '2026-02-21T08:10:00Z'},
      ],
    });
    expect(stale.map(i => i.description)).toEqual([
      'CBC outside 30-day window for MODERATE risk procedure',
    ]);
  });

  it('applies the 14-day window for HIGH risk', () => {
    const issues = run(rule, {
      procedure: {procedure_risk: 'HIGH', procedure_date: '2026-03-01'},
      labs: [
        {code: 'CBC', effective_at: '2026-02-10T08:00:00Z'},
        {code: 'CMP', effective_at: '2026-02-16T08:00:00Z'},
      ],
    });
    // CBC is 19 days out (fails at 14), CMP is 13 days out (passes).
    expect(issues.map(i => i.description)).toEqual([
      'CBC outside 14-day window for HIGH risk procedure',
    ]);
    expect(issues[0]?.evidence.source).toBe('labs[0]');
  });

  it('checks presence but not freshness when the procedure date is null', () => {
    expect(
      run(rule, {
        procedure: {procedure_risk: 'MODERATE', procedure_date: null},
        labs: [{code: 'CBC', effective_at: '2020-01-01T08:00:00Z'}],
      })
    ).toEqual([]);
    expect(
      categories(rule, {
        procedure: {procedure_risk: 'MODERATE', procedure_date: null},
        labs: [],
      })
    ).toEqual<IssueCategory[]>(['REQUIRED_TESTING']);
  });

  it('treats a lab with an unparseable effective_at as absent', () => {
    expect(
      run(rule, {labs: [{code: 'CBC', effective_at: null}]})[0]?.description
    ).toBe('CBC missing');
  });
});

describe('AnticoagulationRule', () => {
  const rule = new AnticoagulationRule();
  const activeApixaban = [
    {name: 'lisinopril', active: true},
    {name: 'apixaban', active: true},
  ];

  it('is satisfied when no anticoagulant is active', () => {
    expect(run(rule)).toEqual([]);
  });

  // The three warfarin cases in the sample data expect only
  // MISSING_REQUIRED_DATA, with no anticoagulation issue alongside it.
  it('stands down when the anticoagulant status is unknown', () => {
    expect(
      run(rule, {
        medications: [
          {name: 'lisinopril', active: true},
          {name: 'warfarin', active: null},
        ],
      })
    ).toEqual([]);
  });

  it('reports a missing plan and cites the collection', () => {
    const issues = run(rule, {medications: activeApixaban});
    expect(issues.map(i => i.category)).toEqual<IssueCategory[]>([
      'ANTICOAGULATION_MANAGEMENT',
    ]);
    expect(issues[0]?.evidence.source).toBe('documents');
    // Grounds against medications[].name, since no document can be cited.
    expect(issues[0]?.evidence.details).toContain('apixaban');
  });

  it('cites the specific document when one mentions anticoagulation', () => {
    const issues = run(rule, {
      medications: activeApixaban,
      documents: [
        {type: 'H&P Note', date: '2026-02-19', text: 'H&P done.'},
        {
          type: 'Surgical Consent',
          date: '2026-02-23',
          text: 'Consent obtained and signed.',
        },
        {
          type: 'Perioperative Medication Plan',
          date: '2026-02-22',
          text: 'Anticoagulant noted in medication list; perioperative management details not yet documented.',
        },
      ],
    });
    expect(issues[0]?.evidence.source).toBe('documents[2]');
  });

  // Regression guard for case_00042: the plan document is located by text, not
  // by type. This one is typed as a plan but only says "blood thinner", and the
  // expected evidence points at the collection rather than the document.
  it('does not cite a plan-typed document that never names the drug', () => {
    const issues = run(rule, {
      medications: activeApixaban,
      documents: [
        {type: 'H&P Note', date: '2026-02-19', text: 'H&P done.'},
        {
          type: 'Surgical Consent',
          date: '2026-02-23',
          text: 'Consent obtained and signed.',
        },
        {
          type: 'Perioperative Medication Plan',
          date: '2026-02-22',
          text: 'Discussed blood thinner use with patient; final plan pending specialist input.',
        },
      ],
    });
    expect(issues[0]?.evidence.source).toBe('documents');
  });

  it('is satisfied by a plan that describes hold and resume timing', () => {
    expect(
      run(rule, {
        medications: activeApixaban,
        documents: [
          {type: 'H&P Note', date: '2026-02-19', text: 'H&P done.'},
          {
            type: 'Surgical Consent',
            date: '2026-02-23',
            text: 'Consent obtained and signed.',
          },
          {
            type: 'Perioperative Medication Plan',
            date: '2026-02-22',
            text: 'Hold apixaban 48 hours before the procedure and resume 24 hours after.',
          },
        ],
      })
    ).toEqual([]);
  });
});

describe('AcuteSafetyRule', () => {
  const rule = new AcuteSafetyRule();

  it('is satisfied by normal vitals', () => {
    expect(run(rule)).toEqual([]);
  });

  it.each([
    [180, 90, 'systolic at the inclusive threshold'],
    [200, 90, 'systolic above'],
    [140, 110, 'diastolic at the inclusive threshold'],
    [140, 120, 'diastolic above'],
  ])('excludes on %d/%d (%s)', (systolic, diastolic) => {
    const issues = run(rule, {
      vitals: [
        {
          type: 'blood_pressure',
          systolic,
          diastolic,
          date: '2026-02-24T10:12:00Z',
        },
        {type: 'temperature', value_f: 98.6, date: '2026-02-24T10:15:00Z'},
      ],
    });
    expect(issues.map(i => i.category)).toEqual<IssueCategory[]>([
      'ACUTE_SAFETY_EXCLUSION',
    ]);
  });

  it('does not exclude just below the thresholds', () => {
    expect(
      run(rule, {
        vitals: [
          {
            type: 'blood_pressure',
            systolic: 179,
            diastolic: 109,
            date: '2026-02-24T10:12:00Z',
          },
          {type: 'temperature', value_f: 98.6, date: '2026-02-24T10:15:00Z'},
        ],
      })
    ).toEqual([]);
  });

  // The policy's temperature bound is exclusive (`> 100.4`) while its blood
  // pressure bounds are inclusive (`>=`). Reproduced exactly.
  it('treats the temperature threshold as exclusive', () => {
    const at = run(rule, {
      vitals: [
        {
          type: 'blood_pressure',
          systolic: 120,
          diastolic: 78,
          date: '2026-02-24T10:12:00Z',
        },
        {type: 'temperature', value_f: 100.4, date: '2026-02-24T10:15:00Z'},
      ],
    });
    expect(at).toEqual([]);

    const above = run(rule, {
      vitals: [
        {
          type: 'blood_pressure',
          systolic: 120,
          diastolic: 78,
          date: '2026-02-24T10:12:00Z',
        },
        {type: 'temperature', value_f: 100.5, date: '2026-02-24T10:15:00Z'},
      ],
    });
    expect(above.map(i => i.description)).toEqual([
      'Temperature exceeds exclusion threshold',
    ]);
  });

  it('uses the most recent reading, not the worst', () => {
    // An earlier crisis that has since resolved does not exclude...
    expect(
      run(rule, {
        vitals: [
          {
            type: 'blood_pressure',
            systolic: 190,
            diastolic: 115,
            date: '2026-02-17T09:05:00Z',
          },
          {
            type: 'blood_pressure',
            systolic: 122,
            diastolic: 76,
            date: '2026-02-24T10:12:00Z',
          },
          {type: 'temperature', value_f: 98.6, date: '2026-02-24T10:15:00Z'},
        ],
      })
    ).toEqual([]);

    // ...and an earlier normal reading does not rescue a current crisis.
    const current = run(rule, {
      vitals: [
        {
          type: 'blood_pressure',
          systolic: 122,
          diastolic: 76,
          date: '2026-02-17T09:05:00Z',
        },
        {
          type: 'blood_pressure',
          systolic: 190,
          diastolic: 115,
          date: '2026-02-24T10:12:00Z',
        },
        {type: 'temperature', value_f: 98.6, date: '2026-02-24T10:15:00Z'},
      ],
    });
    expect(current[0]?.evidence.source).toBe('vitals[1]');
  });

  it('reports both exclusions when both are present', () => {
    const issues = run(rule, {
      vitals: [
        {
          type: 'blood_pressure',
          systolic: 190,
          diastolic: 115,
          date: '2026-02-24T10:12:00Z',
        },
        {type: 'temperature', value_f: 101.0, date: '2026-02-24T10:15:00Z'},
      ],
    });
    expect(issues).toHaveLength(2);
  });

  it('stays silent when vitals are absent', () => {
    // DataCompletenessRule owns that gap; this rule must not invent an
    // exclusion it cannot evidence.
    expect(run(rule, {vitals: []})).toEqual([]);
  });
});
