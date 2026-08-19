import 'dotenv/config';
import {createReadStream} from 'node:fs';
import {mkdir, open} from 'node:fs/promises';
import {dirname, resolve} from 'node:path';
import {createInterface} from 'node:readline';
import {initializeDependencies} from './dependencies.js';
import {PatientSubmissionSchema} from './models/submission.js';
import type {TriageOutput} from './models/decision.js';

/**
 * Batch entrypoint — the TypeScript replacement for `run_baseline.py`.
 *
 * It emits `data/baseline_outputs.jsonl` in exactly the row shape the provided
 * scorer expects, which is what lets `run_evals.py`, `view_report.py` and every
 * other `make` target keep working untouched against this implementation. The
 * scorer only reads `record_index` and `output` from each row; the rest is
 * written faithfully so the file stays readable on its own.
 */

interface Args {
  input: string;
  output: string;
  model: string;
  maxRecords: number;
}

const DEFAULTS: Args = {
  input: 'data/patients_sample_50.jsonl',
  output: 'data/baseline_outputs.jsonl',
  model: 'deterministic',
  maxRecords: 0,
};

function parseArgs(argv: readonly string[]): Args {
  const args = {...DEFAULTS};
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    const value = argv[i + 1];
    switch (flag) {
      case '--input':
        if (value !== undefined) args.input = value;
        i += 1;
        break;
      case '--output':
        if (value !== undefined) args.output = value;
        i += 1;
        break;
      case '--model':
        if (value !== undefined) args.model = value;
        i += 1;
        break;
      case '--max-records':
        if (value !== undefined) args.maxRecords = Number(value);
        i += 1;
        break;
      default:
        break;
    }
  }
  return args;
}

interface OutputRow {
  record_index: number;
  case_id: string;
  submission: unknown;
  model: string;
  output: TriageOutput | null;
  error: string | null;
}

async function* readJsonl(path: string): AsyncGenerator<unknown> {
  const stream = createReadStream(path, {encoding: 'utf8'});
  const lines = createInterface({input: stream, crlfDelay: Infinity});
  for await (const line of lines) {
    const trimmed = line.trim();
    if (trimmed === '') continue;
    yield JSON.parse(trimmed);
  }
}

/**
 * The dataset rows wrap the package as `{case_id, submission, expected_output}`,
 * but `run_baseline.py` also accepts a bare submission object. Accept both, and
 * fall back to a positional case id the same way it does.
 */
function unwrapCase(
  row: unknown,
  index: number
): {caseId: string; submission: unknown} {
  if (row !== null && typeof row === 'object') {
    const record = row as Record<string, unknown>;
    if ('submission' in record && 'case_id' in record) {
      return {
        caseId: String(record['case_id']),
        submission: record['submission'],
      };
    }
  }
  return {
    caseId: `case_${String(index).padStart(5, '0')}`,
    submission: row,
  };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const {logger, triage, config} = initializeDependencies();

  const inputPath = resolve(args.input);
  const outputPath = resolve(args.output);
  await mkdir(dirname(outputPath), {recursive: true});

  const handle = await open(outputPath, 'w');
  let index = 0;
  let written = 0;

  try {
    for await (const row of readJsonl(inputPath)) {
      if (args.maxRecords > 0 && written >= args.maxRecords) break;

      const {caseId, submission} = unwrapCase(row, index);
      const outputRow: OutputRow = {
        record_index: index,
        case_id: caseId,
        submission,
        model: config.llm.mode === 'off' ? 'deterministic' : args.model,
        output: null,
        error: null,
      };

      try {
        const parsed = PatientSubmissionSchema.parse(submission);
        outputRow.output = await triage.triageAsync(parsed);
      } catch (err) {
        // A single malformed record must not abort the batch; the scorer treats
        // a null output as a failed row, which is the honest result.
        outputRow.error = err instanceof Error ? err.message : String(err);
        logger.error({caseId, err}, 'triage failed for case');
      }

      await handle.write(`${JSON.stringify(outputRow)}\n`);
      index += 1;
      written += 1;
    }
  } finally {
    await handle.close();
  }

  logger.info({written, outputPath}, 'wrote triage outputs');
}

main().catch(err => {
  process.stderr.write(`fatal error: ${err?.stack ?? String(err)}\n`);
  // Batch mode is invoked from `make`, which keys off the exit status.
  // eslint-disable-next-line n/no-process-exit
  process.exit(1);
});
