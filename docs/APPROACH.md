# Approach and design decisions

## Summary

The policy is a decision procedure, not a reasoning problem. Four rules, three
statuses, a handful of date comparisons and thresholds. So the implementation is
a deterministic rule engine in TypeScript, and the language model is confined to
the few questions in the policy that are genuinely about prose — where it is
**off by default**, for reasons the measurements below make concrete.

Scored by the provided `run_evals.py`, unmodified: **100%** aggregate, with 100%
on each of the four metrics, and 100% decision / format / exact-output stability
across ten runs.

## Reading the problem before writing code

The single most useful thing I did was study the 50 expected outputs before
implementing anything. Three findings shaped everything after.

**The oracle is a deterministic rule engine.** Every `details` string is a format
template — 16 description templates and ~18 detail templates across all 50 cases:

```
"procedure.procedure_date is null"
"H&P date 2026-01-30 vs procedure_date 2026-03-03 (32 days prior; must be within 30)"
"latest temperature value_f=101.0; threshold is > 100.4"
```

That reframes the task. It is not "prompt a model to reason about a policy", it
is "recover a specification from its outputs". Once that was clear, an LLM in the
decision path looked like a liability rather than the point.

**The scorer compares the *set* of issue categories for exact equality.** Not a
subset, not an F1 — set equality. That metric is 1.0 of the 3.5 total weight, so
one extra plausible category costs as much as missing a real one.

**The oracle is parsimonious.** 42 of 50 cases have exactly one issue category.
Critically, in all seven cases where `procedure_date` or `procedure_risk` is null,
the expected set is exactly `{MISSING_REQUIRED_DATA}` — even though those nulls
also make the H&P window and the CBC window uncheckable. The oracle reports the
missing input once and stays silent about everything downstream of it.

## The central design decision: prerequisites gate checks, not rules

That last finding is the architecture. A naive implementation reports every rule
a missing field invalidates and fails the category metric on every such case.

So `PolicyContext` resolves the two load-bearing fields up front, one rule
(`DataCompletenessRule`) owns every `MISSING_REQUIRED_DATA` issue, and the other
rules skip the individual checks they cannot compute — without inventing a second
issue about the same missing field.

The granularity matters: prerequisites gate **checks**, not whole rules. Document
*presence* does not depend on the procedure date, only *freshness* does. So a
submission with a null date is still checked for a missing consent, and still
stays silent about staleness. Rule 2 is different again — without a risk level
there is no way to know which panels are required, so it stands down entirely.

## Where the difficulty actually is

Not in the policy. In the strings.

**~100 document type spellings for three concepts.** The generator composes a
prefix (`PREOP - `, `Imported: `, `Scanned `, `Pre-op `), a core name with many
spellings (`H&P`, `H and P`, `H+P`, `H/P`, `Hx & Physical`, `Hist & Phys`,
`History/Physical`), and a suffix (`(scanned)`, `(external)`, `[PDF]`,
`- signed`). Exact matching is hopeless; pattern matching is straightforward.

**Three traps that punish the obvious implementation:**

1. `History & Phsyical` — a deliberate misspelling. In case_00002 it is the most
   recent H&P-looking document and comfortably inside the 30-day window, while
   the correctly-spelled one is 32 days stale. The oracle flags the stale one, so
   the typo must **not** be recognised. See below — this is where the LLM fails.

2. `"Consent obtained; signature on file."` — a signed consent that never uses
   the word "signed". And every *unsigned* phrasing contains "signed" inside
   "unsigned", so a naive `includes('signed')` inverts the answer. This one
   phrasing accounted for all six category mismatches in my first full run.

3. The anticoagulation plan is located by **text**, not type. case_00042 has a
   document typed `Perioperative Medication Plan` whose text says only
   "Discussed blood thinner use with patient; final plan pending specialist
   input" — never naming the drug. The expected evidence points at the whole
   `documents` collection, so the oracle did not treat it as a plan document.
   Matching on type would have cited it.

Plus quieter ones: `LAB-CBC` and `CBC` are the same panel; `active: null` on an
anticoagulant is a data gap rather than "not taking"; absent vitals are a gap
rather than a safety pass; the BP thresholds are inclusive (`>=`) while the
temperature threshold is exclusive (`>`).

## Why the LLM is off by default — measured, not assumed

The obvious place for a model is the document classification, so I built the
integration and then measured whether it helps. Three modes:

- `off` — no calls (default)
- `assist` — the model adjudicates only documents the classifier could not
  resolve, and its answers are used
- `shadow` — the model is asked about **every** relevant document, disagreements
  are logged, and the deterministic answer still ships

Shadow mode over all 50 cases produced **38 disagreements**, all on "is this an
H&P":

| Direction | Count | What they were |
| --------- | ----- | -------------- |
| classifier yes, model no | 32 | Superseded prior H&Ps ("Prior pre-op H&P retained for longitudinal chart context") — defensible, and harmless because most-recent selection already discards them |
| classifier yes, model no | 5 | **Current, unambiguous H&Ps** (`H&P Note`, `Scanned Admission H&P`, `Pre-op H and P`) that the model simply got wrong |
| classifier no, model yes | 1 | `History & Phsyical` — the typo |

Then the decisive measurement. Running `assist` mode end-to-end:

| Mode | Aggregate | Failures |
| ---- | --------- | -------- |
| `off` (deterministic) | **100.00%** | none |
| `assist` (gpt-5-mini) | 99.43% | case_00002 |

