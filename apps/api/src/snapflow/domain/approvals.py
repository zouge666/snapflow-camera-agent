"""Server-side approval resolution for validated action candidates."""

from typing import Literal

from pydantic import BaseModel, ConfigDict, Field

from snapflow.domain.action_plan import ActionPlanResponse, CandidateAction
from snapflow.domain.ics_export import ApprovedActionItem
from snapflow.domain.run_contract import (
    ActionDecision,
    ActionPriority,
    ApprovalAuditChange,
    ApprovalDecisionView,
    ApprovalRequest,
    ReviewedActionFields,
)

ApprovalAuditField = Literal["title", "owner", "due_date", "priority"]


class ApprovalValidationError(ValueError):
    """An approval request does not match the current candidate snapshot."""


class ApprovalResult(BaseModel):
    """Checkpoint-safe decisions plus the only items allowed to reach tools."""

    model_config = ConfigDict(extra="forbid", frozen=True)

    idempotency_key: str = Field(
        min_length=8,
        max_length=128,
        pattern=r"^[A-Za-z0-9._:-]+$",
    )
    accepted_request: ApprovalRequest
    decisions: tuple[ApprovalDecisionView, ...]
    approved_items: tuple[ApprovedActionItem, ...]


class ApprovalCommand(BaseModel):
    """Internal command that binds one approval request to its retry key."""

    model_config = ConfigDict(extra="forbid", frozen=True)

    idempotency_key: str = Field(
        min_length=8,
        max_length=128,
        pattern=r"^[A-Za-z0-9._:-]+$",
    )
    request: ApprovalRequest


class ApprovalResolver:
    """Apply a complete decision set without trusting client-owned evidence."""

    def resolve(
        self,
        plan: ActionPlanResponse,
        request: ApprovalRequest,
        idempotency_key: str,
    ) -> ApprovalResult:
        candidates = {candidate.id: candidate for candidate in plan.candidate_actions}
        submitted = {decision.action_id for decision in request.decisions}
        if submitted != set(candidates):
            raise ApprovalValidationError(
                "approval decisions must exactly match the current candidate actions"
            )

        decision_by_id = {
            decision.action_id: decision for decision in request.decisions
        }
        decisions: list[ApprovalDecisionView] = []
        approved_items: list[ApprovedActionItem] = []
        for candidate in plan.candidate_actions:
            submitted_decision = decision_by_id[candidate.id]
            if submitted_decision.decision is ActionDecision.REJECT:
                decisions.append(
                    ApprovalDecisionView(
                        action_id=candidate.id,
                        decision=ActionDecision.REJECT,
                        reviewed=None,
                        audit_diff=(),
                    )
                )
                continue

            reviewed = submitted_decision.reviewed or self._original_fields(candidate)
            audit_diff = self._audit_diff(candidate, reviewed)
            decisions.append(
                ApprovalDecisionView(
                    action_id=candidate.id,
                    decision=ActionDecision.APPROVE,
                    reviewed=reviewed,
                    audit_diff=audit_diff,
                )
            )
            approved_items.append(
                ApprovedActionItem(
                    id=candidate.id,
                    title=reviewed.title,
                    owner=reviewed.owner,
                    due_date=reviewed.due_date,
                    priority=reviewed.priority.value,
                    evidence=candidate.evidence,
                    decision="approved",
                )
            )
        return ApprovalResult(
            idempotency_key=idempotency_key,
            accepted_request=request,
            decisions=tuple(decisions),
            approved_items=tuple(approved_items),
        )

    @staticmethod
    def _original_fields(candidate: CandidateAction) -> ReviewedActionFields:
        return ReviewedActionFields(
            title=candidate.title,
            owner=candidate.owner,
            due_date=candidate.due.iso_date if candidate.due is not None else None,
            priority=ActionPriority(candidate.priority),
        )

    @classmethod
    def _audit_diff(
        cls,
        candidate: CandidateAction,
        reviewed: ReviewedActionFields,
    ) -> tuple[ApprovalAuditChange, ...]:
        original = cls._original_fields(candidate)
        values: tuple[tuple[ApprovalAuditField, str | None, str | None], ...] = (
            ("title", original.title, reviewed.title),
            ("owner", original.owner, reviewed.owner),
            (
                "due_date",
                original.due_date.isoformat()
                if original.due_date is not None
                else None,
                reviewed.due_date.isoformat()
                if reviewed.due_date is not None
                else None,
            ),
            ("priority", original.priority.value, reviewed.priority.value),
        )
        return tuple(
            ApprovalAuditChange(field=field, before=before, after=after)
            for field, before, after in values
            if before != after
        )
