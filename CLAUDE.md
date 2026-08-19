# CLAUDE.md

Pre-operative scheduling triage. Evaluates a patient submission package against
the Cadence Surgical Center scheduling policy and returns exactly one clearance
decision plus evidence-backed issues.

The solution is TypeScript in `src/`. The Python files at the repo root are the
provided harness (dataset, scorer, report TUI) and are unchanged except for
`core.py: triage_submission`, which bridges into the TypeScript over a subprocess.

## Conventions

- **ESM TypeScript**, Node 22 runtime, **Bun** as the package manager.
- Relative imports use the `.js` extension (NodeNext module resolution).
- `zod` at every trust boundary, `pino` for logging, vitest for tests, `gts` for
  lint/format. `openai` only inside `src/llm/`.
- `src/init.ts` (batch) and `src/bridge.ts` (single, stdin/stdout) are the
  entrypoints; `src/dependencies.ts` is the composition root.
- Rules are pure synchronous functions over a `PolicyContext`. Nothing in
  `src/core/` performs I/O or reads the environment.
- **Logs go to stderr, always.** stdout is reserved for the JSON payload that
  `core.py` reads back over the bridge.

## Common commands

- `bun run typecheck` — `tsc --noEmit`
- `bun run test` — vitest (includes a golden test over all 50 dataset cases)
- `bun run triage -- --input data/patients_sample_50.jsonl --output data/baseline_outputs.jsonl`
- `make baseline` — same thing, driven through the provided `run_baseline.py`
- `uv run scripts/score_local.py --failures` — fast local score, no API calls
- `make evals` / `make score` / `make report` — the provided scorer and TUI
- `make determinism` — 10 identical runs of one case
- `make test` — pytest over the Python bridge

## Notes

- **Never report a rule that a missing prerequisite blocked.** The scorer compares
  the *set* of issue categories for exact equality, and in every sample case with
  a null `procedure_date` or `procedure_risk` the expected set is exactly
  `{MISSING_REQUIRED_DATA}`. `DataCompletenessRule` owns all such issues; other
  rules skip the checks they cannot compute. This is the single easiest metric to
  lose.
- Presence checks and freshness checks are separate. Presence does not need the
  procedure date; only the window comparison does.
- Document `type` has ~100 spellings for three concepts. Match with the patterns
  in `src/core/normalize/documents.ts`; never compare type strings exactly.
- `History & Phsyical` (transposed letters) must **not** classify as an H&P — see
  the comment in `documents.ts`. Matching it flips case_00002 to a false pass.
- Lab codes need normalising: `LAB-CBC` is a `CBC`.
- Consent signing is read from text, and "unsigned" contains "signed" — check the
  negatives first. "signature on file" is signed without using the word.
- The anticoagulation plan document is located by **text**, not by type.
- `TRIAGE_LLM_MODE` defaults to `off`, so runs are bit-for-bit reproducible and
  need no API key. `shadow` logs where a model would disagree without acting on
  it; see `docs/APPROACH.md` for what that experiment showed.
- Add a rule as `src/core/rules/<name>.ts` implementing `Rule`, then register it
  in `DEFAULT_RULES` in `src/core/triage/triageService.ts`.
