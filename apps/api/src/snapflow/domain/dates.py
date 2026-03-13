"""Finite, locale-aware normalization of evidence-backed all-day dates."""

import re
from dataclasses import dataclass
from datetime import date, timedelta
from enum import StrEnum
from typing import Literal

from snapflow.domain.action_plan import (
    ActionPlanRequest,
    ActionPlanResponse,
    CandidateAction,
    CandidateDue,
)
from snapflow.domain.time_context import DateContext, InvalidTimezoneError

DateResolution = Literal["absolute", "relative"]

_ISO_DATE = re.compile(r"(?<!\d)(\d{4}-\d{2}-\d{2})(?!\d)")
_ENGLISH_WEEKDAY = re.compile(
    r"\b(Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)\b",
    re.IGNORECASE,
)
_CHINESE_WEEKDAY = re.compile(r"(?:周|星期)([一二三四五六日天])")
_ENGLISH_MONTH_DAY = re.compile(
    r"\b(January|February|March|April|May|June|July|August|September|"
    r"October|November|December)\s+([0-9]{1,2})(?:st|nd|rd|th)?\b",
    re.IGNORECASE,
)
_CHINESE_MONTH_DAY = re.compile(r"(?<!\d)(1[0-2]|[1-9])月(3[01]|[12][0-9]|[1-9])日")

_ENGLISH_WEEKDAYS = {
    "monday": 0,
    "tuesday": 1,
    "wednesday": 2,
    "thursday": 3,
    "friday": 4,
    "saturday": 5,
    "sunday": 6,
}
_CHINESE_WEEKDAYS = {
    "一": 0,
    "二": 1,
    "三": 2,
    "四": 3,
    "五": 4,
    "六": 5,
    "日": 6,
    "天": 6,
}
_ENGLISH_MONTHS = {
    "january": 1,
    "february": 2,
    "march": 3,
    "april": 4,
    "may": 5,
    "june": 6,
    "july": 7,
    "august": 8,
    "september": 9,
    "october": 10,
    "november": 11,
    "december": 12,
}


class DateIssue(StrEnum):
    """Stable structural reasons a date interpretation can be rejected."""

    INVALID_TIMEZONE = "invalid_timezone"
    INVALID_DATE = "invalid_date"
    CONFLICTING_DATES = "conflicting_dates"
    UNRESOLVED_DATE = "unresolved_date"
    RESOLUTION_MISMATCH = "resolution_mismatch"
    VALUE_MISMATCH = "value_mismatch"
    UNSOURCED_DATE = "unsourced_date"
    MISSING_CLARIFICATION = "missing_clarification"


class DateValidationError(ValueError):
    """A date failed validation without echoing user or provider text."""

    def __init__(self, issue: DateIssue) -> None:
        self.issue = issue
        message = (
            "The request timezone is invalid."
            if issue is DateIssue.INVALID_TIMEZONE
            else "The action plan contains an invalid date interpretation."
        )
        super().__init__(message)


@dataclass(frozen=True, slots=True)
class NormalizedDate:
    """One all-day calendar date derived from explicit request context."""

    value: date
    raw_text: str
    resolution: DateResolution
    timezone: str
    all_day: Literal[True] = True


