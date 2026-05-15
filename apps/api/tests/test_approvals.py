"""Unit tests for server-owned action approval and audit decisions."""

from datetime import date

import pytest

from snapflow.domain.action_plan import (
    ActionPlanResponse,
    CandidateAction,
    CandidateDue,
    EvidenceRange,
)
from snapflow.domain.approvals import ApprovalResolver, ApprovalValidationError
from snapflow.domain.run_contract import ApprovalRequest

pytestmark = pytest.mark.unit


def plan() -> ActionPlanResponse:
    return ActionPlanResponse(
        schema_version="1.0",
        provider="mock",
        summary="Two candidate actions.",
        candidate_actions=(
            CandidateAction(
                id="action-1",
                title="Prepare the release notes",
                owner="Alex",
                due=CandidateDue(
                    iso_date=date(2026, 1, 22),
                    raw_text="by Thursday",
                    resolution="relative",
                ),
                priority="unknown",
                evidence=(
                    EvidenceRange(
                        quote="Alex will prepare the release notes by Thursday.",
                        start=0,
                        end=48,
                    ),
                ),
            ),
            CandidateAction(
                id="action-2",
                title="Publish the checklist",
                owner=None,
                due=None,
                priority="low",
                evidence=(
                    EvidenceRange(
                        quote="Publish the checklist.",
                        start=49,
                        end=71,
                    ),
                ),
            ),
        ),
        clarifications=(),
    )


def approval(decisions: list[dict[str, object]]) -> ApprovalRequest:
    return ApprovalRequest.model_validate(
        {"schema_version": "1.0", "decisions": decisions}
    )


def test_partial_approval_revalidates_edits_and_locks_original_evidence() -> None:
    original = plan()
    result = ApprovalResolver().resolve(
        original,
        approval(
            [
                {
                    "action_id": "action-1",
                    "decision": "approve",
                    "reviewed": {
                        "title": "  Prepare final release notes  ",
                        "owner": "  Mina  ",
                        "due_date": "2026-01-23",
                        "priority": "high",
                    },
                },
                {
                    "action_id": "action-2",
                    "decision": "reject",
                    "reviewed": None,
                },
            ]
        ),
        "approve-run:partial",
    )

    assert [item.id for item in result.approved_items] == ["action-1"]
    approved = result.approved_items[0]
    assert approved.title == "Prepare final release notes"
    assert approved.owner == "Mina"
    assert approved.due_date == date(2026, 1, 23)
    assert approved.evidence == original.candidate_actions[0].evidence
    assert result.decisions[0].model_dump(mode="json")["audit_diff"] == [
        {
            "field": "title",
            "before": "Prepare the release notes",
            "after": "Prepare final release notes",
        },
        {"field": "owner", "before": "Alex", "after": "Mina"},
        {"field": "due_date", "before": "2026-01-22", "after": "2026-01-23"},
        {"field": "priority", "before": "unknown", "after": "high"},
    ]
    assert result.decisions[1].reviewed is None
    assert result.decisions[1].audit_diff == ()


def test_reject_all_produces_no_tool_boundary_items() -> None:
    result = ApprovalResolver().resolve(
        plan(),
        approval(
            [
                {"action_id": "action-1", "decision": "reject", "reviewed": None},
                {"action_id": "action-2", "decision": "reject", "reviewed": None},
            ]
        ),
        "approve-run:reject-all",
    )

    assert result.approved_items == ()
    assert [decision.decision.value for decision in result.decisions] == [
        "reject",
        "reject",
    ]


@pytest.mark.parametrize(
    "decisions",
    [
        [{"action_id": "action-1", "decision": "approve", "reviewed": None}],
        [
            {"action_id": "action-1", "decision": "approve", "reviewed": None},
            {"action_id": "action-99", "decision": "reject", "reviewed": None},
        ],
    ],
    ids=["missing", "unknown"],
)
def test_decisions_must_exactly_match_the_checkpoint_candidates(
    decisions: list[dict[str, object]],
) -> None:
    with pytest.raises(ApprovalValidationError, match="exactly match"):
        ApprovalResolver().resolve(
            plan(),
            approval(decisions),
            "approve-run:invalid-set",
        )


def test_an_empty_plan_accepts_an_explicit_empty_decision_set() -> None:
    empty = plan().model_copy(update={"candidate_actions": ()})

    result = ApprovalResolver().resolve(
        empty,
        approval([]),
        "approve-run:empty",
    )

    assert result.decisions == ()
    assert result.approved_items == ()
