import type {TriageIssue} from '../../models/decision.js';
import {elementPath} from '../evidence.js';
import {indexed, mostRecent, type PolicyContext, type Rule} from './rule.js';

export const SYSTOLIC_THRESHOLD = 180;
export const DIASTOLIC_THRESHOLD = 110;
export const TEMPERATURE_THRESHOLD_F = 100.4;

/**
 * Rule 4 — Acute safety exclusions. Any of these means NOT_CLEARED:
 *
 *   systolic >= 180 mmHg, diastolic >= 110 mmHg, temperature > 100.4 F
 *
 * Note the asymmetry in the policy's own wording, reproduced here exactly: the
 * blood pressure bounds are inclusive (`>=`) and the temperature bound is
 * exclusive (`>`). A temperature of exactly 100.4 does not exclude.
 *
 * Only the most recent reading of each type is considered, so an earlier
 * elevated reading that has since resolved does not exclude the patient — and a
 * normal earlier reading does not rescue a currently elevated one.
 */
export class AcuteSafetyRule implements Rule {
  readonly name = 'acute_safety';

  evaluate(context: PolicyContext): TriageIssue[] {
    return [...this.bloodPressure(context), ...this.temperature(context)];
  }

  private bloodPressure(context: PolicyContext): TriageIssue[] {
    const readings = indexed(context.vitals).filter(
      ({value}) => value.type === 'blood_pressure'
    );
    const latest = mostRecent(readings, vital => vital.date);
    if (latest === null) return [];

    const {systolic, diastolic} = latest.entry.value;
    const systolicExcluded =
      typeof systolic === 'number' && systolic >= SYSTOLIC_THRESHOLD;
    const diastolicExcluded =
      typeof diastolic === 'number' && diastolic >= DIASTOLIC_THRESHOLD;
    if (!systolicExcluded && !diastolicExcluded) return [];

    return [
      {
        category: 'ACUTE_SAFETY_EXCLUSION',
        description: 'Blood pressure meets exclusion threshold',
        evidence: {
          source: elementPath('vitals', latest.entry.index),
          details: `Latest blood_pressure recorded ${latest.entry.value.date} is systolic=${systolic}, diastolic=${diastolic}; exclusion threshold is systolic>=${SYSTOLIC_THRESHOLD} or diastolic>=${DIASTOLIC_THRESHOLD}`,
        },
      },
    ];
  }

  private temperature(context: PolicyContext): TriageIssue[] {
    const readings = indexed(context.vitals).filter(
      ({value}) => value.type === 'temperature'
    );
    const latest = mostRecent(readings, vital => vital.date);
    if (latest === null) return [];

    const value = latest.entry.value.value_f;
    if (typeof value !== 'number' || value <= TEMPERATURE_THRESHOLD_F)
      return [];

    return [
      {
        category: 'ACUTE_SAFETY_EXCLUSION',
        description: 'Temperature exceeds exclusion threshold',
        evidence: {
          source: elementPath('vitals', latest.entry.index),
          details: `Latest temperature recorded ${latest.entry.value.date} is value_f=${value}; exclusion threshold is > ${TEMPERATURE_THRESHOLD_F}`,
        },
      },
    ];
  }
}
