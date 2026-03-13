"""Unit tests for exact UTF-16 evidence and structural plan validation."""

from collections.abc import Callable
from datetime import date

import pytest
from pydantic import ValidationError

from snapflow.domain.action_plan import (
    MAX_DUE_TEXT_CHARS,
    MAX_EVIDENCE_QUOTE_CHARS,
    MAX_OWNER_CHARS,
    ActionPlanResponse,
    CandidateAction,
    CandidateDue,
    EvidenceRange,
)
from snapflow.domain.evidence import (
    EvidenceIssue,
    EvidenceValidationError,
    EvidenceValidator,
    utf16_length,
)

pytestmark = pytest.mark.unit


def plan_with_evidence(*ranges: EvidenceRange) -> ActionPlanResponse:
    return ActionPlanResponse(
        schema_version="1.0",
        provider="mock",
        summary="One candidate action.",
        candidate_actions=(
            CandidateAction(
                id="action-1",
                title="Prepare the release",
                owner=None,
                due=None,
                priority="unknown",
                evidence=ranges,
            ),
        ),
        clarifications=(),
    )


def test_utf16_range_accepts_an_exact_emoji_and_cjk_quote() -> None:
    source = "Intro 😀 负责人小李 will ship the release."
    quote = "😀 负责人小李"
    codepoint_start = source.index(quote)
    start = utf16_length(source[:codepoint_start])
    evidence = EvidenceRange(
        quote=quote,
        start=start,
        end=start + utf16_length(quote),
    )

    result = EvidenceValidator().validate_plan(source, plan_with_evidence(evidence))

    assert result.candidate_actions[0].evidence == (evidence,)
    assert evidence.end - evidence.start == len(quote) + 1


@pytest.mark.parametrize(
    ("source", "evidence", "issue"),
    [
        (
            "short source",
            EvidenceRange(quote="source", start=6, end=99),
            EvidenceIssue.OUT_OF_RANGE,
        ),
        (
            "exact source",
            EvidenceRange(quote="other", start=6, end=12),
            EvidenceIssue.QUOTE_MISMATCH,
        ),
        (
            "A😀B",
            EvidenceRange(quote="😀", start=2, end=3),
            EvidenceIssue.INVALID_BOUNDARY,
        ),
    ],
    ids=["out-of-range", "quote-mismatch", "split-surrogate"],
)
def test_invalid_utf16_ranges_fail_closed(
    source: str,
    evidence: EvidenceRange,
    issue: EvidenceIssue,
) -> None:
    with pytest.raises(EvidenceValidationError) as raised:
        EvidenceValidator().validate_plan(source, plan_with_evidence(evidence))

    assert raised.value.issue is issue
    assert source not in str(raised.value)


@pytest.mark.parametrize(
    ("ranges", "issue"),
    [
        (
            (
                EvidenceRange(quote="Alpha", start=0, end=5),
                EvidenceRange(quote="Alpha", start=0, end=5),
            ),
            EvidenceIssue.DUPLICATE,
        ),
        (
            (
                EvidenceRange(quote="Alpha Beta", start=0, end=10),
                EvidenceRange(quote="Beta", start=6, end=10),
            ),
            EvidenceIssue.OVERLAP,
        ),
    ],
    ids=["duplicate", "overlap"],
)
def test_duplicate_and_overlapping_ranges_are_rejected(
    ranges: tuple[EvidenceRange, ...],
    issue: EvidenceIssue,
) -> None:
    with pytest.raises(EvidenceValidationError) as raised:
        EvidenceValidator().validate_plan("Alpha Beta", plan_with_evidence(*ranges))

    assert raised.value.issue is issue


@pytest.mark.parametrize(
    "factory",
    [
        lambda: EvidenceRange(quote="   ", start=0, end=3),
        lambda: EvidenceRange(
            quote="x" * (MAX_EVIDENCE_QUOTE_CHARS + 1),
            start=0,
            end=MAX_EVIDENCE_QUOTE_CHARS + 1,
        ),
        lambda: CandidateDue(
            iso_date=date(2026, 1, 1),
            raw_text="   ",
            resolution="absolute",
        ),
        lambda: CandidateDue(
            iso_date=date(2026, 1, 1),
            raw_text="x" * (MAX_DUE_TEXT_CHARS + 1),
            resolution="absolute",
        ),
        lambda: CandidateAction(
            id="action-1",
            title="Ship",
            owner="x" * (MAX_OWNER_CHARS + 1),
            due=None,
            priority="unknown",
            evidence=(EvidenceRange(quote="Ship", start=0, end=4),),
        ),
    ],
    ids=[
        "blank-evidence",
        "long-evidence",
        "blank-date-text",
        "long-date-text",
        "long-owner",
    ],
)
def test_blank_and_overlong_provider_fields_are_rejected(
    factory: Callable[[], object],
) -> None:
    with pytest.raises(ValidationError):
        factory()


def test_duplicate_action_ids_are_rejected_by_the_typed_contract() -> None:
    evidence = EvidenceRange(quote="Ship", start=0, end=4)
    action = CandidateAction(
        id="action-1",
        title="Ship",
        owner=None,
        due=None,
        priority="unknown",
        evidence=(evidence,),
    )

    with pytest.raises(ValidationError, match="ids must be unique"):
        ActionPlanResponse(
            schema_version="1.0",
            provider="mock",
            summary="Duplicate actions.",
            candidate_actions=(action, action),
            clarifications=(),
        )


def test_action_without_evidence_is_rejected_before_workflow_publication() -> None:
    with pytest.raises(ValidationError):
        CandidateAction(
            id="action-1",
            title="Ship",
            owner=None,
            due=None,
            priority="unknown",
            evidence=(),
        )
