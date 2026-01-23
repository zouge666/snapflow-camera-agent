"""Unit tests for the minimal typed plan contract and mock provider."""

import json
from datetime import date
from pathlib import Path
from typing import cast

import pytest
from pydantic import ValidationError

from snapflow.application.build_plan import BuildActionPlan
from snapflow.domain.action_plan import (
    MAX_SOURCE_CHARS,
    ActionPlanRequest,
    EvidenceRange,
)
from snapflow.providers.mock import MockProvider

pytestmark = pytest.mark.unit

REPOSITORY_ROOT = Path(__file__).parents[3]
SAMPLE_MANIFEST = (
    REPOSITORY_ROOT
    / "apps"
    / "web"
    / "public"
    / "samples"
    / "northstar-planning"
    / "manifest.json"
)


def sample_payload() -> dict[str, str]:
    """Load the public fixture input used by both sides of the demo."""
    manifest = cast(
        dict[str, object], json.loads(SAMPLE_MANIFEST.read_text(encoding="utf-8"))
    )
    fixture_input = cast(dict[str, str], manifest["input"])
    return {
        "source_text": fixture_input["text"],
        "locale": fixture_input["locale"],
        "timezone": fixture_input["timezone"],
        "reference_date": fixture_input["reference_date"],
    }


def sample_request() -> ActionPlanRequest:
    return ActionPlanRequest.model_validate(sample_payload())


def test_mock_plan_is_typed_deterministic_and_evidence_linked() -> None:
    service = BuildActionPlan(provider=MockProvider())
    request = sample_request()

    first = service.execute(request)
    second = service.execute(request)

    assert first == second
    assert first.model_dump(mode="json") == second.model_dump(mode="json")
    assert first.schema_version == "1.0"
    assert first.provider == "mock"
    assert first.summary == "3 candidate actions found. 1 detail needs clarification."
    assert [action.id for action in first.candidate_actions] == [
        "action-1",
        "action-2",
        "action-3",
    ]
    assert first.candidate_actions[0].due is not None
    assert first.candidate_actions[0].due.iso_date == date(2026, 7, 17)
    assert first.candidate_actions[1].owner is None
    assert first.candidate_actions[1].due is not None
    assert first.candidate_actions[1].due.resolution == "ambiguous"
    assert first.candidate_actions[2].due is not None
    assert first.candidate_actions[2].due.iso_date == date(2026, 7, 22)
    assert len(first.clarifications) == 1
    assert first.clarifications[0].field_path == "candidate_actions[1].due"

    for action in first.candidate_actions:
        for evidence in action.evidence:
            assert request.source_text[evidence.start : evidence.end] == evidence.quote

    clarification_evidence = first.clarifications[0].evidence
    assert clarification_evidence is not None
    assert (
        request.source_text[clarification_evidence.start : clarification_evidence.end]
        == clarification_evidence.quote
    )


def test_mock_plan_does_not_invent_actions_for_unknown_text() -> None:
    request = ActionPlanRequest(
        source_text="Discussed the weather. No follow-up work was recorded.",
        locale="en-US",
        timezone="Europe/Copenhagen",
        reference_date=date(2026, 7, 16),
    )

    result = MockProvider().build_plan(request)

    assert result.candidate_actions == ()
    assert result.clarifications == ()
    assert result.summary == "0 candidate actions found. 0 details need clarification."


def test_clarification_targets_the_returned_candidate_index() -> None:
    request = ActionPlanRequest(
        source_text="Prepare the support FAQ before the pilot review.",
        locale="en-US",
        timezone="Europe/Copenhagen",
        reference_date=date(2026, 7, 16),
    )

    result = MockProvider().build_plan(request)

    assert [action.id for action in result.candidate_actions] == ["action-2"]
    assert result.clarifications[0].field_path == "candidate_actions[0].due"


def test_mock_plan_rejects_non_fixture_context_without_guessing_dates() -> None:
    request = sample_request().model_copy(update={"timezone": "Europe/Berlin"})

    result = MockProvider().build_plan(request)

    assert result.candidate_actions == ()
    assert result.clarifications == ()
    assert "supported synthetic sample context" in result.summary


@pytest.mark.parametrize(
    "source_text",
    ["", " \n ", "x" * (MAX_SOURCE_CHARS + 1)],
    ids=["empty", "whitespace", "over-limit"],
)
def test_request_rejects_invalid_source_text(source_text: str) -> None:
    payload = sample_payload()
    payload["source_text"] = source_text

    with pytest.raises(ValidationError):
        ActionPlanRequest.model_validate(payload)


def test_request_normalizes_context_but_preserves_source_offsets() -> None:
    payload = sample_payload()
    payload["source_text"] = f" {payload['source_text']} "
    payload["locale"] = " en-US "
    payload["timezone"] = " Europe/Copenhagen "

    request = ActionPlanRequest.model_validate(payload)

    assert request.source_text.startswith(" Northstar")
    assert request.source_text.endswith("minutes ")
    assert request.locale == "en-US"
    assert request.timezone == "Europe/Copenhagen"


def test_request_rejects_whitespace_only_context() -> None:
    payload = sample_payload()
    payload["timezone"] = "   "

    with pytest.raises(ValidationError, match="non-whitespace"):
        ActionPlanRequest.model_validate(payload)


def test_request_and_evidence_contracts_are_strict() -> None:
    payload = cast(dict[str, object], sample_payload())
    payload["image_base64"] = "not-allowed"

    with pytest.raises(ValidationError, match="Extra inputs are not permitted"):
        ActionPlanRequest.model_validate(payload)

    with pytest.raises(ValidationError, match="greater than start"):
        EvidenceRange(quote="x", start=5, end=5)
