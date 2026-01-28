"""API composition root."""

from fastapi import FastAPI

from snapflow import __version__
from snapflow.application.build_plan import BuildActionPlan, PlanProvider
from snapflow.application.export_ics import ExportApprovedIcs, IcsExportTool
from snapflow.config import Settings
from snapflow.presentation.action_plans import create_action_plan_router
from snapflow.presentation.health import router as health_router
from snapflow.presentation.ics_exports import create_ics_export_router
from snapflow.providers.mock import MockProvider
from snapflow.tools.ics import IcsExporter


def create_app(
    settings: Settings | None = None,
    plan_provider: PlanProvider | None = None,
    ics_export_tool: IcsExportTool | None = None,
) -> FastAPI:
    """Build the API and wire its presentation routes."""
    resolved_settings = settings or Settings.from_env()
    resolved_provider = plan_provider or MockProvider()
    resolved_ics_tool = ics_export_tool or IcsExporter()
    build_action_plan = BuildActionPlan(provider=resolved_provider)
    export_approved_ics = ExportApprovedIcs(tool=resolved_ics_tool)
    app = FastAPI(title="SnapFlow API", version=__version__)
    app.state.settings = resolved_settings
    app.state.build_action_plan = build_action_plan
    app.state.export_approved_ics = export_approved_ics
    app.include_router(health_router)
    app.include_router(create_action_plan_router(build_action_plan))
    app.include_router(create_ics_export_router(export_approved_ics))
    return app


app = create_app()
