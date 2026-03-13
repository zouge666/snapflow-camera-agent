"""Single-purpose nodes and deterministic routing for action extraction."""

from dataclasses import dataclass
from typing import Literal

from pydantic import ValidationError

from snapflow.application.build_plan import BuildActionPlan
from snapflow.domain.action_plan import ActionPlanRequest, ActionPlanResponse
from snapflow.domain.dates import DateNormalizer, DateValidationError
from snapflow.domain.evidence import EvidenceValidationError, EvidenceValidator
from snapflow.providers.base import ProviderError, ProviderInvalidOutputError
from snapflow.workflow.state import (
    ActionExtractionState,
    ActionExtractionStateUpdate,
    IllegalWorkflowTransitionError,
    SafeWorkflowEvent,
    WorkflowEventOutcome,
    WorkflowFailure,
    WorkflowLimits,
    WorkflowNode,
    WorkflowStatus,
)

AfterInputRoute = Literal["extract_actions", "fail"]
AfterExtractionRoute = Literal["validate_schema", "retry_provider", "fail"]
AfterSchemaRoute = Literal["validate_evidence", "fail"]
AfterEvidenceRoute = Literal["normalize_dates", "fail"]
AfterDatesRoute = Literal[
    "needs_clarification",
    "ready_for_approval",
    "clarification_limit",
    "fail",
]


