"""Unit tests for context-bound, all-day date normalization."""

from datetime import date

import pytest
from pydantic import ValidationError

from snapflow.domain.action_plan import (
    ActionPlanRequest,
    ActionPlanResponse,
    CandidateAction,
    CandidateDue,
    Clarification,
    EvidenceRange,
)
from snapflow.domain.dates import (
    DateIssue,
    DateNormalizer,
    DateValidationError,
)

pytestmark = pytest.mark.unit


@pytest.mark.parametrize(
    ("raw_text", "locale", "expected"),
    [
        ("by Friday", "en-US", date(2026, 1, 16)),
        ("周五之前", "zh-CN", date(2026, 1, 16)),
    ],
    ids=["english-friday", "chinese-friday"],
)
def test_weekdays_use_the_explicit_locale_and_reference_date(
    raw_text: str,
    locale: str,
    expected: date,
) -> None:
    result = DateNormalizer().resolve(
        raw_text,
        locale=locale,
        timezone="Europe/Copenhagen",
        reference_date=date(2026, 1, 15),
    )

    assert result is not None
    assert result.value == expected
    assert result.resolution == "relative"
    assert result.raw_text == raw_text


def test_relative_weekday_crosses_the_calendar_year() -> None:
    result = DateNormalizer().resolve(
        "Friday",
        locale="en-US",
        timezone="Europe/Copenhagen",
        reference_date=date(2025, 12, 31),
    )

    assert result is not None
    assert result.value == date(2026, 1, 2)


def test_month_and_day_without_a_year_choose_the_next_occurrence() -> None:
    result = DateNormalizer().resolve(
        "on January 5",
        locale="en-US",
        timezone="Europe/Copenhagen",
        reference_date=date(2025, 12, 31),
    )

    assert result is not None
    assert result.value == date(2026, 1, 5)
    assert result.resolution == "relative"


def test_dst_boundary_remains_an_all_day_local_date() -> None:
    result = DateNormalizer().resolve(
        "Sunday",
        locale="en-GB",
        timezone="Europe/Copenhagen",
        reference_date=date(2025, 3, 29),
    )

    assert result is not None
    assert result.value == date(2025, 3, 30)
    assert type(result.value) is date
    assert result.timezone == "Europe/Copenhagen"
    assert result.all_day is True


def test_absolute_iso_date_is_preserved_as_all_day() -> None:
    raw_text = "on 2026-01-02"

    result = DateNormalizer().resolve(
        raw_text,
        locale="zh-CN",
        timezone="Asia/Shanghai",
        reference_date=date(2025, 12, 31),
    )

    assert result is not None
    assert result.value == date(2026, 1, 2)
    assert result.resolution == "absolute"
    assert result.raw_text == raw_text
    assert result.all_day is True


def test_invalid_timezone_is_rejected_at_request_and_service_boundaries() -> None:
    with pytest.raises(ValidationError, match="valid IANA timezone"):
        ActionPlanRequest(
            source_text="Ship by Friday.",
            locale="en-US",
            timezone="server-local-time",
            reference_date=date(2026, 1, 15),
        )

    with pytest.raises(DateValidationError) as raised:
        DateNormalizer().resolve(
            "Friday",
            locale="en-US",
            timezone="server-local-time",
            reference_date=date(2026, 1, 15),
        )

    assert raised.value.issue is DateIssue.INVALID_TIMEZONE


def test_conflicting_or_impossible_dates_are_rejected() -> None:
    with pytest.raises(DateValidationError) as conflicting:
        DateNormalizer().resolve(
            "2026-01-16 or 2026-01-18",
            locale="en-US",
            timezone="Europe/Copenhagen",
            reference_date=date(2026, 1, 15),
        )
    assert conflicting.value.issue is DateIssue.CONFLICTING_DATES

    with pytest.raises(DateValidationError) as impossible:
        DateNormalizer().resolve(
            "2025-02-30",
            locale="en-US",
            timezone="Europe/Copenhagen",
            reference_date=date(2026, 1, 1),
        )
    assert impossible.value.issue is DateIssue.INVALID_DATE