The single regression is case_00002, and the reason is worth stating precisely:
**the model is right about the typo and wrong about the specification.** It reads
`History & Phsyical` as a History and Physical — which any clinician would — and
that makes it the most recent H&P, inside the window, so the staleness issue
disappears. The oracle keys off well-formed type names. The model's better
reading scores worse.

That is the argument for `off`, and it is not "LLMs are bad at this". It is that
the model and the oracle are answering different questions: the model does
clinical reasoning, the oracle applies a mechanical spec. Where they diverge, the
spec wins, because the spec is what is being scored — and in a real deployment,
the spec is what is auditable.

There is also a cost side. `off` runs the full dataset in ~5 seconds with no API
calls and is byte-for-byte reproducible, which is exactly what the determinism
metric rewards. `shadow` takes several minutes and ~200 calls.

**What the model is still for.** It stays wired in, because the deterministic
matchers are tuned to phrasings I have seen. A new consent wording or a new
document type is precisely the case where a model beats a regex, and shadow mode
is the mechanism for finding that out safely: run it, read the disagreements,
promote to `assist` only where the evidence supports it. Judgments are cached by
content hash so enabling it costs determinism only on a cold cache.

## Architecture

```
init.ts / bridge.ts   entrypoints (batch, and stdin/stdout for the Python bridge)
dependencies.ts       composition root — the only place that reads env or constructs
config.ts             zod-validated environment
models/               zod schemas at both trust boundaries (input, output)
core/normalize/       string-level matching: document types, consent text, lab codes
core/rules/           the four policy rules + data completeness, as pure functions
core/triage/          runs the rules, resolves precedence, orders issues
llm/                  the only files that know OpenAI exists
```

Some choices worth calling out:

**Rules are pure synchronous functions.** Model judgments are resolved *before*
the rules run and handed to them as a lookup table keyed by document index. So
every rule is testable with plain constructor arguments and no mocking, the model
is genuinely optional, and all network I/O happens in one batched place instead
of scattered through the policy logic.

**The explanation is generated, never model-authored.** It is a mechanical join of
the issues; there is no path by which prose drifts from the structured output.

**Evidence paths go through a builder.** The harness resolves `evidence.source`
with a restricted grammar — `collection[index].field`, lowercase, no nested
traversal — and silently scores an unresolvable path as ungrounded. A unit test
mirrors that grammar and asserts every source emitted across all 50 cases, so a
malformed path fails `bun run test` rather than costing an eval run.

**Dates are parsed textually, not via `new Date()`.** A late-evening UTC timestamp
parsed in a negative-offset timezone lands on the previous local day, which would
shift boundary cases depending on where the code runs.

## Keeping the provided harness intact

`run_evals.py` and `view_report.py` are byte-identical to the starter. The only
changed file is `core.py: triage_submission`, which now shells out to the
TypeScript over stdin/stdout instead of making an LLM call.

That was deliberate: the scores above come from the exercise's own scorer, not
one I wrote. Reimplementing the grader in TypeScript would have been both wasted
effort and a conflict of interest.

`scripts/score_local.py` imports the scorer's own private metric functions to
compute the same numbers without the remote Evals upload — for fast iteration,
not as a replacement.

## Testing

237 vitest tests plus 5 pytest tests over the bridge. The suite is structured
around the traps: every one has a named regression test explaining what breaks if
it regresses. The highest-value test is a golden run over all 50 dataset cases
asserting decision and category set in-process, so a rule change that trades one
case for another is named immediately rather than showing up as a moved
percentage.

It deliberately does **not** assert on `description` or `evidence.details` — the
scorer never compares those to the oracle, so pinning them would be brittle
against changes that cannot affect the score.

## Honest limitations

**100% measures fit to the sample, not generalisation.** The rules were derived by
reading these same 50 expected outputs. The most likely over-fits:

- *Consent phrasings.* Exactly eight appear; the matcher handles those eight and
  a modest neighbourhood. A ninth wording is a coin flip.
- *The typo.* `History & Phsyical` is rejected because the oracle rejects it. If
  the real intent were "recognise H&Ps robustly", that is backwards — and this is
  the one place where matching the spec and doing the right thing genuinely
  diverge. I chose the spec and flagged it rather than quietly doing either.
- *The anticoagulation positive path is untested by the harness.* All seven active
  anticoagulant cases fail, and there is no example of a *complete* plan in the
  data. `describesPerioperativePlan` implements a real check (it looks for
  hold/stop/resume/bridge language with timing) rather than hardcoding failure,
  but only unit tests exercise its positive branch.
- *The anticoagulant list is a closed set* of twelve drug names. The policy forbids
  outside medical knowledge, so this is configuration — but a thirteenth drug
  silently passes Rule 3.

**Not addressed.** No batching or concurrency in the batch runner (unnecessary at
50 cases, ~5s); no structured metrics; the H&P/consent classifiers would benefit
from being data-driven rather than regexes if the type vocabulary kept growing.

## If I continued

1. Adversarial cases the sample lacks — an H&P dated after the procedure, two
   consents disagreeing, a complete anticoagulation plan, a fourth risk level.
2. Promote the classifier from regexes to a table of patterns with provenance,
   so adding a phrasing is a data change with a test rather than a regex edit.
3. Use shadow mode as a standing CI job over new data: it costs nothing in
   production and is the early-warning system for the day the deterministic
   matchers stop being sufficient.
