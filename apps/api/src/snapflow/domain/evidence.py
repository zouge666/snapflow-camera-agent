"""Deterministic UTF-16 evidence validation for browser-visible source text."""

from enum import StrEnum
from itertools import pairwise

from snapflow.domain.action_plan import ActionPlanResponse, EvidenceRange


class EvidenceIssue(StrEnum):
    """Stable structural reasons an evidence range can be rejected."""

    DUPLICATE = "duplicate"
    OVERLAP = "overlap"
    OUT_OF_RANGE = "out_of_range"
    INVALID_BOUNDARY = "invalid_boundary"
    QUOTE_MISMATCH = "quote_mismatch"


class EvidenceValidationError(ValueError):
    """A source range failed without exposing its source text in the error."""

    def __init__(self, issue: EvidenceIssue) -> None:
        self.issue = issue
        super().__init__("The action plan contains invalid evidence ranges.")


def utf16_length(value: str) -> int:
    """Count JavaScript-compatible UTF-16 code units in a Python string."""
    return len(value.encode("utf-16-le")) // 2


class EvidenceValidator:
    """Validate every action and clarification range against exact source text."""

    def validate_plan(
        self,
        source_text: str,
        plan: ActionPlanResponse,
    ) -> ActionPlanResponse:
        for action in plan.candidate_actions:
            self._validate_collection(source_text, action.evidence)
        for clarification in plan.clarifications:
            if clarification.evidence is not None:
                self._validate_range(source_text, clarification.evidence)
        return plan

    def _validate_collection(
        self,
        source_text: str,
        ranges: tuple[EvidenceRange, ...],
    ) -> None:
        seen: set[tuple[int, int]] = set()
        for evidence in ranges:
            span = (evidence.start, evidence.end)
            if span in seen:
                raise EvidenceValidationError(EvidenceIssue.DUPLICATE)
            seen.add(span)
            self._validate_range(source_text, evidence)

        ordered = sorted(ranges, key=lambda evidence: (evidence.start, evidence.end))
        if any(current.start < previous.end for previous, current in pairwise(ordered)):
            raise EvidenceValidationError(EvidenceIssue.OVERLAP)

    @staticmethod
    def _validate_range(source_text: str, evidence: EvidenceRange) -> None:
        encoded = source_text.encode("utf-16-le")
        source_units = len(encoded) // 2
        if evidence.start > source_units or evidence.end > source_units:
            raise EvidenceValidationError(EvidenceIssue.OUT_OF_RANGE)

        encoded_quote = encoded[evidence.start * 2 : evidence.end * 2]
        try:
            actual_quote = encoded_quote.decode("utf-16-le")
        except UnicodeDecodeError as error:
            raise EvidenceValidationError(EvidenceIssue.INVALID_BOUNDARY) from error
        if actual_quote != evidence.quote:
            raise EvidenceValidationError(EvidenceIssue.QUOTE_MISMATCH)
