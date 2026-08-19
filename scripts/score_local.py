#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.11"
# dependencies = [
#   "openai>=2.0.0",
#   "pydantic>=2.8.0",
# ]
# ///

"""Score triage outputs locally, reusing the provided scorer's own metric code.

`run_evals.py` computes the four local metrics *and* uploads an OpenAI Evals run.
The upload is what produces the shareable report, but it costs an API round trip
per iteration and adds nothing while the rules are still being tuned. This script
imports the exact same private metric functions from `run_evals.py`, so the
numbers it prints are the numbers `make evals` will print — it simply skips the
remote run.

Iterate with this; use `make evals` for the real report.
"""

from __future__ import annotations

import argparse
import collections
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from run_evals import (  # noqa: E402
    METRIC_WEIGHTS,
    _extract_output_payload,
    _local_metrics_for_row,
    _summarize_local_rows,
    load_baseline_outputs,
    load_cases,
)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input", default=str(ROOT / "data" / "patients_sample_50.jsonl"))
    parser.add_argument("--outputs", default=str(ROOT / "data" / "baseline_outputs.jsonl"))
    parser.add_argument(
        "--failures",
        action="store_true",
        help="Print a per-case breakdown of every case that lost a point",
    )
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    cases = load_cases(Path(args.input))
    outputs_by_index = load_baseline_outputs(Path(args.outputs))

    local_rows = []
    failures = []
    for idx, case in enumerate(cases):
        submission = case.submission.model_dump()
        payload, _err = _extract_output_payload(outputs_by_index.get(idx, {}))
        local = _local_metrics_for_row(submission, case.expected_output, payload)
        local_rows.append(
            {
                "metrics": local["metrics"],
                "aggregate_local_score": local["aggregate_local_score"],
            }
        )
        if not all(local["metrics"].values()):
            failures.append((case.case_id, local))

    summary = _summarize_local_rows(local_rows)

    print(f"records                        {summary['records']}")
    for metric, weight in METRIC_WEIGHTS.items():
        rate = summary[f"{metric}_rate_pct"]
        print(f"{metric:31s}{rate:6.2f}%   (weight {weight})")
    print(f"{'AGGREGATE':31s}{summary['aggregate_local_score_pct']:6.2f}%")

    failed_metric = collections.Counter()
    for _cid, local in failures:
        for metric, ok in local["metrics"].items():
            if not ok:
                failed_metric[metric] += 1
    if failed_metric:
        print("\nfailures by metric:")
        for metric, n in failed_metric.most_common():
            print(f"  {n:3d}  {metric}")

    if args.failures and failures:
        print(f"\n{'=' * 78}\nPER-CASE FAILURES ({len(failures)})\n{'=' * 78}")
        for cid, local in failures:
            bad = [m for m, ok in local["metrics"].items() if not ok]
            print(f"\n{cid}  failed: {', '.join(bad)}")
            print(f"  expected decision   {local['oracle']['decision']}")
            print(f"  actual   decision   {local['actual_decision']}")
            print(f"  expected categories {local['expected_categories']}")
            print(f"  actual   categories {local['actual_categories']}")
            if local["parse_error"]:
                print(f"  parse error         {local['parse_error']}")
            if "issues_value_grounding" in bad and local["parsed_output"]:
                for issue in local["parsed_output"]["issues"]:
                    print(
                        f"    ungrounded? [{issue['category']}] "
                        f"src={issue['evidence']['source']!r}"
                    )


if __name__ == "__main__":
    main()
