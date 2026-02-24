"""Application service for the temporary demo action-plan endpoint."""

from dataclasses import dataclass

from pydantic import ValidationError

from snapflow.domain.action_plan import ActionPlanRequest, ActionPlanResponse
from snapflow.providers.base import (
    ActionExtractionProvider,
    ProviderEmptyOutputError,
    ProviderInvalidOutputError,
)


@dataclass(frozen=True, slots=True)
class BuildActionPlan:
    """Coordinate plan creation through an injected provider."""

    provider: ActionExtractionProvider

    def execute(self, request: ActionPlanRequest) -> ActionPlanResponse:
        """Return a fresh domain-validated copy of the provider output."""
        output: object = self.provider.extract_actions(request)
        if output is None or (isinstance(output, str) and not output.strip()):
            raise ProviderEmptyOutputError()
        if not isinstance(output, ActionPlanResponse):
            raise ProviderInvalidOutputError()

        try:
            return ActionPlanResponse.model_validate(output.model_dump(mode="python"))
        except ValidationError as error:
            raise ProviderInvalidOutputError() from error
