"""Unit tests for the versioned durable-run contract."""

from datetime import UTC, date, datetime, timedelta
from typing import Any

import pytest
from pydantic import ValidationError

from snapflow.domain.run_contract import (
    ActionDecision,
    ActionItem,
    ActionPriority,
    ApprovalDecisionInput,
    ApprovalRequest,
    ClarificationAnswerKind,
    ClarificationAnswerRequest,
    ClarificationQuestion,
    CreateRunRequest,
    DeleteRunResponse,
    ErrorEnvelope,
    Evidence,
    ExportFormat,
    ExportRequest,
    PublicError,
    PublicErrorCode,
    ResumeRunRequest,
    RunResponse,
    RunStatus,
    RunView,
    SafeTraceEvent,
    TraceOutcome,
)

pytestmark = pytest.mark.unit


def create_payload() -> dict[str, object]:
    """Return a valid create request payload."""
    return {
        "schema_version": "1.0",
        "source_text": "Alex will prepare the release notes by Friday.",
        "locale": "en-US",
        "timezone": "Europe/Copenhagen",
        "reference_date": "2026-07-29",
    }


def evidence() -> Evidence:
    """Return a small valid source range."""
    return Evidence(quote="release notes", start=22, end=35)


def action_item() -> ActionItem:
    """Return one evidence-linked candidate action."""
    return ActionItem(
        id="action-1",
        title="Prepare the release notes",
        owner="Alex",
        due_date=date(2026, 7, 31),
        due_text="by Friday",
        priority=ActionPriority.HIGH,
        evidence=(evidence(),),
    )


def trace_event() -> SafeTraceEvent:
    """Return redacted metadata without source or prompt content."""
    return SafeTraceEvent(
        sequence=0,
        node="input_validation",
        outcome=TraceOutcome.SUCCEEDED,
        occurred_at=datetime(2026, 7, 29, 10, tzinfo=UTC),
        duration_ms=3,
        schema_version="1.0",
    )


def run_view() -> RunView:
    """Return a complete privacy-aware run snapshot."""
    created_at = datetime(2026, 7, 29, 10, tzinfo=UTC)
    return RunView(
        schema_version="1.0",
        run_id="run_12345678",
        status=RunStatus.INTERRUPTED_FOR_APPROVAL,
        candidate_items=(action_item(),),
        clarification_questions=(),
        clarification_count=0,
        safe_trace=(trace_event(),),
        created_at=created_at,
        expires_at=created_at + timedelta(hours=24),
    )


@pytest.mark.parametrize(
    ("model", "payload"),
    [
        (CreateRunRequest, create_payload()),
        (
            ResumeRunRequest,
            {"schema_version": "1.0", "last_seen_trace_sequence": 2},
        ),
        (
            ClarificationAnswerRequest,
            {
                "schema_version": "1.0",
                "clarification_id": "clarification-1",
                "kind": "free_text",
                "answer": "The review is on 2026-08-03.",
            },
        ),
        (
            ApprovalRequest,
            {
                "schema_version": "1.0",
                "decisions": [
                    {
                        "action_id": "action-1",
                        "decision": "approve",
                        "reviewed": {
                            "title": "Prepare the release notes",
                            "owner": "Alex",
                            "due_date": "2026-07-31",
                            "priority": "high",
                        },
                    }
                ],
            },
        ),
        (
            ExportRequest,
            {
                "schema_version": "1.0",
                "formats": ["ics", "markdown"],
                "approved_action_ids": ["action-1"],
            },
        ),
    ],
    ids=["create", "resume", "clarify", "approve", "export"],
)
def test_request_contracts_reject_unknown_fields(
    model: type[Any],
    payload: dict[str, object],
) -> None:
    payload["image_base64"] = "not-allowed"

    with pytest.raises(ValidationError, match="Extra inputs are not permitted"):
        model.model_validate(payload)


@pytest.mark.parametrize(
    ("start", "end"),
    [(-1, 2), (2, 2), (3, 2)],
    ids=["negative-start", "empty", "reversed"],
)
def test_evidence_rejects_invalid_bounds(start: int, end: int) -> None:
    with pytest.raises(ValidationError):
        Evidence(quote="x", start=start, end=end)


def test_create_contract_preserves_source_offsets_and_validates_dates() -> None:
    payload = create_payload()
    payload["source_text"] = "  Alex will ship this.  "
    payload["locale"] = " en-US "

    request = CreateRunRequest.model_validate(payload)

    assert request.source_text == "  Alex will ship this.  "
    assert request.locale == "en-US"
    assert request.reference_date == date(2026, 7, 29)

    payload["reference_date"] = "2026-02-30"
    with pytest.raises(ValidationError):
        CreateRunRequest.model_validate(payload)


@pytest.mark.parametrize(
    ("model", "payload"),
    [
        (
            ActionItem,
            {
                "id": "action-1",
                "title": "Prepare notes",
                "owner": None,
                "due_date": None,
                "due_text": None,
                "priority": "urgent",
                "evidence": [{"quote": "Prepare notes", "start": 0, "end": 13}],
            },
        ),
        (
            ClarificationAnswerRequest,
            {
                "schema_version": "1.0",
                "clarification_id": "clarification-1",
                "kind": "voice",
                "answer": "Monday",
            },
        ),
        (
            ExportRequest,
            {
                "schema_version": "1.0",
                "formats": ["pdf"],
                "approved_action_ids": ["action-1"],
            },
        ),
    ],
    ids=["priority", "answer-kind", "export-format"],
)
def test_contract_rejects_unknown_enum_values(
    model: type[Any],
    payload: dict[str, object],
) -> None:
    with pytest.raises(ValidationError):
        model.model_validate(payload)


