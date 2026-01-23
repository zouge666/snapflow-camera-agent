"""Application service for the temporary demo action-plan endpoint."""

from dataclasses import dataclass
from typing import Protocol

from snapflow.domain.action_plan import ActionPlanRequest, ActionPlanResponse


class PlanProvider(Protocol):
    """Minimum provider behavior needed by the Task 16 vertical slice."""

    def build_plan(self, request: ActionPlanRequest) -> ActionPlanResponse:
        """Build a typed plan without performing side effects."""
        ...


@dataclass(frozen=True, slots=True)
class BuildActionPlan:
    """Coordinate plan creation through an injected provider."""

    provider: PlanProvider

    def execute(self, request: ActionPlanRequest) -> ActionPlanResponse:
        """Return the provider's already-typed candidate plan."""
        return self.provider.build_plan(request)
