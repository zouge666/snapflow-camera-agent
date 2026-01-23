"""API composition root."""

from fastapi import FastAPI

from snapflow import __version__
from snapflow.application.build_plan import BuildActionPlan, PlanProvider
from snapflow.config import Settings
from snapflow.presentation.action_plans import create_action_plan_router
from snapflow.presentation.health import router as health_router
from snapflow.providers.mock import MockProvider


def create_app(
    settings: Settings | None = None,
    plan_provider: PlanProvider | None = None,
) -> FastAPI:
    """Build the API and wire its presentation routes."""
    resolved_settings = settings or Settings.from_env()
    resolved_provider = plan_provider or MockProvider()
    build_action_plan = BuildActionPlan(provider=resolved_provider)
    app = FastAPI(title="SnapFlow API", version=__version__)
    app.state.settings = resolved_settings
    app.state.build_action_plan = build_action_plan
    app.include_router(health_router)
    app.include_router(create_action_plan_router(build_action_plan))
    return app


app = create_app()
