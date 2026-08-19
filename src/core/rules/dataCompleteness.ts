import type {TriageIssue} from '../../models/decision.js';
import {collectionPath, fieldPath} from '../evidence.js';
import {isAnticoagulant} from '../normalize/documents.js';
import {parseCalendarDay} from '../../lib/dates.js';
import {indexed, type PolicyContext, type Rule} from './rule.js';

/**
 * Structural data gaps — the policy's catch-all: "If a required field needed to
 * evaluate a rule is missing/unknown, the patient should be classified as
 * NEEDS_FOLLOW_UP."
 *
 * This rule owns every MISSING_REQUIRED_DATA issue, so the downstream rules
 * never have to decide whether to also complain about a null they depend on.
 *
 * The four gaps below are exactly those the sample data exercises:
 *   - `procedure.procedure_date` is null (blocks every window check)
 *   - `procedure.procedure_risk` is null (blocks the testing panel selection)
 *   - an anticoagulant with `active: null` (cannot tell if the patient takes it)
 *   - no blood pressure / no temperature reading (blocks the safety exclusions)
 *
 * Note the third: `active: null` is not `active: false`. Treating unknown as
 * "not taking" would silently skip Rule 3 rather than surface the gap.
 */
export class DataCompletenessRule implements Rule {
  readonly name = 'data_completeness';

  evaluate(context: PolicyContext): TriageIssue[] {
    return [
      ...this.missingProcedureFields(context),
      ...this.unknownAnticoagulantStatus(context),
      ...this.missingVitals(context),
    ];
  }

  private missingProcedureFields(context: PolicyContext): TriageIssue[] {
    const issues: TriageIssue[] = [];

    if (context.procedureDate === null) {
      const raw = context.submission.procedure?.procedure_date;
      issues.push({
        category: 'MISSING_REQUIRED_DATA',
        description: 'Missing procedure date',
        evidence: {
          source: fieldPath('procedure', 'procedure_date'),
          details:
            raw === null || raw === undefined
              ? 'procedure.procedure_date is null; every documentation and testing window is measured relative to it'
              : `procedure.procedure_date is "${raw}", which is not a parseable date`,
        },
      });
    }

    if (context.procedureRisk === null) {
      const raw = context.submission.procedure?.procedure_risk;
      issues.push({
        category: 'MISSING_REQUIRED_DATA',
        description: 'Missing procedure risk',
        evidence: {
          source: fieldPath('procedure', 'procedure_risk'),
          details:
            raw === null || raw === undefined
              ? 'procedure.procedure_risk is null; required testing cannot be selected without a risk level'
              : `procedure.procedure_risk is "${raw}", which is not one of LOW, MODERATE, HIGH`,
        },
      });
    }

    return issues;
  }

  private unknownAnticoagulantStatus(context: PolicyContext): TriageIssue[] {
    return indexed(context.medications)
      .filter(
        ({value}) =>
          isAnticoagulant(value.name) &&
          (value.active === null || value.active === undefined)
      )
      .map(({index, value}) => ({
        category: 'MISSING_REQUIRED_DATA' as const,
        description: 'Unknown anticoagulant active status',
        evidence: {
          source: `medications[${index}]`,
          details: `Medication ${value.name} has active=null; cannot determine whether the patient is currently taking it, so the anticoagulation plan requirement cannot be evaluated`,
        },
      }));
  }

  /**
   * Rule 4 needs a most-recent blood pressure and a most-recent temperature.
   * An absent reading is a data gap, not a silent pass — a patient with no
   * recorded temperature has not been shown to be below the exclusion
   * threshold.
   */
  private missingVitals(context: PolicyContext): TriageIssue[] {
    const issues: TriageIssue[] = [];
    const present = (type: string) =>
      context.vitals.some(
        v => v.type === type && parseCalendarDay(v.date) !== null
      );

    if (!present('blood_pressure')) {
      issues.push({
        category: 'MISSING_REQUIRED_DATA',
        description: 'Missing latest blood pressure',
        evidence: {
          source: collectionPath('vitals'),
          details: `No blood_pressure vital with a valid date found among ${context.vitals.length} vitals; systolic and diastolic exclusion thresholds cannot be checked`,
        },
      });
    }

    if (!present('temperature')) {
      issues.push({
        category: 'MISSING_REQUIRED_DATA',
        description: 'Missing latest temperature',
        evidence: {
          source: collectionPath('vitals'),
          details: `No temperature vital with a valid date found among ${context.vitals.length} vitals; the 100.4F exclusion threshold cannot be checked`,
        },
      });
    }

    return issues;
  }
}
