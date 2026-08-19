import 'dotenv/config';
import {initializeDependencies} from './dependencies.js';
import {PatientSubmissionSchema} from './models/submission.js';

/**
 * Single-submission mode: read one submission package as JSON on stdin, write
 * the triage output as JSON on stdout.
 *
 * This is the seam that lets the provided Python harness drive the TypeScript
 * implementation unchanged — `core.py: triage_submission` shells out to this
 * entrypoint. Everything diagnostic goes to stderr (see `lib/logger.ts`) so
 * stdout carries nothing but the payload.
 */
async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function main(): Promise<void> {
  const {triage} = initializeDependencies();

  const raw = await readStdin();
  if (raw.trim() === '') {
    throw new Error('no submission received on stdin');
  }

  const submission = PatientSubmissionSchema.parse(JSON.parse(raw));
  const output = await triage.triageAsync(submission);

  process.stdout.write(JSON.stringify(output));
}

main().catch(err => {
  process.stderr.write(`triage failed: ${err?.stack ?? String(err)}\n`);
  // A non-zero exit is the contract with `core.py`, which raises a RuntimeError
  // on any exit code it did not expect. Throwing here would surface as an
  // unhandled rejection and a less legible failure upstream.
  // eslint-disable-next-line n/no-process-exit
  process.exit(1);
});
