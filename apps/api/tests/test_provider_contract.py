"""Contract tests shared by action-extraction provider adapters."""

from typing import cast

import pytest

from snapflow.application.build_plan import BuildActionPlan
from snapflow.domain.action_plan import ActionPlanRequest, ActionPlanResponse
from snapflow.providers.base import (
    ActionExtractionProvider,
    ProviderEmptyOutputError,
    ProviderErrorKind,
    ProviderInvalidOutputError,
    ProviderRateLimitError,
    ProviderTimeoutError,
)
from snapflow.providers.mock import MockProvider
from test_action_plan_contract import sample_request

pytestmark = pytest.mark.unit


class SuccessfulFakeProvider:
    """Return a valid typed response without depending on fixture recognition."""

    def extract_actions(self, request: ActionPlanRequest) -> ActionPlanResponse:
        return ActionPlanResponse(
            schema_version="1.0",
            provider="mock",
            summary=f"Validated {len(request.source_text)} source characters.",
            candidate_actions=(),
            clarifications=(),
        )


class TimeoutFakeProvider:
    def extract_actions(self, request: ActionPlanRequest) -> ActionPlanResponse:
        del request
        raise ProviderTimeoutError()


class RateLimitedFakeProvider:
    def extract_actions(self, request: ActionPlanRequest) -> ActionPlanResponse:
        del request
        raise ProviderRateLimitError(retry_after_seconds=17)


class InvalidOutputFakeProvider:
    def extract_actions(self, request: ActionPlanRequest) -> ActionPlanResponse:
        del request
        return ActionPlanResponse.model_construct(
            schema_version="1.0",
            provider="mock",
            summary="",
            candidate_actions=(),
            clarifications=(),
        )


class RawMappingFakeProvider:
    def extract_actions(self, request: ActionPlanRequest) -> ActionPlanResponse:
        del request
        return cast(
            ActionPlanResponse,
            {
                "schema_version": "1.0",
                "provider": "mock",
                "summary": "This mapping must not cross the provider boundary.",
                "candidate_actions": (),
                "clarifications": (),
            },
        )


class EmptyOutputFakeProvider:
    def extract_actions(self, request: ActionPlanRequest) -> ActionPlanResponse:
        del request
        return cast(ActionPlanResponse, "  ")


@pytest.mark.parametrize(
    "provider",
    [MockProvider(), SuccessfulFakeProvider()],
    ids=["mock-adapter", "typed-success-fake"],
)
def test_provider_contract_returns_a_domain_validated_response(
    provider: ActionExtractionProvider,
) -> None:
    result = BuildActionPlan(provider=provider).execute(sample_request())

    assert type(result) is ActionPlanResponse
    assert result.schema_version == "1.0"
    assert result.provider == "mock"


def test_timeout_uses_a_retryable_stable_taxonomy() -> None:
    with pytest.raises(ProviderTimeoutError) as raised:
        BuildActionPlan(provider=TimeoutFakeProvider()).execute(sample_request())

    assert raised.value.kind is ProviderErrorKind.TIMEOUT
    assert raised.value.retryable is True
    assert str(raised.value) == "The action provider timed out."


def test_rate_limit_preserves_only_safe_retry_metadata() -> None:
    with pytest.raises(ProviderRateLimitError) as raised:
        BuildActionPlan(provider=RateLimitedFakeProvider()).execute(sample_request())

    assert raised.value.kind is ProviderErrorKind.RATE_LIMITED
    assert raised.value.retryable is True
    assert raised.value.retry_after_seconds == 17
    assert str(raised.value) == "The action provider is rate limited."

    with pytest.raises(ValueError, match="cannot be negative"):
        ProviderRateLimitError(retry_after_seconds=-1)


def test_invalid_typed_output_is_revalidated_at_the_domain_boundary() -> None:
    with pytest.raises(ProviderInvalidOutputError) as raised:
        BuildActionPlan(provider=InvalidOutputFakeProvider()).execute(sample_request())

    assert type(raised.value) is ProviderInvalidOutputError
    assert raised.value.kind is ProviderErrorKind.INVALID_OUTPUT
    assert raised.value.retryable is False
    assert str(raised.value) == "The action provider returned invalid output."
    assert raised.value.__cause__ is not None


def test_raw_mapping_is_rejected_before_it_crosses_the_domain_boundary() -> None:
    with pytest.raises(ProviderInvalidOutputError) as raised:
        BuildActionPlan(provider=RawMappingFakeProvider()).execute(sample_request())

    assert raised.value.kind is ProviderErrorKind.INVALID_OUTPUT
    assert raised.value.__cause__ is None


def test_empty_output_is_a_specific_invalid_output_failure() -> None:
    with pytest.raises(ProviderEmptyOutputError) as raised:
        BuildActionPlan(provider=EmptyOutputFakeProvider()).execute(sample_request())

    assert isinstance(raised.value, ProviderInvalidOutputError)
    assert raised.value.kind is ProviderErrorKind.INVALID_OUTPUT
    assert raised.value.retryable is False
    assert str(raised.value) == "The action provider returned empty output."
