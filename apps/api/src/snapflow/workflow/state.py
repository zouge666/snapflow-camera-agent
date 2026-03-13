"""Typed state and safe outcomes for action extraction."""

from enum import StrEnum
from typing import Annotated, Self, TypedDict

from pydantic import BaseModel, ConfigDict, Field, model_validator

from snapflow.domain.action_plan import ActionPlanRequest, ActionPlanResponse
from snapflow.domain.dates import DateValidationError
from snapflow.domain.evidence import EvidenceValidationError
from snapflow.providers.base import (
    ProviderError,
    ProviderErrorKind,
    ProviderRateLimitError,
)

MAX_CLARIFICATION_ROUNDS = 2
MAX_PROVIDER_RETRIES = 2


class WorkflowNode(StrEnum):
    """Stable node names used by topology tests and safe traces."""

    VALIDATE_INPUT = "validate_input"
    EXTRACT_ACTIONS = "extract_actions"
    RETRY_PROVIDER = "retry_provider"
    VALIDATE_SCHEMA = "validate_schema"
    VALIDATE_EVIDENCE = "validate_evidence"
    NORMALIZE_DATES = "normalize_dates"
    NEEDS_CLARIFICATION = "needs_clarification"
    READY_FOR_APPROVAL = "ready_for_approval"
    CLARIFICATION_LIMIT = "clarification_limit"
    FAIL = "fail"


class WorkflowStatus(StrEnum):
    """Finite states implemented by the mock extraction graph."""

    RECEIVED = "received"
    INPUT_VALIDATED = "input_validated"
    EXTRACTING = "extracting"
    RETRYABLE_FAILURE = "retryable_failure"
    RETRYING = "retrying"
    SCHEMA_VALIDATED = "schema_validated"
    EVIDENCE_CHECKED = "evidence_checked"
    DATES_NORMALIZED = "dates_normalized"
    NEEDS_CLARIFICATION = "needs_clarification"
    READY_FOR_APPROVAL = "ready_for_approval"
    FATAL_FAILURE = "fatal_failure"


class WorkflowEventOutcome(StrEnum):
    """Non-sensitive outcomes recorded for each executed node."""

    SUCCEEDED = "succeeded"
    FAILED = "failed"
    RETRYING = "retrying"
    WAITING = "waiting"


class WorkflowFailureCode(StrEnum):
    """Safe failure codes that do not contain provider payloads."""

    PROVIDER_TIMEOUT = "provider_timeout"
    PROVIDER_RATE_LIMITED = "provider_rate_limited"
    PROVIDER_INVALID_OUTPUT = "provider_invalid_output"
    INVALID_EVIDENCE = "invalid_evidence"
    INVALID_DATE = "invalid_date"
    CLARIFICATION_LIMIT = "clarification_limit"


class WorkflowFailure(BaseModel):
    """Provider-independent failure information stored in graph state."""

    model_config = ConfigDict(extra="forbid", frozen=True)

    code: WorkflowFailureCode
    safe_message: str = Field(min_length=1, max_length=200)
    retryable: bool
    retry_after_seconds: int | None = Field(default=None, ge=0)

    @classmethod
    def from_provider_error(cls, error: ProviderError) -> Self:
        code_by_kind = {
            ProviderErrorKind.TIMEOUT: WorkflowFailureCode.PROVIDER_TIMEOUT,
            ProviderErrorKind.RATE_LIMITED: WorkflowFailureCode.PROVIDER_RATE_LIMITED,
            ProviderErrorKind.INVALID_OUTPUT: (
                WorkflowFailureCode.PROVIDER_INVALID_OUTPUT
            ),
        }
        retry_after_seconds = (
            error.retry_after_seconds
            if isinstance(error, ProviderRateLimitError)
            else None
        )
        return cls(
            code=code_by_kind[error.kind],
            safe_message=str(error),
            retryable=error.retryable,
            retry_after_seconds=retry_after_seconds,
        )

    @classmethod
    def clarification_limit(cls) -> Self:
        return cls(
            code=WorkflowFailureCode.CLARIFICATION_LIMIT,
            safe_message="The clarification round limit was reached.",
            retryable=False,
        )

    @classmethod
    def from_evidence_error(cls, error: EvidenceValidationError) -> Self:
        return cls(
            code=WorkflowFailureCode.INVALID_EVIDENCE,
            safe_message=str(error),
            retryable=False,
        )

    @classmethod
    def from_date_error(cls, error: DateValidationError) -> Self:
        return cls(
            code=WorkflowFailureCode.INVALID_DATE,
            safe_message=str(error),
            retryable=False,
        )

    def after_retry_limit(self) -> Self:
        return type(self)(
            code=self.code,
            safe_message="Action extraction stopped after the provider retry limit.",
            retryable=False,
            retry_after_seconds=self.retry_after_seconds,
        )


class SafeWorkflowEvent(BaseModel):
    """Small deterministic event that cannot carry source or prompt text."""

    model_config = ConfigDict(extra="forbid", frozen=True)

    node: WorkflowNode
    outcome: WorkflowEventOutcome
    status: WorkflowStatus
    provider: str | None = Field(default=None, min_length=1, max_length=100)
    retry_count: int = Field(ge=0, le=MAX_PROVIDER_RETRIES)
    failure_code: WorkflowFailureCode | None = None


