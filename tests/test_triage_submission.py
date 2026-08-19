"""Tests for the Python bridge into the TypeScript triage implementation.

The starter's version of this file asserted on the baseline's OpenAI wiring —
that `triage_submission` called `client.responses.create` once, with a particular
`instructions` string and `json_schema` format. That implementation is gone: the
solution is deterministic TypeScript in `src/`, and `core.py: triage_submission`
now delegates to it over a subprocess. Those assertions would have been testing
code that no longer exists, so they are replaced with tests of the contract that
actually holds now.

The rule-level behaviour is covered by the vitest suite (`bun run test`), which
includes a golden test over all 50 dataset cases. What is left to verify on this
side is the bridge itself: that the subprocess round-trip produces a valid
`TriageOutput`, that it is stable, and that failures surface as exceptions rather
than silently-null rows.

These tests shell out to Node, so they need `bun install` (and ideally
`bun run build`) to have been run first.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest
from pydantic import ValidationError

from core import (
    PatientSubmission,
    PreparedPatientCase,
    TriageOutput,
    triage_submission,
)

ROOT = Path(__file__).resolve().parent.parent
DATASET = ROOT / "data" / "patients_sample_50.jsonl"


@pytest.fixture(scope="module")
def dataset() -> list[PreparedPatientCase]:
    rows = [
        json.loads(line)
        for line in DATASET.read_text(encoding="utf-8").splitlines()
        if line.strip()
    ]
    return [PreparedPatientCase.model_validate(row) for row in rows]


@pytest.fixture
def submission_payload() -> dict[str, object]:
    """A submission that satisfies every rule, so a clean pass is READY."""
    return {
        "patient": {"id": "patient-1"},
        "procedure": {
            "case_id": "case-1",
            "procedure_risk": "LOW",
            "procedure_date": "2026-02-01",
        },
        "vitals": [
            {
                "type": "blood_pressure",
                "systolic": 120,
                "diastolic": 80,
                "date": "2026-01-25",
            },
            {"type": "temperature", "value_f": 98.6, "date": "2026-01-25"},
        ],
        "labs": [
            {
                "code": "CBC",
                "display": "Complete blood count",
                "effective_at": "2026-01-20",
                "status": "final",
            }
        ],
        "medications": [],
        "conditions": [],
        "documents": [
            {
                "type": "History and Physical",
                "date": "2026-01-20",
                "text": "History and physical completed.",
            },
            {
                "type": "Surgical Consent",
                "date": "2026-01-22",
                "text": "Signed surgical consent.",
            },
        ],
    }


def test_bridge_returns_structured_output(submission_payload: dict[str, object]) -> None:
    output = triage_submission(submission_payload, model="unused")

    assert isinstance(output, TriageOutput)
    assert output.decision == "READY"
    assert output.issues == []
    assert output.explanation


def test_bridge_accepts_a_validated_submission(
    submission_payload: dict[str, object],
) -> None:
    submission = PatientSubmission.model_validate(submission_payload)
    output = triage_submission(submission, model="unused")
    assert output.decision == "READY"


def test_bridge_is_deterministic(submission_payload: dict[str, object]) -> None:
    """Repeated calls must be byte-identical.

    This is the property `make determinism` measures across ten runs; asserting
    it here catches a regression without spending a full harness run.
    """
    first = triage_submission(submission_payload, model="unused").model_dump()
    second = triage_submission(submission_payload, model="unused").model_dump()
    assert json.dumps(first, sort_keys=True) == json.dumps(second, sort_keys=True)


def test_bridge_reproduces_the_worked_example(
    dataset: list[PreparedPatientCase],
) -> None:
    """case_00000 is the example worked through in the exercise brief."""
    case = next(c for c in dataset if c.case_id == "case_00000")
    output = triage_submission(case.submission.model_dump(), model="unused")

    assert output.decision == "NEEDS_FOLLOW_UP"
    assert {issue.category for issue in output.issues} == {
        "MISSING_REQUIRED_DATA",
        "ANTICOAGULATION_MANAGEMENT",
    }

    by_category = {issue.category: issue for issue in output.issues}
    assert (
        by_category["MISSING_REQUIRED_DATA"].evidence.source
        == "procedure.procedure_date"
    )
    # The brief cites documents[4] for this case, which fixes zero-based indexing.
    assert by_category["ANTICOAGULATION_MANAGEMENT"].evidence.source == "documents[4]"


def test_bridge_surfaces_invalid_input_as_an_exception() -> None:
    """A malformed submission must raise, not return a plausible-looking output.

    `run_baseline.py` catches exceptions per row and records them in the `error`
    field, so the scorer counts the row as failed. Swallowing the error inside
    the bridge would instead report a confident wrong answer.

    Structurally invalid input is rejected by pydantic on this side of the bridge
    (a `ValidationError`) before the subprocess is spawned; a failure inside the
    child surfaces as a `RuntimeError`. Either is acceptable — what matters is
    that nothing is returned.
    """
    with pytest.raises((ValidationError, RuntimeError)):
        triage_submission({"procedure": "not an object"}, model="unused")
