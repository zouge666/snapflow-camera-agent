"""Strict typed contract for the deterministic demo action plan."""

from datetime import date
from typing import Literal, Self

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

from snapflow.domain.time_context import validate_timezone_name

MAX_SOURCE_CHARS = 12_000
MAX_EVIDENCE_QUOTE_CHARS = 2_000
MAX_OWNER_CHARS = 120
MAX_DUE_TEXT_CHARS = 240


class ActionPlanRequest(BaseModel):
    """User-confirmed text and the context required to interpret it."""

    model_config = ConfigDict(extra="forbid", frozen=True)

    source_text: str = Field(max_length=MAX_SOURCE_CHARS)
    locale: str = Field(min_length=1, max_length=64)
    timezone: str = Field(min_length=1, max_length=128)
    reference_date: date

    @field_validator("source_text")
    @classmethod
    def source_text_must_contain_content(cls, value: str) -> str:
        """Reject empty input without changing evidence-sensitive offsets."""
        if not value.strip():
            message = "source_text must contain non-whitespace text"
            raise ValueError(message)
        return value

    @field_validator("locale")
    @classmethod
    def context_value_must_contain_content(cls, value: str) -> str:
        """Normalize harmless outer whitespace on short context values."""
        normalized = value.strip()
        if not normalized:
            message = "context value must contain non-whitespace text"
            raise ValueError(message)
        return normalized

    @field_validator("timezone")
    @classmethod
    def timezone_must_be_available(cls, value: str) -> str:
        """Require explicit IANA context instead of a server timezone default."""
        if not value.strip():
            message = "context value must contain non-whitespace text"
            raise ValueError(message)
        return validate_timezone_name(value)


class EvidenceRange(BaseModel):
    """Character offsets into the exact source text sent by the user."""

    model_config = ConfigDict(extra="forbid", frozen=True)

    quote: str = Field(min_length=1, max_length=MAX_EVIDENCE_QUOTE_CHARS)
    start: int = Field(ge=0)
    end: int = Field(gt=0)

    @field_validator("quote")
    @classmethod
    def quote_must_contain_content(cls, value: str) -> str:
        if not value.strip():
            message = "evidence quote must contain non-whitespace text"
            raise ValueError(message)
        return value

    @model_validator(mode="after")
    def end_must_follow_start(self) -> Self:
        """Reject empty or reversed character ranges."""
        if self.end <= self.start:
            message = "evidence end must be greater than start"
            raise ValueError(message)
        return self


class CandidateDue(BaseModel):
    """A typed due-date interpretation preserved with its source wording."""

    model_config = ConfigDict(extra="forbid", frozen=True)

    iso_date: date | None
    raw_text: str = Field(min_length=1, max_length=MAX_DUE_TEXT_CHARS)
    resolution: Literal["absolute", "relative", "ambiguous"]

    @field_validator("raw_text")
    @classmethod
    def raw_text_must_contain_content(cls, value: str) -> str:
        if not value.strip():
            message = "due raw text must contain non-whitespace text"
            raise ValueError(message)
        return value


class CandidateAction(BaseModel):
    """One candidate action returned for human review."""

    model_config = ConfigDict(extra="forbid", frozen=True)

    id: str = Field(pattern=r"^action-[1-9][0-9]*$")
    title: str = Field(min_length=1, max_length=240)
    owner: str | None = Field(max_length=MAX_OWNER_CHARS)
    due: CandidateDue | None
    priority: Literal["low", "medium", "high", "unknown"]
    evidence: tuple[EvidenceRange, ...] = Field(min_length=1)

    @field_validator("title")
    @classmethod
    def title_must_contain_content(cls, value: str) -> str:
        if not value.strip():
            message = "action title must contain non-whitespace text"
            raise ValueError(message)
        return value

    @field_validator("owner")
    @classmethod
    def owner_must_contain_content(cls, value: str | None) -> str | None:
        if value is not None and not value.strip():
            message = "action owner must contain non-whitespace text"
            raise ValueError(message)
        return value


class Clarification(BaseModel):
    """A focused question for one unresolved candidate field."""

    model_config = ConfigDict(extra="forbid", frozen=True)

    id: str = Field(pattern=r"^clarification-[1-9][0-9]*$")
    field_path: str = Field(min_length=1, max_length=240)
    question: str = Field(min_length=1, max_length=300)
    reason: str = Field(min_length=1, max_length=500)
    answer_kind: Literal["option", "free_text"] = "free_text"
    options: tuple[str, ...] = Field(default=(), max_length=20)
    evidence: EvidenceRange | None

    @field_validator("field_path", "question", "reason")
    @classmethod
    def text_must_contain_content(cls, value: str) -> str:
        if not value.strip():
            message = "clarification text must contain non-whitespace text"
            raise ValueError(message)
        return value

    @field_validator("options")
    @classmethod
    def options_must_be_distinct_and_non_blank(
        cls,
        values: tuple[str, ...],
    ) -> tuple[str, ...]:
        normalized = tuple(value.strip() for value in values)
        if any(not value for value in normalized):
            message = "clarification options must contain non-whitespace text"
            raise ValueError(message)
        if len(set(normalized)) != len(normalized):
            message = "clarification options must be distinct"
            raise ValueError(message)
        return normalized

    @model_validator(mode="after")
    def answer_kind_must_match_options(self) -> Self:
        if self.answer_kind == "option" and len(self.options) < 2:
            message = "option clarification must include at least two choices"
            raise ValueError(message)
        if self.answer_kind == "free_text" and self.options:
            message = "free-text clarification cannot include options"
            raise ValueError(message)
        return self


class ActionPlanResponse(BaseModel):
    """Versioned, provider-labelled response for the mock demo."""

    model_config = ConfigDict(extra="forbid", frozen=True)

    schema_version: Literal["1.0"]
    provider: Literal["mock"]
    summary: str = Field(min_length=1, max_length=300)
    candidate_actions: tuple[CandidateAction, ...]
    clarifications: tuple[Clarification, ...]

    @field_validator("summary")
    @classmethod
    def summary_must_contain_content(cls, value: str) -> str:
        if not value.strip():
            message = "summary must contain non-whitespace text"
            raise ValueError(message)
        return value

    @model_validator(mode="after")
    def entity_ids_must_be_unique(self) -> Self:
        action_ids = [action.id for action in self.candidate_actions]
        if len(action_ids) != len(set(action_ids)):
            message = "candidate action ids must be unique"
            raise ValueError(message)
        clarification_ids = [item.id for item in self.clarifications]
        if len(clarification_ids) != len(set(clarification_ids)):
            message = "clarification ids must be unique"
            raise ValueError(message)
        return self