def test_plan_normalization_fills_date_without_changing_raw_text() -> None:
    request = ActionPlanRequest(
        source_text="Alex will ship by Friday.",
        locale="en-US",
        timezone="Europe/Copenhagen",
        reference_date=date(2026, 1, 15),
    )
    due = CandidateDue(iso_date=None, raw_text="by Friday", resolution="relative")
    plan = plan_with_due(request.source_text, due)

    normalized = DateNormalizer().normalize_plan(request, plan)

    normalized_due = normalized.candidate_actions[0].due
    assert normalized_due is not None
    assert normalized_due.iso_date == date(2026, 1, 16)
    assert normalized_due.raw_text == "by Friday"
    assert due.iso_date is None


def test_provider_date_mismatch_is_rejected_instead_of_silently_changed() -> None:
    request = ActionPlanRequest(
        source_text="Alex will ship by Friday.",
        locale="en-US",
        timezone="Europe/Copenhagen",
        reference_date=date(2026, 1, 15),
    )
    plan = plan_with_due(
        request.source_text,
        CandidateDue(
            iso_date=date(2026, 1, 18),
            raw_text="by Friday",
            resolution="relative",
        ),
    )

    with pytest.raises(DateValidationError) as raised:
        DateNormalizer().normalize_plan(request, plan)

    assert raised.value.issue is DateIssue.VALUE_MISMATCH


def test_date_must_be_evidence_backed_and_use_the_declared_resolution() -> None:
    request = ActionPlanRequest(
        source_text="Alex will ship the release.",
        locale="en-US",
        timezone="Europe/Copenhagen",
        reference_date=date(2026, 1, 15),
    )
    unsourced_plan = plan_with_due(
        request.source_text,
        CandidateDue(iso_date=None, raw_text="by Friday", resolution="relative"),
    )

    with pytest.raises(DateValidationError) as unsourced:
        DateNormalizer().normalize_plan(request, unsourced_plan)
    assert unsourced.value.issue is DateIssue.UNSOURCED_DATE

    sourced_request = request.model_copy(
        update={"source_text": "Alex will ship by Friday."}
    )
    wrong_resolution = plan_with_due(
        sourced_request.source_text,
        CandidateDue(
            iso_date=None,
            raw_text="by Friday",
            resolution="absolute",
        ),
    )

    with pytest.raises(DateValidationError) as mismatch:
        DateNormalizer().normalize_plan(sourced_request, wrong_resolution)
    assert mismatch.value.issue is DateIssue.RESOLUTION_MISMATCH


def test_explicit_ambiguity_requires_one_evidence_backed_clarification() -> None:
    source_text = "Prepare the FAQ before the pilot review."
    request = ActionPlanRequest(
        source_text=source_text,
        locale="en-US",
        timezone="Europe/Copenhagen",
        reference_date=date(2026, 1, 15),
    )
    due = CandidateDue(
        iso_date=None,
        raw_text="before the pilot review",
        resolution="ambiguous",
    )
    due_start = source_text.index(due.raw_text)
    evidence = EvidenceRange(
        quote=due.raw_text,
        start=due_start,
        end=due_start + len(due.raw_text),
    )
    plan = plan_with_due(source_text, due)
    clarification = Clarification(
        id="clarification-1",
        field_path="candidate_actions[0].due",
        question="When is the pilot review?",
        reason="The date is not present in the source.",
        evidence=evidence,
    )
    clarified_plan = plan.model_copy(update={"clarifications": (clarification,)})

    result = DateNormalizer().normalize_plan(request, clarified_plan)

    assert result.candidate_actions[0].due == due

    with pytest.raises(DateValidationError) as raised:
        DateNormalizer().normalize_plan(request, plan)
    assert raised.value.issue is DateIssue.MISSING_CLARIFICATION


def plan_with_due(source_text: str, due: CandidateDue) -> ActionPlanResponse:
    return ActionPlanResponse(
        schema_version="1.0",
        provider="mock",
        summary="One candidate action.",
        candidate_actions=(
            CandidateAction(
                id="action-1",
                title="Complete the action",
                owner="Alex",
                due=due,
                priority="unknown",
                evidence=(
                    EvidenceRange(
                        quote=source_text,
                        start=0,
                        end=len(source_text),
                    ),
                ),
            ),
        ),
        clarifications=(),
    )