class WorkflowLimits(BaseModel):
    """Hard upper bounds passed into the graph by the composition root."""

    model_config = ConfigDict(extra="forbid", frozen=True)

    max_clarifications: int = Field(
        default=MAX_CLARIFICATION_ROUNDS,
        ge=0,
        le=MAX_CLARIFICATION_ROUNDS,
    )
    max_provider_retries: int = Field(
        default=MAX_PROVIDER_RETRIES,
        ge=0,
        le=MAX_PROVIDER_RETRIES,
    )


def append_safe_trace(
    current: tuple[SafeWorkflowEvent, ...],
    update: tuple[SafeWorkflowEvent, ...],
) -> tuple[SafeWorkflowEvent, ...]:
    """Append node events without mutating an earlier graph snapshot."""
    return current + update


class ActionExtractionState(TypedDict):
    """Internal state shared by the extraction graph's nodes."""

    request: ActionPlanRequest
    status: WorkflowStatus
    candidate_plan: ActionPlanResponse | None
    failure: WorkflowFailure | None
    retry_count: int
    clarification_count: int
    safe_trace: Annotated[tuple[SafeWorkflowEvent, ...], append_safe_trace]


class ActionExtractionStateUpdate(TypedDict, total=False):
    """Partial update returned by one graph node."""

    request: ActionPlanRequest
    status: WorkflowStatus
    candidate_plan: ActionPlanResponse | None
    failure: WorkflowFailure | None
    retry_count: int
    clarification_count: int
    safe_trace: tuple[SafeWorkflowEvent, ...]


class ActionExtractionStateSnapshot(BaseModel):
    """Runtime validation applied after LangGraph returns its dictionary."""

    model_config = ConfigDict(extra="forbid", frozen=True)

    request: ActionPlanRequest
    status: WorkflowStatus
    candidate_plan: ActionPlanResponse | None
    failure: WorkflowFailure | None
    retry_count: int = Field(ge=0, le=MAX_PROVIDER_RETRIES)
    clarification_count: int = Field(ge=0, le=MAX_CLARIFICATION_ROUNDS)
    safe_trace: tuple[SafeWorkflowEvent, ...]

    @model_validator(mode="after")
    def terminal_data_must_match_status(self) -> Self:
        plan_statuses = {
            WorkflowStatus.EXTRACTING,
            WorkflowStatus.SCHEMA_VALIDATED,
            WorkflowStatus.EVIDENCE_CHECKED,
            WorkflowStatus.DATES_NORMALIZED,
            WorkflowStatus.NEEDS_CLARIFICATION,
            WorkflowStatus.READY_FOR_APPROVAL,
        }
        failure_statuses = {
            WorkflowStatus.RETRYABLE_FAILURE,
            WorkflowStatus.FATAL_FAILURE,
        }
        if self.status in plan_statuses and self.candidate_plan is None:
            message = "candidate plan is required for this workflow status"
            raise ValueError(message)
        if self.status in failure_statuses and self.failure is None:
            message = "failure is required for this workflow status"
            raise ValueError(message)
        if self.status not in failure_statuses and self.failure is not None:
            message = "failure is not allowed for this workflow status"
            raise ValueError(message)
        return self


class ActionExtractionRun(BaseModel):
    """Validated graph result returned to the application boundary."""

    model_config = ConfigDict(extra="forbid", frozen=True)

    status: WorkflowStatus
    plan: ActionPlanResponse
    retry_count: int = Field(ge=0, le=MAX_PROVIDER_RETRIES)
    clarification_count: int = Field(ge=0, le=MAX_CLARIFICATION_ROUNDS)
    safe_trace: tuple[SafeWorkflowEvent, ...]

    @model_validator(mode="after")
    def status_must_be_a_successful_terminal(self) -> Self:
        if self.status not in {
            WorkflowStatus.NEEDS_CLARIFICATION,
            WorkflowStatus.READY_FOR_APPROVAL,
        }:
            message = "action extraction run must be in a successful terminal state"
            raise ValueError(message)
        return self


class IllegalWorkflowTransitionError(RuntimeError):
    """A graph node was invoked from a state it does not accept."""

    def __init__(self, node: WorkflowNode, status: WorkflowStatus) -> None:
        self.node = node
        self.status = status
        super().__init__(f"Node '{node}' cannot run from status '{status}'.")


class ActionExtractionWorkflowError(RuntimeError):
    """Safe terminal workflow failure exposed to the application layer."""

    def __init__(self, failure: WorkflowFailure, retry_count: int) -> None:
        self.code = failure.code
        self.retryable = failure.retryable
        self.retry_after_seconds = failure.retry_after_seconds
        self.retry_count = retry_count
        super().__init__(failure.safe_message)


def initial_action_extraction_state(
    request: ActionPlanRequest,
) -> ActionExtractionState:
    """Create the only supported entry state for a new extraction run."""
    return ActionExtractionState(
        request=request,
        status=WorkflowStatus.RECEIVED,
        candidate_plan=None,
        failure=None,
        retry_count=0,
        clarification_count=0,
        safe_trace=(),
    )
