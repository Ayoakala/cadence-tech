import {describe, expect, it} from 'vitest';
import {buildExplanation, type TriageIssue} from '../../models/decision.js';
import {orderIssues, resolveDecision} from './decisionResolver.js';

function issue(
  category: TriageIssue['category'],
  description = 'something'
): TriageIssue {
  return {
    category,
    description,
    evidence: {source: 'procedure.procedure_date', details: 'detail'},
  };
}

describe('resolveDecision', () => {
  it('is READY when nothing is outstanding', () => {
    expect(resolveDecision([])).toBe('READY');
  });

  it('is NEEDS_FOLLOW_UP for any non-safety issue', () => {
    expect(resolveDecision([issue('REQUIRED_DOCUMENTATION')])).toBe(
      'NEEDS_FOLLOW_UP'
    );
    expect(resolveDecision([issue('MISSING_REQUIRED_DATA')])).toBe(
      'NEEDS_FOLLOW_UP'
    );
    expect(resolveDecision([issue('REQUIRED_TESTING')])).toBe(
      'NEEDS_FOLLOW_UP'
    );
    expect(resolveDecision([issue('ANTICOAGULATION_MANAGEMENT')])).toBe(
      'NEEDS_FOLLOW_UP'
    );
  });

  it('is NOT_CLEARED when a safety exclusion is present', () => {
    expect(resolveDecision([issue('ACUTE_SAFETY_EXCLUSION')])).toBe(
      'NOT_CLEARED'
    );
  });

  // A safety exclusion outranks paperwork, and does so regardless of ordering.
  it('lets a safety exclusion outrank every other issue', () => {
    expect(
      resolveDecision([
        issue('REQUIRED_DOCUMENTATION'),
        issue('ACUTE_SAFETY_EXCLUSION'),
        issue('REQUIRED_TESTING'),
      ])
    ).toBe('NOT_CLEARED');
    expect(
      resolveDecision([
        issue('ACUTE_SAFETY_EXCLUSION'),
        issue('REQUIRED_DOCUMENTATION'),
      ])
    ).toBe('NOT_CLEARED');
  });
});

describe('orderIssues', () => {
  it('sorts blocking issues first', () => {
    const ordered = orderIssues([
      issue('ANTICOAGULATION_MANAGEMENT'),
      issue('ACUTE_SAFETY_EXCLUSION'),
      issue('REQUIRED_DOCUMENTATION'),
      issue('MISSING_REQUIRED_DATA'),
    ]);
    expect(ordered.map(i => i.category)).toEqual([
      'ACUTE_SAFETY_EXCLUSION',
      'MISSING_REQUIRED_DATA',
      'REQUIRED_DOCUMENTATION',
      'ANTICOAGULATION_MANAGEMENT',
    ]);
  });

  it('is a total order, so repeated sorts are stable', () => {
    const input = [
      issue('REQUIRED_TESTING', 'CMP missing'),
      issue('REQUIRED_TESTING', 'CBC missing'),
    ];
    const once = orderIssues(input).map(i => i.description);
    expect(once).toEqual(['CBC missing', 'CMP missing']);
    expect(orderIssues(orderIssues(input)).map(i => i.description)).toEqual(
      once
    );
  });

  it('does not mutate its input', () => {
    const input = [
      issue('ANTICOAGULATION_MANAGEMENT'),
      issue('ACUTE_SAFETY_EXCLUSION'),
    ];
    orderIssues(input);
    expect(input[0]?.category).toBe('ANTICOAGULATION_MANAGEMENT');
  });
});

describe('buildExplanation', () => {
  it('joins issues as "CATEGORY: description" with a pipe', () => {
    expect(
      buildExplanation([
        issue('MISSING_REQUIRED_DATA', 'Missing procedure date'),
        issue(
          'ANTICOAGULATION_MANAGEMENT',
          'Missing perioperative anticoagulation plan'
        ),
      ])
    ).toBe(
      'MISSING_REQUIRED_DATA: Missing procedure date | ' +
        'ANTICOAGULATION_MANAGEMENT: Missing perioperative anticoagulation plan'
    );
  });

  it('describes a clean submission when there are no issues', () => {
    expect(buildExplanation([])).toContain('satisfied');
  });
});
