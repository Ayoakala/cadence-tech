# cadence-preop-triage

Pre-operative scheduling triage for Cadence Surgical Center. Takes a patient
submission package as JSON and returns exactly one clearance decision —
`READY`, `NEEDS_FOLLOW_UP`, or `NOT_CLEARED` — with an evidence-backed issue for
every unmet requirement.

The policy is implemented as **deterministic rules in TypeScript**. A language
model is available for the three judgments in the policy that are genuinely about
prose, but it is off by default; see [`docs/APPROACH.md`](docs/APPROACH.md) for
why, and for the shadow-mode experiment behind that decision.

The exercise brief is preserved verbatim in [`EXERCISE.md`](EXERCISE.md).

## Results on the provided dataset

Scored by the provided `run_evals.py`, unmodified:

| Metric | Weight | Score |
| ------ | ------ | ----- |
| `json_schema_valid` | 1.0 | 100% |
| `decision_match_oracle` | 1.0 | 100% |
| `issue_categories_match_oracle` | 1.0 | 100% |
| `issues_value_grounding` | 0.5 | 100% |
| **Aggregate** | | **100%** |

`make determinism` reports 100% decision stability, 100% JSON format stability,
and 100% exact-output match across 10 runs — the default configuration makes no
model calls, so repeated runs are byte-identical rather than merely consistent.

A full pass over all 50 cases takes about 5 seconds and costs nothing.

> A caveat worth stating plainly: the rules were derived by reading these same 50
> expected outputs, so 100% here measures fit to the sample, not generalisation.
> `docs/APPROACH.md` lists the specific places the implementation is most likely
> to be over-fitted.

## What changed from the starter

The solution is TypeScript in `src/`. The provided Python harness is otherwise
intact — `run_baseline.py`, `run_evals.py` and `view_report.py` are byte-identical
to the starter, so the scores above come from the exercise's own scorer.

| File | Status |
| ---- | ------ |
| `core.py` | **Only changed file.** `triage_submission` now delegates to the TypeScript over a subprocess instead of making one LLM call. The pydantic models and prompt constants are untouched. |
| `tests/test_triage_submission.py` | Replaced. The originals asserted on the baseline's OpenAI call wiring, which no longer exists; they now test the bridge. |
| `run_baseline.py`, `run_evals.py`, `view_report.py`, `Makefile` | Unchanged. |
| `src/`, `docs/`, `scripts/score_local.py` | Added. |

**Every `make` target works exactly as documented in the starter.** The only new
prerequisites are Node 22 and Bun; `uv` is still used for the Python side.

## Requirements

- **Node 22** (`.nvmrc` → `nvm use`)
- **Bun** for package management
- **uv** for the provided Python harness
- An OpenAI API key only if you enable `TRIAGE_LLM_MODE`; the default needs none

## Quick start

```bash
# 1. Install dependencies
nvm use && bun install

# 2. Run the whole dataset and score it (no API key, no network)
bun run triage -- --input data/patients_sample_50.jsonl --output data/baseline_outputs.jsonl
uv run scripts/score_local.py

# or drive it through the provided Python harness instead
make baseline && make evals && make score
```

Triage a single submission from stdin:

```bash
echo '{"procedure":{"procedure_risk":"LOW","procedure_date":"2026-03-01"}}' \
  | bun run triage:one
```

## Scripts

| Script | Description |
| ------ | ----------- |
| `bun run triage` | Run the batch runner over a JSONL dataset |
| `bun run triage:one` | Triage one submission from stdin (used by the bridge) |
| `bun run test` | Run vitest (237 tests, incl. a golden test over all 50 cases) |
| `bun run typecheck` | Type-check without emitting |
| `bun run build` | Compile TypeScript to `dist/` |
| `bun run lint` / `lint:fix` | Lint with gts |

