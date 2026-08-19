import {describe, expect, it} from 'vitest';
import {TESTING_REQUIREMENTS, isLabCode, normalizeLabCode} from './labs.js';

describe('normalizeLabCode', () => {
  // The sample data carries the same panel under two codes; treating them as
  // distinct makes a present CBC look missing (case_00037 has only LAB-CBC and
  // is not expected to raise a testing issue).
  it.each([
    ['CBC', 'CBC'],
    ['LAB-CBC', 'CBC'],
    ['CMP', 'CMP'],
    ['LAB-CMP', 'CMP'],
    ['HBA1C', 'HBA1C'],
    ['lab-cbc', 'CBC'],
    ['  CBC  ', 'CBC'],
  ])('normalises %j to %j', (input, expected) => {
    expect(normalizeLabCode(input)).toBe(expected);
  });

  it.each([null, undefined, '', '   '])('returns null for %j', code => {
    expect(normalizeLabCode(code)).toBeNull();
  });

  it('does not strip a prefix that is part of the code', () => {
    expect(normalizeLabCode('LABETALOL')).toBe('LABETALOL');
  });
});

describe('isLabCode', () => {
  it('matches across code variants', () => {
    expect(isLabCode({code: 'LAB-CBC'}, 'CBC')).toBe(true);
    expect(isLabCode({code: 'CBC'}, 'CBC')).toBe(true);
    expect(isLabCode({code: 'HBA1C'}, 'CBC')).toBe(false);
  });

  it('ignores the display string entirely', () => {
    // `display` varies freely and adds nothing the code does not carry.
    expect(
      isLabCode({code: 'HBA1C', display: 'CBC (Complete Blood Count)'}, 'CBC')
    ).toBe(false);
  });
});

describe('TESTING_REQUIREMENTS', () => {
  it('requires a 30-day CBC for LOW and MODERATE risk', () => {
    expect(TESTING_REQUIREMENTS.LOW).toEqual([{code: 'CBC', windowDays: 30}]);
    expect(TESTING_REQUIREMENTS.MODERATE).toEqual([
      {code: 'CBC', windowDays: 30},
    ]);
  });

  it('requires a 14-day CBC and CMP for HIGH risk', () => {
    expect(TESTING_REQUIREMENTS.HIGH).toEqual([
      {code: 'CBC', windowDays: 14},
      {code: 'CMP', windowDays: 14},
    ]);
  });
});
