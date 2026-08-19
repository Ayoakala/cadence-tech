import {readFileSync} from 'node:fs';
import {describe, expect, it} from 'vitest';
import {PatientSubmissionSchema} from '../../models/submission.js';
import {
  TriageOutputSchema,
  type Decision,
  type IssueCategory,
} from '../../models/decision.js';
import {isResolvableSource} from '../evidence.js';
import {TriageService} from './triageService.js';

/**
 * Golden test over the full provided dataset.
 *
 * This is the regression net that matters: it asserts the two things the scorer
 * weighs most — the decision, and the *set* of issue categories — for all 50
 * cases, in-process and without the Python harness or any network call. A rule
 * change that trades one case for another shows up here immediately, named.
 *
 * It deliberately does not assert on `description` or `evidence.details`. The
 * scorer never compares those to the oracle, so pinning them would make the
 * suite brittle against wording changes that cannot affect the score.
 */

interface DatasetCase {
  case_id: string;
  submission: unknown;
  expected_output: {
    decision: Decision;
    issues: {category: IssueCategory}[];
  };
}

const DATASET_PATH = new URL(
  '../../../data/patients_sample_50.jsonl',
  import.meta.url
);

function loadDataset(): DatasetCase[] {
  return readFileSync(DATASET_PATH, 'utf8')
    .split('\n')
    .filter(line => line.trim() !== '')
    .map(line => JSON.parse(line) as DatasetCase);
}

const dataset = loadDataset();
const service = new TriageService();

function categorySet(issues: {category: IssueCategory}[]): IssueCategory[] {
  return [...new Set(issues.map(i => i.category))].sort();
}

describe('TriageService against the provided dataset', () => {
  it('loads all 50 cases', () => {
    expect(dataset).toHaveLength(50);
  });

  it.each(dataset.map(c => [c.case_id, c] as const))(
    '%s matches the expected decision and categories',
    (_caseId, testCase) => {
      const submission = PatientSubmissionSchema.parse(testCase.submission);
      const actual = service.triage(submission);

      expect(actual.decision).toBe(testCase.expected_output.decision);
      expect(categorySet(actual.issues)).toEqual(
        categorySet(testCase.expected_output.issues)
      );
    }
  );

  it('emits output that satisfies the shared contract for every case', () => {
    for (const testCase of dataset) {
      const submission = PatientSubmissionSchema.parse(testCase.submission);
      const parsed = TriageOutputSchema.safeParse(service.triage(submission));
      expect(
        parsed.success,
        `${testCase.case_id} produced invalid output`
      ).toBe(true);
    }
  });

  // The harness resolves `evidence.source` with a restricted grammar and drops
  // the grounding score for anything it cannot parse. Checking it here means a
  // malformed path is caught by `bun run test` rather than by an eval run.
  it('emits only resolvable evidence sources', () => {
    for (const testCase of dataset) {
      const submission = PatientSubmissionSchema.parse(testCase.submission);
      for (const issue of service.triage(submission).issues) {
        expect(
          isResolvableSource(issue.evidence.source),
          `${testCase.case_id}: unresolvable source ${issue.evidence.source}`
        ).toBe(true);
      }
    }
  });

  it('never emits an empty details string', () => {
    for (const testCase of dataset) {
      const submission = PatientSubmissionSchema.parse(testCase.submission);
      for (const issue of service.triage(submission).issues) {
        expect(issue.evidence.details.trim().length).toBeGreaterThan(0);
        expect(issue.description.trim().length).toBeGreaterThan(0);
      }
    }
  });

  it('is bit-for-bit reproducible across repeated runs', () => {
    // `make determinism` asserts this through the Python harness; asserting it
    // here as well keeps the property from regressing silently between runs.
    for (const testCase of dataset.slice(0, 10)) {
      const submission = PatientSubmissionSchema.parse(testCase.submission);
      const first = JSON.stringify(service.triage(submission));
      const second = JSON.stringify(new TriageService().triage(submission));
      expect(second).toBe(first);
    }
  });
});

describe('TriageService on degenerate input', () => {
  it('does not throw on an empty submission', () => {
    const submission = PatientSubmissionSchema.parse({});
    const output = service.triage(submission);
    // Everything is unknown, so everything is a data gap — never READY.
    expect(output.decision).toBe('NEEDS_FOLLOW_UP');
    expect(TriageOutputSchema.safeParse(output).success).toBe(true);
  });

  it('preserves unknown fields without tripping over them', () => {
    const submission = PatientSubmissionSchema.parse({
      procedure: {
        procedure_risk: 'LOW',
        procedure_date: '2026-03-01',
        novel: 1,
      },
      unexpected_section: [{a: 1}],
    });
    expect(() => service.triage(submission)).not.toThrow();
  });
});
