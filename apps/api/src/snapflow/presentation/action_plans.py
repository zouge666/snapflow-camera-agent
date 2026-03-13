"""HTTP boundary for the temporary deterministic demo plan."""

from fastapi import APIRouter

from snapflow.domain.action_plan import ActionPlanRequest, ActionPlanResponse
from snapflow.workflow.graph import ActionExtractionWorkflow


def create_action_plan_router(workflow: ActionExtractionWorkflow) -> APIRouter:
    """Bind the injected application service to its demo endpoint."""
    router = APIRouter(prefix="/api/demo", tags=["demo"])

    @router.post("/action-plan", response_model=ActionPlanResponse)
    async def create_action_plan(request: ActionPlanRequest) -> ActionPlanResponse:
        """Return fixture-backed candidates from confirmed text."""
        return workflow.execute(request)

    return router
