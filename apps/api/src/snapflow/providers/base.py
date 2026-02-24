"""Typed boundary shared by action-extraction provider adapters."""

from enum import StrEnum
from typing import ClassVar, Protocol

from snapflow.domain.action_plan import ActionPlanRequest, ActionPlanResponse


class ProviderErrorKind(StrEnum):
    """Stable failure categories understood by the workflow layer."""

    TIMEOUT = "timeout"
    RATE_LIMITED = "rate_limited"
    INVALID_OUTPUT = "invalid_output"


class ProviderError(RuntimeError):
    """Base error that exposes only workflow-safe provider metadata."""

    kind: ClassVar[ProviderErrorKind]
    retryable: ClassVar[bool]
    safe_message: ClassVar[str]

    def __init__(self) -> None:
        super().__init__(self.safe_message)


class ProviderTimeoutError(ProviderError):
    """The provider did not finish within the configured deadline."""

    kind = ProviderErrorKind.TIMEOUT
    retryable = True
    safe_message = "The action provider timed out."


class ProviderRateLimitError(ProviderError):
    """The provider rejected work because its quota was exhausted."""

    kind = ProviderErrorKind.RATE_LIMITED
    retryable = True
    safe_message = "The action provider is rate limited."

    def __init__(self, retry_after_seconds: int | None = None) -> None:
        if retry_after_seconds is not None and retry_after_seconds < 0:
            message = "retry_after_seconds cannot be negative"
            raise ValueError(message)
        self.retry_after_seconds = retry_after_seconds
        super().__init__()


class ProviderInvalidOutputError(ProviderError):
    """The provider returned data that failed the domain contract."""

    kind = ProviderErrorKind.INVALID_OUTPUT
    retryable = False
    safe_message = "The action provider returned invalid output."


class ProviderEmptyOutputError(ProviderInvalidOutputError):
    """The provider returned no candidate-plan payload at all."""

    safe_message = "The action provider returned empty output."


class ActionExtractionProvider(Protocol):
    """Port implemented by deterministic and model-backed providers."""

    def extract_actions(self, request: ActionPlanRequest) -> ActionPlanResponse:
        """Extract a typed candidate plan from user-confirmed text."""
        ...