def test_clarification_shape_matches_answer_kind() -> None:
    option_question = ClarificationQuestion(
        id="clarification-1",
        field_path="candidate_items[0].owner",
        question="Who owns this action?",
        reason="No owner was present in the reviewed text.",
        answer_kind=ClarificationAnswerKind.OPTION,
        options=("Alex", "Mina"),
        evidence=None,
    )

    assert option_question.options == ("Alex", "Mina")

    with pytest.raises(ValidationError, match="at least one option"):
        option_question.model_copy(update={"options": ()}).model_validate(
            option_question.model_copy(update={"options": ()}).model_dump()
        )

    with pytest.raises(ValidationError, match="cannot include options"):
        ClarificationQuestion(
            id="clarification-2",
            field_path="candidate_items[0].due_date",
            question="When is it due?",
            reason="The source date is ambiguous.",
            answer_kind=ClarificationAnswerKind.FREE_TEXT,
            options=("Monday",),
            evidence=evidence(),
        )

    for invalid_options, message in [
        (("Alex", " "), "non-whitespace"),
        (("Alex", "Alex"), "distinct"),
    ]:
        with pytest.raises(ValidationError, match=message):
            ClarificationQuestion(
                id="clarification-3",
                field_path="candidate_items[0].owner",
                question="Who owns this action?",
                reason="The owner is ambiguous.",
                answer_kind=ClarificationAnswerKind.OPTION,
                options=invalid_options,
                evidence=None,
            )


def test_text_requests_reject_whitespace_only_content() -> None:
    create = create_payload()
    create["source_text"] = " \n "
    with pytest.raises(ValidationError, match="source_text"):
        CreateRunRequest.model_validate(create)

    create = create_payload()
    create["timezone"] = "   "
    with pytest.raises(ValidationError, match="context value"):
        CreateRunRequest.model_validate(create)

    with pytest.raises(ValidationError, match="clarification answer"):
        ClarificationAnswerRequest(
            schema_version="1.0",
            clarification_id="clarification-1",
            kind=ClarificationAnswerKind.FREE_TEXT,
            answer="   ",
        )


def test_approval_and_export_reject_duplicate_or_unsafe_actions() -> None:
    approved = ApprovalDecisionInput(
        action_id="action-1",
        decision=ActionDecision.APPROVE,
        reviewed=None,
    )

    with pytest.raises(ValidationError, match="distinct action IDs"):
        ApprovalRequest(
            schema_version="1.0",
            decisions=(approved, approved),
        )

    with pytest.raises(ValidationError, match="rejected action"):
        ApprovalDecisionInput.model_validate(
            {
                "action_id": "action-1",
                "decision": ActionDecision.REJECT,
                "reviewed": {
                    "title": "Edited title",
                    "owner": None,
                    "due_date": None,
                    "priority": "unknown",
                },
            },
        )

    with pytest.raises(ValidationError, match="formats must be distinct"):
        ExportRequest(
            schema_version="1.0",
            formats=(ExportFormat.ICS, ExportFormat.ICS),
            approved_action_ids=("action-1",),
        )

    with pytest.raises(ValidationError, match="action IDs must be distinct"):
        ExportRequest(
            schema_version="1.0",
            formats=(ExportFormat.MARKDOWN,),
            approved_action_ids=("action-1", "action-1"),
        )


def test_run_snapshot_requires_aware_ordered_timestamps() -> None:
    view = run_view()
    assert view.expires_at - view.created_at == timedelta(hours=24)

    with pytest.raises(ValidationError, match="later than"):
        RunView.model_validate(
            {
                **view.model_dump(),
                "expires_at": view.created_at,
            }
        )

    with pytest.raises(ValidationError):
        SafeTraceEvent(
            sequence=0,
            node="extract",
            outcome=TraceOutcome.STARTED,
            occurred_at=datetime(2026, 7, 29, 10),
            schema_version="1.0",
        )


def test_response_delete_and_error_envelopes_are_versioned_and_strict() -> None:
    response = RunResponse(schema_version="1.0", run=run_view())
    deleted = DeleteRunResponse(
        schema_version="1.0",
        run_id=response.run.run_id,
        deleted=True,
        deleted_at=datetime(2026, 7, 29, 11, tzinfo=UTC),
    )
    error = ErrorEnvelope(
        schema_version="1.0",
        error=PublicError(
            code=PublicErrorCode.RUN_NOT_FOUND,
            message="The requested run was not found.",
            request_id="request-1",
            retryable=False,
        ),
    )

    assert deleted.deleted is True
    assert error.error.code is PublicErrorCode.RUN_NOT_FOUND

    with pytest.raises(ValidationError, match="Extra inputs are not permitted"):
        ErrorEnvelope.model_validate(
            {
                **error.model_dump(mode="json"),
                "provider_error": "must never cross the boundary",
            }
        )


def test_safe_trace_schema_has_no_sensitive_payload_fields() -> None:
    schema_text = str(SafeTraceEvent.model_json_schema()).lower()

    assert "source_text" not in schema_text
    assert "raw_response" not in schema_text
    assert "api_key" not in schema_text
    assert "prompt" in schema_text  # prompt_version is safe metadata
