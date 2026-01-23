"""HTTP boundary for the temporary deterministic demo plan."""

from fastapi import APIRouter

from snapflow.application.build_plan import BuildActionPlan
from snapflow.domain.action_plan import ActionPlanRequest, ActionPlanResponse


def create_action_plan_router(build_action_plan: BuildActionPlan) -> APIRouter:
    """Bind the injected application service to its demo endpoint."""
    router = APIRouter(prefix="/api/demo", tags=["demo"])

    @router.post("/action-plan", response_model=ActionPlanResponse)
    async def create_action_plan(request: ActionPlanRequest) -> ActionPlanResponse:
        """Return fixture-backed candidates from confirmed text."""
        return build_action_plan.execute(request)

    return router
