"""Versioned public contract for the durable SnapFlow run workflow."""

from datetime import date
from enum import StrEnum
from typing import Annotated, Literal, Self

from pydantic import (
    AwareDatetime,
    BaseModel,
    ConfigDict,
    Field,
    StringConstraints,
    field_validator,
    model_validator,
)

from snapflow.domain.action_plan import MAX_SOURCE_CHARS

SchemaVersion = Literal["1.0"]
RunId = Annotated[
    str,
    StringConstraints(
        min_length=8,
        max_length=100,
        pattern=r"^run_[A-Za-z0-9_-]+$",
    ),
]
EntityId = Annotated[str, StringConstraints(min_length=1, max_length=100)]


class RunContractModel(BaseModel):
    """Reject unknown fields at every public workflow boundary."""

    model_config = ConfigDict(extra="forbid", frozen=True)


class RunStatus(StrEnum):
    """Externally visible states in the finite run lifecycle."""

    RECEIVED = "received"
    INPUT_VALIDATED = "input_validated"
    EXTRACTING = "extracting"
    SCHEMA_VALIDATED = "schema_validated"
    EVIDENCE_CHECKED = "evidence_checked"
    INTERRUPTED_FOR_CLARIFICATION = "interrupted_for_clarification"
    CLARIFICATION_RECEIVED = "clarification_received"
    INTERRUPTED_FOR_APPROVAL = "interrupted_for_approval"
    APPROVAL_RECEIVED = "approval_received"
    EXPORTING = "exporting"
    COMPLETED = "completed"
    RETRYABLE_FAILURE = "retryable_failure"
    RETRYING = "retrying"
    FATAL_FAILURE = "fatal_failure"
    EXPIRED = "expired"
    DELETED = "deleted"


class ActionPriority(StrEnum):
    """Allowed action priority values shared with the generated Web client."""

    LOW = "low"
    MEDIUM = "medium"
    HIGH = "high"
    UNKNOWN = "unknown"


class ActionDecision(StrEnum):
    """Explicit human decisions accepted by the approval boundary."""

    APPROVE = "approve"
    REJECT = "reject"


class ClarificationAnswerKind(StrEnum):
    """How a clarification answer is supplied by the user."""

    OPTION = "option"
    FREE_TEXT = "free_text"


class ExportFormat(StrEnum):
    """Allowlisted export formats."""

    ICS = "ics"
    MARKDOWN = "markdown"


class TraceOutcome(StrEnum):
    """Safe outcome values for a redacted workflow event."""

    STARTED = "started"
    SUCCEEDED = "succeeded"
    INTERRUPTED = "interrupted"
    RETRYING = "retrying"
    FAILED = "failed"


class PublicErrorCode(StrEnum):
    """Stable error codes that never expose provider or stack details."""

    INVALID_REQUEST = "invalid_request"
    UNAUTHORIZED = "unauthorized"
    RUN_NOT_FOUND = "run_not_found"
    RUN_CONFLICT = "run_conflict"
    RUN_EXPIRED = "run_expired"
    RATE_LIMITED = "rate_limited"
    PROVIDER_UNAVAILABLE = "provider_unavailable"
    INTERNAL_ERROR = "internal_error"
    NOT_IMPLEMENTED = "not_implemented"


class Evidence(RunContractModel):
    """One exact source-text range supporting an extracted item."""

    quote: str = Field(min_length=1, max_length=2_000)
    start: int = Field(ge=0)
    end: int = Field(gt=0)

    @model_validator(mode="after")
    def end_must_follow_start(self) -> Self:
        """Reject empty or reversed source ranges."""
        if self.end <= self.start:
            message = "evidence end must be greater than start"
            raise ValueError(message)
        return self


class ActionItem(RunContractModel):
    """A typed, evidence-linked action that still requires human approval."""

    id: EntityId
    title: str = Field(min_length=1, max_length=240)
    owner: str | None = Field(max_length=120)
    due_date: date | None
    due_text: str | None = Field(max_length=240)
    priority: ActionPriority
    evidence: tuple[Evidence, ...] = Field(min_length=1)


