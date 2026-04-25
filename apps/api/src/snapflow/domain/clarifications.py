"""Deterministic rules for bounded, evidence-linked clarifications."""

from __future__ import annotations

import re
from dataclasses import dataclass
from enum import StrEnum
from typing import Literal, cast

from pydantic import BaseModel, ConfigDict, Field, ValidationError, field_validator

from snapflow.domain.action_plan import (
    ActionPlanRequest,
    ActionPlanResponse,
    CandidateAction,
    Clarification,
)
from snapflow.domain.dates import DateNormalizer, DateValidationError

_FIELD_PATH = re.compile(
    r"^candidate_actions\[(?P<index>0|[1-9][0-9]*)\]\.(?P<field>title|owner|due)$"
)


class ClarificationIssue(StrEnum):
    """Stable reasons a provider clarification can be rejected."""

    DUPLICATE_FIELD = "duplicate_field"
    INVALID_TARGET = "invalid_target"
    MISSING_EVIDENCE = "missing_evidence"
    EVIDENCE_MISMATCH = "evidence_mismatch"
    FIELD_NOT_AMBIGUOUS = "field_not_ambiguous"


class ClarificationValidationError(ValueError):
    """A provider question does not satisfy the bounded field matrix."""

    def __init__(self, issue: ClarificationIssue) -> None:
        self.issue = issue
        super().__init__("The action plan contains an invalid clarification.")


class StaleClarificationAnswerError(ValueError):
    """An answer does not target the currently interrupted question."""

    def __init__(self) -> None:
        super().__init__("The clarification answer is stale or already used.")


class InvalidClarificationAnswerError(ValueError):
    """An answer has the right identity but cannot resolve its field."""

    def __init__(self) -> None:
        super().__init__("The clarification answer is invalid.")


class ClarificationResolution(BaseModel):
    """Internal value supplied to LangGraph's resume command."""

    model_config = ConfigDict(extra="forbid", frozen=True)

    clarification_id: str = Field(pattern=r"^clarification-[1-9][0-9]*$")
    kind: Literal["option", "free_text"]
    answer: str = Field(min_length=1, max_length=1_000)

    @field_validator("answer")
    @classmethod
    def answer_must_contain_content(cls, value: str) -> str:
        normalized = value.strip()
        if not normalized:
            raise InvalidClarificationAnswerError
        return normalized


@dataclass(frozen=True, slots=True)
class ClarificationTarget:
    """One supported candidate field selected by a provider question."""

    action_index: int
    field: Literal["title", "owner", "due"]


class ClarificationResolver:
    """Validate questions and apply one answer without re-running the provider."""

    def __init__(self, date_normalizer: DateNormalizer) -> None:
        self._date_normalizer = date_normalizer

    def validate_plan(self, plan: ActionPlanResponse) -> ActionPlanResponse:
        seen_fields: set[str] = set()
        for question in plan.clarifications:
            if question.field_path in seen_fields:
                raise ClarificationValidationError(ClarificationIssue.DUPLICATE_FIELD)
            seen_fields.add(question.field_path)
            target = self._target(question, plan)
            action = plan.candidate_actions[target.action_index]
            self._require_evidence(question, action)
            if target.field == "due" and (
                action.due is None or action.due.resolution != "ambiguous"
            ):
                raise ClarificationValidationError(
                    ClarificationIssue.FIELD_NOT_AMBIGUOUS
                )
            if target.field == "owner" and not self._has_ambiguous_owner(question):
                raise ClarificationValidationError(
                    ClarificationIssue.FIELD_NOT_AMBIGUOUS
                )
        return plan

    def resolve(
        self,
        request: ActionPlanRequest,
        plan: ActionPlanResponse,
        resolution: ClarificationResolution,
    ) -> ActionPlanResponse:
        self.validate_plan(plan)
        if not plan.clarifications:
            raise StaleClarificationAnswerError
        question = plan.clarifications[0]
        if (
            resolution.clarification_id != question.id
            or resolution.kind != question.answer_kind
        ):
            raise StaleClarificationAnswerError
        if (
            question.answer_kind == "option"
            and resolution.answer not in question.options
        ):
            raise InvalidClarificationAnswerError

        target = self._target(question, plan)
        action = plan.candidate_actions[target.action_index]
        updated_action = self._apply_answer(request, action, target, resolution.answer)
        actions = list(plan.candidate_actions)
        actions[target.action_index] = updated_action
        payload = plan.model_dump(mode="python")
        payload["candidate_actions"] = actions
        payload["clarifications"] = plan.clarifications[1:]
        try:
            return ActionPlanResponse.model_validate(payload)
        except ValidationError as error:
            raise InvalidClarificationAnswerError from error

    @staticmethod
    def _target(
        question: Clarification,
        plan: ActionPlanResponse,
    ) -> ClarificationTarget:
        match = _FIELD_PATH.fullmatch(question.field_path)
        if match is None:
            raise ClarificationValidationError(ClarificationIssue.INVALID_TARGET)
        action_index = int(match.group("index"))
        if action_index >= len(plan.candidate_actions):
            raise ClarificationValidationError(ClarificationIssue.INVALID_TARGET)
        field = match.group("field")
        if field not in {"title", "owner", "due"}:
            raise ClarificationValidationError(ClarificationIssue.INVALID_TARGET)
        return ClarificationTarget(
            action_index=action_index,
            field=cast(Literal["title", "owner", "due"], field),
        )

    @staticmethod
    def _require_evidence(
        question: Clarification,
        action: CandidateAction,
    ) -> None:
        evidence = question.evidence
        if evidence is None:
            raise ClarificationValidationError(ClarificationIssue.MISSING_EVIDENCE)
        if not any(
            evidence.start >= source.start
            and evidence.end <= source.end
            and evidence.quote in source.quote
            for source in action.evidence
        ):
            raise ClarificationValidationError(ClarificationIssue.EVIDENCE_MISMATCH)

    @staticmethod
    def _has_ambiguous_owner(question: Clarification) -> bool:
        evidence = question.evidence
        if question.answer_kind != "option" or evidence is None:
            return False
        normalized_evidence = evidence.quote.casefold()
        return all(
            option.casefold() in normalized_evidence for option in question.options
        )

    def _apply_answer(
        self,
        request: ActionPlanRequest,
        action: CandidateAction,
        target: ClarificationTarget,
        answer: str,
    ) -> CandidateAction:
        try:
            if target.field == "title":
                return CandidateAction.model_validate(
                    {**action.model_dump(mode="python"), "title": answer}
                )
            if target.field == "owner":
                return CandidateAction.model_validate(
                    {**action.model_dump(mode="python"), "owner": answer}
                )

            due = action.due
            if due is None:
                raise InvalidClarificationAnswerError
            normalized = self._date_normalizer.resolve(
                answer,
                locale=request.locale,
                timezone=request.timezone,
                reference_date=request.reference_date,
            )
            if normalized is None:
                raise InvalidClarificationAnswerError
            return action.model_copy(
                update={
                    "due": due.model_copy(
                        update={
                            "iso_date": normalized.value,
                            "resolution": normalized.resolution,
                        }
                    )
                }
            )
        except (DateValidationError, ValidationError) as error:
            raise InvalidClarificationAnswerError from error
