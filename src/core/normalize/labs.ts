import type {LabResult} from '../../models/submission.js';

/**
 * Lab code normalisation.
 *
 * The same panel arrives under more than one code: the sample data contains
 * both `CBC` and `LAB-CBC`, and both `CMP` and `LAB-CMP`. Treating them as
 * distinct codes makes a present CBC look missing — case_00037 has only
 * `LAB-CBC` and is not expected to raise a testing issue.
 *
 * `display` is intentionally *not* consulted. It varies freely
 * ("Complete Blood Count", "CBC (Complete Blood Count)") and adds no
 * information the code does not already carry.
 */

export type RequiredLabCode = 'CBC' | 'CMP';

const SOURCE_PREFIX = /^(?:lab|loinc|test)[-_ ]/i;

export function normalizeLabCode(
  code: string | null | undefined
): string | null {
  if (typeof code !== 'string') return null;
  const trimmed = code.trim();
  if (trimmed === '') return null;
  return trimmed.replace(SOURCE_PREFIX, '').toUpperCase();
}

export function isLabCode(lab: LabResult, target: RequiredLabCode): boolean {
  return normalizeLabCode(lab.code) === target;
}

/** Required panels and their maximum age in days, keyed by procedure risk. */
export const TESTING_REQUIREMENTS = {
  LOW: [{code: 'CBC' as const, windowDays: 30}],
  MODERATE: [{code: 'CBC' as const, windowDays: 30}],
  HIGH: [
    {code: 'CBC' as const, windowDays: 14},
    {code: 'CMP' as const, windowDays: 14},
  ],
} as const;