class ClarificationQuestion(RunContractModel):
    """A bounded question raised by the workflow for one unresolved field."""

    id: EntityId
    field_path: str = Field(min_length=1, max_length=240)
    question: str = Field(min_length=1, max_length=300)
    reason: str = Field(min_length=1, max_length=500)
    answer_kind: ClarificationAnswerKind
    options: tuple[str, ...] = Field(default=(), max_length=20)
    evidence: Evidence | None

    @field_validator("options")
    @classmethod
    def options_must_be_distinct_and_non_blank(
        cls,
        values: tuple[str, ...],
    ) -> tuple[str, ...]:
        """Keep option answers deterministic and safe to render."""
        normalized = tuple(value.strip() for value in values)
        if any(not value for value in normalized):
            message = "clarification options must contain non-whitespace text"
            raise ValueError(message)
        if len(set(normalized)) != len(normalized):
            message = "clarification options must be distinct"
            raise ValueError(message)
        return normalized

    @model_validator(mode="after")
    def option_questions_must_offer_choices(self) -> Self:
        """Do not publish an option question without any options."""
        if self.answer_kind is ClarificationAnswerKind.OPTION and not self.options:
            message = "option clarification must include at least one option"
            raise ValueError(message)
        if self.answer_kind is ClarificationAnswerKind.FREE_TEXT and self.options:
            message = "free-text clarification cannot include options"
            raise ValueError(message)
        return self


class SafeTraceEvent(RunContractModel):
    """Redacted workflow metadata that is safe for a public timeline."""

    sequence: int = Field(ge=0)
    node: str = Field(min_length=1, max_length=100)
    outcome: TraceOutcome
    occurred_at: AwareDatetime
    duration_ms: int | None = Field(default=None, ge=0)
    provider: str | None = Field(default=None, max_length=100)
    model_alias: str | None = Field(default=None, max_length=100)
    prompt_version: str | None = Field(default=None, max_length=100)
    schema_version: SchemaVersion
    retry_count: int = Field(default=0, ge=0, le=2)
    input_tokens: int | None = Field(default=None, ge=0)
    output_tokens: int | None = Field(default=None, ge=0)
    tool_name: ExportFormat | None = None
    tool_succeeded: bool | None = None


class RunView(RunContractModel):
    """A privacy-aware snapshot returned when a run is created or resumed."""

    schema_version: SchemaVersion
    run_id: RunId
    status: RunStatus
    candidate_items: tuple[ActionItem, ...]
    clarification_questions: tuple[ClarificationQuestion, ...]
    clarification_count: int = Field(ge=0, le=2)
    safe_trace: tuple[SafeTraceEvent, ...]
    created_at: AwareDatetime
    expires_at: AwareDatetime

    @model_validator(mode="after")
    def expiry_must_follow_creation(self) -> Self:
        """Reject snapshots with an impossible retention window."""
        if self.expires_at <= self.created_at:
            message = "expires_at must be later than created_at"
            raise ValueError(message)
        return self


class CreateRunRequest(RunContractModel):
    """User-confirmed text and deterministic interpretation context."""

    schema_version: SchemaVersion
    source_text: str = Field(max_length=MAX_SOURCE_CHARS)
    locale: str = Field(min_length=1, max_length=64)
    timezone: str = Field(min_length=1, max_length=128)
    reference_date: date

    @field_validator("source_text")
    @classmethod
    def source_text_must_contain_content(cls, value: str) -> str:
        """Reject blank input without changing evidence-sensitive offsets."""
        if not value.strip():
            message = "source_text must contain non-whitespace text"
            raise ValueError(message)
        return value

    @field_validator("locale", "timezone")
    @classmethod
    def context_must_contain_content(cls, value: str) -> str:
        """Normalize harmless whitespace on short context fields."""
        normalized = value.strip()
        if not normalized:
            message = "context value must contain non-whitespace text"
            raise ValueError(message)
        return normalized


class RunResponse(RunContractModel):
    """Versioned envelope shared by create, resume, clarify, and approve."""

    schema_version: SchemaVersion
    run: RunView


class ResumeRunRequest(RunContractModel):
    """Resume from the latest checkpoint after a refresh or interruption."""

    schema_version: SchemaVersion
    last_seen_trace_sequence: int | None = Field(default=None, ge=0)


