import type {TriageIssue} from '../../models/decision.js';
import {collectionPath, elementPath} from '../evidence.js';
import {
  describesPerioperativePlan,
  isAnticoagulant,
  mentionsAnticoagulation,
} from '../normalize/documents.js';
import {
  describeDocument,
  indexed,
  type PolicyContext,
  type Rule,
} from './rule.js';

/**
 * Rule 3 — Anticoagulation management.
 *
 * For a patient *currently* taking an anticoagulant, a perioperative plan must
 * be documented, and it must describe how the medication is managed before and
 * after the procedure. Missing, incomplete or ambiguous all fail.
 *
 * Two details drive the implementation, both taken from the sample data:
 *
 *  - "Currently taking" means `active === true`. `active: null` is a data gap
 *    handled by DataCompletenessRule, and this rule deliberately does not also
 *    demand a plan in that case: the three `warfarin`/`active: null` cases
 *    expect only MISSING_REQUIRED_DATA, no anticoagulation issue.
 *
 *  - The plan document is located by *text*, not by type. case_00042 carries a
 *    document typed `Perioperative Medication Plan` whose text says only
 *    "Discussed blood thinner use with patient; final plan pending specialist
 *    input" — never naming the drug or using an anticoagulation term — and the
 *    expected evidence points at the whole `documents` collection rather than
 *    that document. Matching on type would have cited it as the plan.
 */
export class AnticoagulationRule implements Rule {
  readonly name = 'anticoagulation';

  evaluate(context: PolicyContext): TriageIssue[] {
    const active = indexed(context.medications).filter(
      ({value}) => isAnticoagulant(value.name) && value.active === true
    );
    if (active.length === 0) return [];

    const drugNames = active
      .map(({value}) => value.name)
      .filter((name): name is string => typeof name === 'string');

    const planCandidates = indexed(context.documents).filter(({value}) =>
      mentionsAnticoagulation(value.text, drugNames)
    );

    const complete = planCandidates.find(
      ({index, value}) =>
        context.judgments.planDescribesManagement.get(index) ??
        describesPerioperativePlan(value.text)
    );
    if (complete !== undefined) return [];

    const medicationRef = active
      .map(({index, value}) => `${value.name} (medications[${index}])`)
      .join(', ');

    // Cite the document that discusses anticoagulation but falls short, if one
    // exists; otherwise cite the collection, since no document does.
    const partial = planCandidates[0];
    if (partial !== undefined) {
      return [
        {
          category: 'ANTICOAGULATION_MANAGEMENT',
          description: 'Missing perioperative anticoagulation plan',
          evidence: {
            source: elementPath('documents', partial.index),
            details: `Active anticoagulant ${medicationRef}; document ${describeDocument(partial.value)} mentions anticoagulation but does not describe perioperative management: ${JSON.stringify(partial.value.text ?? '')}`,
          },
        },
      ];
    }

    return [
      {
        category: 'ANTICOAGULATION_MANAGEMENT',
        description: 'Missing perioperative anticoagulation plan',
        evidence: {
          source: collectionPath('documents'),
          details: `Active anticoagulant ${medicationRef} but no document among ${context.documents.length} references anticoagulation management`,
        },
      },
    ];
  }
}