class DateNormalizer:
    """Normalize a deliberately small set of unambiguous date expressions."""

    def validate_context(self, request: ActionPlanRequest) -> DateContext:
        try:
            return DateContext.create(
                locale=request.locale,
                timezone=request.timezone,
                reference_date=request.reference_date,
            )
        except InvalidTimezoneError as error:
            raise DateValidationError(DateIssue.INVALID_TIMEZONE) from error

    def normalize_plan(
        self,
        request: ActionPlanRequest,
        plan: ActionPlanResponse,
    ) -> ActionPlanResponse:
        context = self.validate_context(request)
        normalized_actions = tuple(
            self._normalize_action(index, action, plan, context)
            for index, action in enumerate(plan.candidate_actions)
        )
        return plan.model_copy(update={"candidate_actions": normalized_actions})

    def resolve(
        self,
        raw_text: str,
        *,
        locale: str,
        timezone: str,
        reference_date: date,
    ) -> NormalizedDate | None:
        try:
            context = DateContext.create(
                locale=locale,
                timezone=timezone,
                reference_date=reference_date,
            )
        except InvalidTimezoneError as error:
            raise DateValidationError(DateIssue.INVALID_TIMEZONE) from error
        return self._resolve_with_context(raw_text, context)

    def _normalize_action(
        self,
        index: int,
        action: CandidateAction,
        plan: ActionPlanResponse,
        context: DateContext,
    ) -> CandidateAction:
        due = action.due
        if due is None:
            return action
        if not any(due.raw_text in evidence.quote for evidence in action.evidence):
            raise DateValidationError(DateIssue.UNSOURCED_DATE)

        normalized = self._resolve_with_context(due.raw_text, context)
        if due.resolution == "ambiguous":
            self._validate_ambiguous_due(index, due, normalized, plan)
            return action
        if normalized is None:
            raise DateValidationError(DateIssue.UNRESOLVED_DATE)
        if normalized.resolution != due.resolution:
            raise DateValidationError(DateIssue.RESOLUTION_MISMATCH)
        if due.iso_date is not None and due.iso_date != normalized.value:
            raise DateValidationError(DateIssue.VALUE_MISMATCH)

        normalized_due = due.model_copy(update={"iso_date": normalized.value})
        return action.model_copy(update={"due": normalized_due})

    @staticmethod
    def _validate_ambiguous_due(
        index: int,
        due: CandidateDue,
        normalized: NormalizedDate | None,
        plan: ActionPlanResponse,
    ) -> None:
        if due.iso_date is not None or normalized is not None:
            raise DateValidationError(DateIssue.RESOLUTION_MISMATCH)
        expected_path = f"candidate_actions[{index}].due"
        matching = [
            clarification
            for clarification in plan.clarifications
            if clarification.field_path == expected_path
        ]
        if len(matching) != 1 or matching[0].evidence is None:
            raise DateValidationError(DateIssue.MISSING_CLARIFICATION)

    def _resolve_with_context(
        self,
        raw_text: str,
        context: DateContext,
    ) -> NormalizedDate | None:
        candidates: list[tuple[date, DateResolution]] = []
        candidates.extend(self._iso_candidates(raw_text))
        if context.language == "en":
            candidates.extend(
                self._english_candidates(raw_text, context.reference_date)
            )
        elif context.language == "zh":
            candidates.extend(
                self._chinese_candidates(raw_text, context.reference_date)
            )

        unique_dates = {candidate[0] for candidate in candidates}
        if len(unique_dates) > 1:
            raise DateValidationError(DateIssue.CONFLICTING_DATES)
        if not candidates:
            return None

        value = candidates[0][0]
        resolution: DateResolution = (
            "absolute"
            if any(
                candidate_resolution == "absolute"
                for _, candidate_resolution in candidates
            )
            else "relative"
        )
        return NormalizedDate(
            value=value,
            raw_text=raw_text,
            resolution=resolution,
            timezone=context.timezone.key,
        )

    @staticmethod
    def _iso_candidates(raw_text: str) -> list[tuple[date, DateResolution]]:
        candidates: list[tuple[date, DateResolution]] = []
        for raw_value in _ISO_DATE.findall(raw_text):
            try:
                parsed = date.fromisoformat(raw_value)
            except ValueError as error:
                raise DateValidationError(DateIssue.INVALID_DATE) from error
            candidates.append((parsed, "absolute"))
        return candidates

    @staticmethod
    def _english_candidates(
        raw_text: str,
        reference_date: date,
    ) -> list[tuple[date, DateResolution]]:
        candidates: list[tuple[date, DateResolution]] = []
        candidates.extend(
            (
                _next_weekday(reference_date, _ENGLISH_WEEKDAYS[value.lower()]),
                "relative",
            )
            for value in _ENGLISH_WEEKDAY.findall(raw_text)
        )
        for month_name, day_text in _ENGLISH_MONTH_DAY.findall(raw_text):
            candidates.append(
                (
                    _next_month_day(
                        reference_date,
                        _ENGLISH_MONTHS[month_name.lower()],
                        int(day_text),
                    ),
                    "relative",
                )
            )
        return candidates

    @staticmethod
    def _chinese_candidates(
        raw_text: str,
        reference_date: date,
    ) -> list[tuple[date, DateResolution]]:
        candidates: list[tuple[date, DateResolution]] = []
        candidates.extend(
            (_next_weekday(reference_date, _CHINESE_WEEKDAYS[value]), "relative")
            for value in _CHINESE_WEEKDAY.findall(raw_text)
        )
        for month_text, day_text in _CHINESE_MONTH_DAY.findall(raw_text):
            candidates.append(
                (
                    _next_month_day(reference_date, int(month_text), int(day_text)),
                    "relative",
                )
            )
        return candidates


def _next_weekday(reference_date: date, weekday: int) -> date:
    days_ahead = (weekday - reference_date.weekday()) % 7
    return reference_date + timedelta(days=days_ahead)


def _next_month_day(reference_date: date, month: int, day: int) -> date:
    year = reference_date.year
    for _ in range(9):
        try:
            candidate = date(year, month, day)
        except ValueError:
            year += 1
            continue
        if candidate >= reference_date:
            return candidate
        year += 1
    raise DateValidationError(DateIssue.INVALID_DATE)