class ClarificationAnswerRequest(RunContractModel):
    """One answer for the currently pending clarification interrupt."""

    schema_version: SchemaVersion
    clarification_id: EntityId
    kind: ClarificationAnswerKind
    answer: str = Field(min_length=1, max_length=1_000)

    @field_validator("answer")
    @classmethod
    def answer_must_contain_content(cls, value: str) -> str:
        """Reject answers that contain only whitespace."""
        normalized = value.strip()
        if not normalized:
            message = "clarification answer must contain non-whitespace text"
            raise ValueError(message)
        return normalized


class ReviewedActionFields(RunContractModel):
    """Editable action fields accepted at the server approval boundary."""

    title: str = Field(min_length=1, max_length=240)
    owner: str | None = Field(max_length=120)
    due_date: date | None
    priority: ActionPriority


class ApprovalDecisionInput(RunContractModel):
    """One explicit approval or rejection, with optional reviewed fields."""

    action_id: EntityId
    decision: ActionDecision
    reviewed: ReviewedActionFields | None

    @model_validator(mode="after")
    def rejected_items_cannot_include_edits(self) -> Self:
        """Keep edits tied to items the user explicitly approves."""
        if self.decision is ActionDecision.REJECT and self.reviewed is not None:
            message = "rejected action cannot include reviewed fields"
            raise ValueError(message)
        return self


class ApprovalRequest(RunContractModel):
    """A complete set of per-item decisions for one approval interrupt."""

    schema_version: SchemaVersion
    decisions: tuple[ApprovalDecisionInput, ...] = Field(min_length=1)

    @field_validator("decisions")
    @classmethod
    def decisions_must_target_distinct_actions(
        cls,
        decisions: tuple[ApprovalDecisionInput, ...],
    ) -> tuple[ApprovalDecisionInput, ...]:
        """Reject contradictory duplicate decisions for one action."""
        action_ids = [decision.action_id for decision in decisions]
        if len(set(action_ids)) != len(action_ids):
            message = "approval decisions must target distinct action IDs"
            raise ValueError(message)
        return decisions


class ExportRequest(RunContractModel):
    """Request deterministic exports for already approved action IDs."""

    schema_version: SchemaVersion
    formats: tuple[ExportFormat, ...] = Field(min_length=1, max_length=2)
    approved_action_ids: tuple[EntityId, ...] = Field(min_length=1)

    @field_validator("formats")
    @classmethod
    def formats_must_be_distinct(
        cls,
        formats: tuple[ExportFormat, ...],
    ) -> tuple[ExportFormat, ...]:
        """Prevent duplicate tool invocations in one export request."""
        if len(set(formats)) != len(formats):
            message = "export formats must be distinct"
            raise ValueError(message)
        return formats

    @field_validator("approved_action_ids")
    @classmethod
    def action_ids_must_be_distinct(
        cls, action_ids: tuple[str, ...]
    ) -> tuple[str, ...]:
        """Prevent duplicate action side effects in one request."""
        if len(set(action_ids)) != len(action_ids):
            message = "approved action IDs must be distinct"
            raise ValueError(message)
        return action_ids


class ExportArtifact(RunContractModel):
    """One in-memory download returned by an allowlisted export tool."""

    format: ExportFormat
    filename: str = Field(min_length=1, max_length=240)
    content_type: str = Field(min_length=1, max_length=100)
    content: str
    exported_action_ids: tuple[EntityId, ...]
    warnings: tuple[str, ...]


class ExportResponse(RunContractModel):
    """Versioned collection of deterministic export artifacts."""

    schema_version: SchemaVersion
    run_id: RunId
    artifacts: tuple[ExportArtifact, ...]


class DeleteRunResponse(RunContractModel):
    """Confirmation that online run state is no longer available."""

    schema_version: SchemaVersion
    run_id: RunId
    deleted: Literal[True]
    deleted_at: AwareDatetime


class ErrorDetail(RunContractModel):
    """Safe field-level information for an invalid public request."""

    field: str = Field(min_length=1, max_length=240)
    code: str = Field(min_length=1, max_length=100)
    message: str = Field(min_length=1, max_length=300)


class PublicError(RunContractModel):
    """Stable public error without raw provider or stack data."""

    code: PublicErrorCode
    message: str = Field(min_length=1, max_length=300)
    request_id: str | None = Field(default=None, max_length=100)
    retryable: bool
    details: tuple[ErrorDetail, ...] = ()


class ErrorEnvelope(RunContractModel):
    """Versioned error response shared by all future run operations."""

    schema_version: SchemaVersion
    error: PublicError