@dataclass(frozen=True, slots=True)
class ActionExtractionNodes:
    """Node set bound to one validated planner and finite limits."""

    planner: BuildActionPlan
    limits: WorkflowLimits
    evidence_validator: EvidenceValidator
    date_normalizer: DateNormalizer

    def validate_input(
        self,
        state: ActionExtractionState,
    ) -> ActionExtractionStateUpdate:
        """Revalidate the typed request and enter the extraction lifecycle."""
        self._require_status(
            state,
            WorkflowNode.VALIDATE_INPUT,
            WorkflowStatus.RECEIVED,
        )
        try:
            self.date_normalizer.validate_context(state["request"])
        except DateValidationError as error:
            failure = WorkflowFailure.from_date_error(error)
            return {
                "status": WorkflowStatus.FATAL_FAILURE,
                "failure": failure,
                "safe_trace": self._trace(
                    WorkflowNode.VALIDATE_INPUT,
                    WorkflowEventOutcome.FAILED,
                    WorkflowStatus.FATAL_FAILURE,
                    state["retry_count"],
                    failure=failure,
                ),
            }
        request = ActionPlanRequest.model_validate(
            state["request"].model_dump(mode="python")
        )
        return {
            "request": request,
            "status": WorkflowStatus.INPUT_VALIDATED,
            "safe_trace": self._trace(
                WorkflowNode.VALIDATE_INPUT,
                WorkflowEventOutcome.SUCCEEDED,
                WorkflowStatus.INPUT_VALIDATED,
                state["retry_count"],
            ),
        }

    def route_after_input(self, state: ActionExtractionState) -> AfterInputRoute:
        """Reject an invalid date context before any provider call is made."""
        if state["status"] is WorkflowStatus.INPUT_VALIDATED:
            return WorkflowNode.EXTRACT_ACTIONS.value
        if state["status"] is WorkflowStatus.FATAL_FAILURE:
            return WorkflowNode.FAIL.value
        raise IllegalWorkflowTransitionError(
            WorkflowNode.VALIDATE_INPUT,
            state["status"],
        )

    def extract_actions(
        self,
        state: ActionExtractionState,
    ) -> ActionExtractionStateUpdate:
        """Call the provider through the typed validation boundary once."""
        self._require_status(
            state,
            WorkflowNode.EXTRACT_ACTIONS,
            WorkflowStatus.INPUT_VALIDATED,
            WorkflowStatus.RETRYING,
        )
        try:
            plan = self.planner.execute(state["request"])
        except ProviderError as error:
            failure = WorkflowFailure.from_provider_error(error)
            status = (
                WorkflowStatus.RETRYABLE_FAILURE
                if failure.retryable
                else WorkflowStatus.FATAL_FAILURE
            )
            return {
                "status": status,
                "candidate_plan": None,
                "failure": failure,
                "safe_trace": self._trace(
                    WorkflowNode.EXTRACT_ACTIONS,
                    WorkflowEventOutcome.FAILED,
                    status,
                    state["retry_count"],
                    failure=failure,
                ),
            }

        return {
            "status": WorkflowStatus.EXTRACTING,
            "candidate_plan": plan,
            "failure": None,
            "safe_trace": self._trace(
                WorkflowNode.EXTRACT_ACTIONS,
                WorkflowEventOutcome.SUCCEEDED,
                WorkflowStatus.EXTRACTING,
                state["retry_count"],
                provider=plan.provider,
            ),
        }

    def route_after_extraction(
        self,
        state: ActionExtractionState,
    ) -> AfterExtractionRoute:
        """Choose schema validation, a bounded retry, or terminal failure."""
        status = state["status"]
        if status is WorkflowStatus.EXTRACTING:
            return WorkflowNode.VALIDATE_SCHEMA.value
        if status is WorkflowStatus.RETRYABLE_FAILURE:
            if state["retry_count"] < self.limits.max_provider_retries:
                return WorkflowNode.RETRY_PROVIDER.value
            return WorkflowNode.FAIL.value
        if status is WorkflowStatus.FATAL_FAILURE:
            return WorkflowNode.FAIL.value
        raise IllegalWorkflowTransitionError(WorkflowNode.EXTRACT_ACTIONS, status)

    def retry_provider(
        self,
        state: ActionExtractionState,
    ) -> ActionExtractionStateUpdate:
        """Consume one retry without calling the provider or sleeping."""
        self._require_status(
            state,
            WorkflowNode.RETRY_PROVIDER,
            WorkflowStatus.RETRYABLE_FAILURE,
        )
        if state["retry_count"] >= self.limits.max_provider_retries:
            raise IllegalWorkflowTransitionError(
                WorkflowNode.RETRY_PROVIDER,
                state["status"],
            )
        retry_count = state["retry_count"] + 1
        return {
            "status": WorkflowStatus.RETRYING,
            "failure": None,
            "retry_count": retry_count,
            "safe_trace": self._trace(
                WorkflowNode.RETRY_PROVIDER,
                WorkflowEventOutcome.RETRYING,
                WorkflowStatus.RETRYING,
                retry_count,
            ),
        }

    def validate_schema(
        self,
        state: ActionExtractionState,
    ) -> ActionExtractionStateUpdate:
        """Revalidate the candidate before any terminal result is published."""
        self._require_status(
            state,
            WorkflowNode.VALIDATE_SCHEMA,
            WorkflowStatus.EXTRACTING,
        )
        plan = state["candidate_plan"]
        if plan is None:
            raise IllegalWorkflowTransitionError(
                WorkflowNode.VALIDATE_SCHEMA,
                state["status"],
            )
        try:
            validated_plan = ActionPlanResponse.model_validate(
                plan.model_dump(mode="python")
            )
        except ValidationError:
            failure = WorkflowFailure.from_provider_error(ProviderInvalidOutputError())
            return {
                "status": WorkflowStatus.FATAL_FAILURE,
                "candidate_plan": None,
                "failure": failure,
                "safe_trace": self._trace(
                    WorkflowNode.VALIDATE_SCHEMA,
                    WorkflowEventOutcome.FAILED,
                    WorkflowStatus.FATAL_FAILURE,
                    state["retry_count"],
                    failure=failure,
                ),
            }
        return {
            "status": WorkflowStatus.SCHEMA_VALIDATED,
            "candidate_plan": validated_plan,
            "safe_trace": self._trace(
                WorkflowNode.VALIDATE_SCHEMA,
                WorkflowEventOutcome.SUCCEEDED,
                WorkflowStatus.SCHEMA_VALIDATED,
                state["retry_count"],
                provider=validated_plan.provider,
            ),
        }

    def route_after_schema(self, state: ActionExtractionState) -> AfterSchemaRoute:
        """Continue only when provider output passed runtime schema validation."""
        if state["status"] is WorkflowStatus.SCHEMA_VALIDATED:
            return WorkflowNode.VALIDATE_EVIDENCE.value
        if state["status"] is WorkflowStatus.FATAL_FAILURE:
            return WorkflowNode.FAIL.value
        raise IllegalWorkflowTransitionError(
            WorkflowNode.VALIDATE_SCHEMA,
            state["status"],
        )

    def validate_evidence(
        self,
        state: ActionExtractionState,
    ) -> ActionExtractionStateUpdate:
        """Validate every source range using browser-compatible UTF-16 offsets."""
        self._require_status(
            state,
            WorkflowNode.VALIDATE_EVIDENCE,
            WorkflowStatus.SCHEMA_VALIDATED,
        )
        plan = state["candidate_plan"]
        if plan is None:
            raise IllegalWorkflowTransitionError(
                WorkflowNode.VALIDATE_EVIDENCE,
                state["status"],
            )
        try:
            validated_plan = self.evidence_validator.validate_plan(
                state["request"].source_text,
                plan,
            )
        except EvidenceValidationError as error:
            failure = WorkflowFailure.from_evidence_error(error)
            return {
                "status": WorkflowStatus.FATAL_FAILURE,
                "candidate_plan": None,
                "failure": failure,
                "safe_trace": self._trace(
                    WorkflowNode.VALIDATE_EVIDENCE,
                    WorkflowEventOutcome.FAILED,
                    WorkflowStatus.FATAL_FAILURE,
                    state["retry_count"],
                    failure=failure,
                ),
            }
        return {
            "status": WorkflowStatus.EVIDENCE_CHECKED,
            "candidate_plan": validated_plan,
            "safe_trace": self._trace(
                WorkflowNode.VALIDATE_EVIDENCE,
                WorkflowEventOutcome.SUCCEEDED,
                WorkflowStatus.EVIDENCE_CHECKED,
                state["retry_count"],
                provider=validated_plan.provider,
            ),
        }

    def route_after_evidence(self, state: ActionExtractionState) -> AfterEvidenceRoute:
        """Continue to dates only after all source ranges are exact."""
        if state["status"] is WorkflowStatus.EVIDENCE_CHECKED:
            return WorkflowNode.NORMALIZE_DATES.value
        if state["status"] is WorkflowStatus.FATAL_FAILURE:
            return WorkflowNode.FAIL.value
        raise IllegalWorkflowTransitionError(
            WorkflowNode.VALIDATE_EVIDENCE,
            state["status"],
        )

    def normalize_dates(
        self,
        state: ActionExtractionState,
    ) -> ActionExtractionStateUpdate:
        """Resolve evidence-backed dates from explicit locale/timezone context."""
        self._require_status(
            state,
            WorkflowNode.NORMALIZE_DATES,
            WorkflowStatus.EVIDENCE_CHECKED,
        )
        plan = state["candidate_plan"]
        if plan is None:
            raise IllegalWorkflowTransitionError(
                WorkflowNode.NORMALIZE_DATES,
                state["status"],
            )
        try:
            normalized_plan = self.date_normalizer.normalize_plan(
                state["request"],
                plan,
            )
        except DateValidationError as error:
            failure = WorkflowFailure.from_date_error(error)
            return {
                "status": WorkflowStatus.FATAL_FAILURE,
                "candidate_plan": None,
                "failure": failure,
                "safe_trace": self._trace(
                    WorkflowNode.NORMALIZE_DATES,
                    WorkflowEventOutcome.FAILED,
                    WorkflowStatus.FATAL_FAILURE,
                    state["retry_count"],
                    failure=failure,
                ),
            }
        return {
            "status": WorkflowStatus.DATES_NORMALIZED,
            "candidate_plan": normalized_plan,
            "safe_trace": self._trace(
                WorkflowNode.NORMALIZE_DATES,
                WorkflowEventOutcome.SUCCEEDED,
                WorkflowStatus.DATES_NORMALIZED,
                state["retry_count"],
                provider=normalized_plan.provider,
            ),
        }

    def route_after_dates(self, state: ActionExtractionState) -> AfterDatesRoute:
        """Deterministically separate clarification and approval-ready plans."""
        if state["status"] is WorkflowStatus.FATAL_FAILURE:
            return WorkflowNode.FAIL.value
        self._require_status(
            state,
            WorkflowNode.NORMALIZE_DATES,
            WorkflowStatus.DATES_NORMALIZED,
        )
        plan = state["candidate_plan"]
        if plan is None:
            raise IllegalWorkflowTransitionError(
                WorkflowNode.NORMALIZE_DATES,
                state["status"],
            )
        if plan.clarifications:
            if state["clarification_count"] >= self.limits.max_clarifications:
                return WorkflowNode.CLARIFICATION_LIMIT.value
            return WorkflowNode.NEEDS_CLARIFICATION.value
        return WorkflowNode.READY_FOR_APPROVAL.value

    def mark_needs_clarification(
        self,
        state: ActionExtractionState,
    ) -> ActionExtractionStateUpdate:
        """Stop at a typed pre-interrupt state for Task 34 to resume later."""
        self._require_status(
            state,
            WorkflowNode.NEEDS_CLARIFICATION,
            WorkflowStatus.DATES_NORMALIZED,
        )
        return {
            "status": WorkflowStatus.NEEDS_CLARIFICATION,
            "safe_trace": self._trace(
                WorkflowNode.NEEDS_CLARIFICATION,
                WorkflowEventOutcome.WAITING,
                WorkflowStatus.NEEDS_CLARIFICATION,
                state["retry_count"],
                provider=self._provider(state),
            ),
        }

    def mark_ready_for_approval(
        self,
        state: ActionExtractionState,
    ) -> ActionExtractionStateUpdate:
        """Stop with a validated plan that can enter future approval."""
        self._require_status(
            state,
            WorkflowNode.READY_FOR_APPROVAL,
            WorkflowStatus.DATES_NORMALIZED,
        )
        return {
            "status": WorkflowStatus.READY_FOR_APPROVAL,
            "safe_trace": self._trace(
                WorkflowNode.READY_FOR_APPROVAL,
                WorkflowEventOutcome.SUCCEEDED,
                WorkflowStatus.READY_FOR_APPROVAL,
                state["retry_count"],
                provider=self._provider(state),
            ),
        }

    def mark_clarification_limit(
        self,
        state: ActionExtractionState,
    ) -> ActionExtractionStateUpdate:
        """Fail closed instead of allowing an unbounded clarification loop."""
        self._require_status(
            state,
            WorkflowNode.CLARIFICATION_LIMIT,
            WorkflowStatus.DATES_NORMALIZED,
        )
        failure = WorkflowFailure.clarification_limit()
        return {
            "status": WorkflowStatus.FATAL_FAILURE,
            "failure": failure,
            "safe_trace": self._trace(
                WorkflowNode.CLARIFICATION_LIMIT,
                WorkflowEventOutcome.FAILED,
                WorkflowStatus.FATAL_FAILURE,
                state["retry_count"],
                provider=self._provider(state),
                failure=failure,
            ),
        }

    def mark_failure(
        self,
        state: ActionExtractionState,
    ) -> ActionExtractionStateUpdate:
        """Turn an invalid or retry-exhausted attempt into one safe terminal."""
        self._require_status(
            state,
            WorkflowNode.FAIL,
            WorkflowStatus.RETRYABLE_FAILURE,
            WorkflowStatus.FATAL_FAILURE,
        )
        failure = state["failure"]
        if failure is None:
            raise IllegalWorkflowTransitionError(WorkflowNode.FAIL, state["status"])
        if state["status"] is WorkflowStatus.RETRYABLE_FAILURE:
            failure = failure.after_retry_limit()
        return {
            "status": WorkflowStatus.FATAL_FAILURE,
            "failure": failure,
            "safe_trace": self._trace(
                WorkflowNode.FAIL,
                WorkflowEventOutcome.FAILED,
                WorkflowStatus.FATAL_FAILURE,
                state["retry_count"],
                failure=failure,
            ),
        }

    @staticmethod
    def _provider(state: ActionExtractionState) -> str | None:
        plan = state["candidate_plan"]
        return plan.provider if plan is not None else None

    @staticmethod
    def _require_status(
        state: ActionExtractionState,
        node: WorkflowNode,
        *allowed: WorkflowStatus,
    ) -> None:
        if state["status"] not in allowed:
            raise IllegalWorkflowTransitionError(node, state["status"])

    @staticmethod
    def _trace(
        node: WorkflowNode,
        outcome: WorkflowEventOutcome,
        status: WorkflowStatus,
        retry_count: int,
        *,
        provider: str | None = None,
        failure: WorkflowFailure | None = None,
    ) -> tuple[SafeWorkflowEvent, ...]:
        return (
            SafeWorkflowEvent(
                node=node,
                outcome=outcome,
                status=status,
                provider=provider,
                retry_count=retry_count,
                failure_code=failure.code if failure is not None else None,
            ),
        )
