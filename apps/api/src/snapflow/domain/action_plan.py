"""Strict typed contract for the deterministic demo action plan."""

from datetime import date
from typing import Literal, Self

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

MAX_SOURCE_CHARS = 12_000


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

    @field_validator("locale", "timezone")
    @classmethod
    def context_value_must_contain_content(cls, value: str) -> str:
        """Normalize harmless outer whitespace on short context values."""
        normalized = value.strip()
        if not normalized:
            message = "context value must contain non-whitespace text"
            raise ValueError(message)
        return normalized


class EvidenceRange(BaseModel):
    """Character offsets into the exact source text sent by the user."""

    model_config = ConfigDict(extra="forbid", frozen=True)

    quote: str = Field(min_length=1)
    start: int = Field(ge=0)
    end: int = Field(gt=0)

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
    raw_text: str = Field(min_length=1)
    resolution: Literal["absolute", "relative", "ambiguous"]


class CandidateAction(BaseModel):
    """One candidate action returned for human review."""

    model_config = ConfigDict(extra="forbid", frozen=True)

    id: str = Field(pattern=r"^action-[1-9][0-9]*$")
    title: str = Field(min_length=1, max_length=240)
    owner: str | None
    due: CandidateDue | None
    priority: Literal["low", "medium", "high", "unknown"]
    evidence: tuple[EvidenceRange, ...] = Field(min_length=1)


class Clarification(BaseModel):
    """A focused question for one unresolved candidate field."""

    model_config = ConfigDict(extra="forbid", frozen=True)

    id: str = Field(pattern=r"^clarification-[1-9][0-9]*$")
    field_path: str = Field(min_length=1)
    question: str = Field(min_length=1, max_length=300)
    reason: str = Field(min_length=1, max_length=500)
    evidence: EvidenceRange | None


class ActionPlanResponse(BaseModel):
    """Versioned, provider-labelled response for the mock demo."""

    model_config = ConfigDict(extra="forbid", frozen=True)

    schema_version: Literal["1.0"]
    provider: Literal["mock"]
    summary: str = Field(min_length=1, max_length=300)
    candidate_actions: tuple[CandidateAction, ...]
    clarifications: tuple[Clarification, ...]