| Make target | Description |
| ----------- | ----------- |
| `make baseline` | Provided runner → `data/baseline_outputs.jsonl` (via the bridge) |
| `make evals` | Provided scorer → `data/eval_report.json` (uploads an OpenAI Evals run) |
| `make score` | Print the aggregate score |
| `make report` | Interactive report TUI |
| `make determinism` | 10 identical runs of one case |
| `make test` | pytest over the Python bridge |
| `uv run scripts/score_local.py [--failures]` | Same metrics as `make evals`, computed locally with no API calls |

## How the pieces fit

The provided Python harness is intact. Only `core.py: triage_submission` changed —
it now shells out to the TypeScript instead of making a single LLM call:

```
make baseline ──> run_baseline.py ──> core.py: triage_submission
                  (unchanged)         (bridge, ~60 lines)
                                            │  submission JSON on stdin
                                            ▼  TriageOutput JSON on stdout
                                      src/bridge.ts ──> TriageService
                                            │
                  data/baseline_outputs.jsonl
                                            │
make evals   ──> run_evals.py  ────────────┘
                  (unchanged)  ──> data/eval_report.json ──> make report
```

Keeping `run_evals.py` and `view_report.py` byte-identical is deliberate: the
scores above come from the exercise's own scorer, not from one I wrote.

## Configuration

Copy `.env.example` to `.env`. Everything has a default that runs offline.

| Variable | Default | Meaning |
| -------- | ------- | ------- |
| `TRIAGE_LLM_MODE` | `off` | `off` \| `assist` \| `shadow` — see `docs/APPROACH.md` |
| `TRIAGE_MODEL` | `gpt-5-mini` | Model for the document-text judgments |
| `TRIAGE_LLM_CACHE_DIR` | `.cache/llm` | Content-hash cache, so repeat runs stay deterministic |
| `OPENAI_API_KEY` | — | Required only when the mode is not `off` |
| `LOG_LEVEL` | `info` | pino level; all logs go to **stderr** |

## Layout

```
src/
├── init.ts                    # batch entrypoint (replaces run_baseline.py)
├── bridge.ts                  # single-submission stdin/stdout entrypoint
├── dependencies.ts            # composition root
├── config.ts                  # env parsing/validation (zod)
├── models/
│   ├── submission.ts          # zod schema for the patient package
│   └── decision.ts            # the output contract + explanation builder
├── core/
│   ├── evidence.ts            # evidence.source path grammar
│   ├── normalize/
│   │   ├── documents.ts       # document type / consent / anticoagulant matching
│   │   └── labs.ts            # lab code normalisation + testing requirements
│   ├── rules/
│   │   ├── rule.ts            # PolicyContext, Rule, most-recent selection
│   │   ├── dataCompleteness.ts    # owns every MISSING_REQUIRED_DATA issue
│   │   ├── requiredDocumentation.ts   # Rule 1
│   │   ├── preOpTesting.ts            # Rule 2
│   │   ├── anticoagulation.ts         # Rule 3
│   │   └── acuteSafety.ts             # Rule 4
│   └── triage/
│       ├── triageService.ts   # runs the rules, resolves the decision
│       ├── decisionResolver.ts # precedence + stable issue ordering
│       └── enrichment.ts      # decides what (if anything) to ask a model
├── llm/
│   ├── documentJudge.ts       # judgment types; the no-op judge
│   ├── openaiDocumentJudge.ts # the only file that calls OpenAI
│   └── cache.ts               # content-hash cache for judgments
└── lib/
    ├── dates.ts               # timezone-independent calendar-day arithmetic
    └── logger.ts              # pino, to stderr

scripts/score_local.py         # local scoring, reuses the provided metric code
docs/APPROACH.md               # design write-up
```

## Production build

```bash
bun run build
node dist/init.js --input data/patients_sample_50.jsonl --output data/baseline_outputs.jsonl
```

`core.py` prefers `dist/bridge.js` when it exists and falls back to running the
sources through `tsx`, so the harness works either way.
