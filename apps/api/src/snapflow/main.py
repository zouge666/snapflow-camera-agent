"""API composition root."""

from datetime import timedelta

from fastapi import FastAPI

from snapflow import __version__
from snapflow.application.build_plan import BuildActionPlan, PlanProvider
from snapflow.application.export_ics import ExportApprovedIcs, IcsExportTool
from snapflow.application.guest_runs import GuestRunService
from snapflow.config import Settings
from snapflow.persistence.database import create_database_engine, create_session_factory
from snapflow.persistence.guest_runs import GuestRunRepository
from snapflow.presentation.action_plans import create_action_plan_router
from snapflow.presentation.guest_runs import create_guest_run_router
from snapflow.presentation.health import router as health_router
from snapflow.presentation.ics_exports import create_ics_export_router
from snapflow.providers.mock import MockProvider
from snapflow.security.guest_tokens import GuestTokenService
from snapflow.tools.ics import IcsExporter


def create_app(
    settings: Settings | None = None,
    plan_provider: PlanProvider | None = None,
    ics_export_tool: IcsExportTool | None = None,
    guest_run_service: GuestRunService | None = None,
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
    resolved_guest_service = guest_run_service
    if (
        resolved_guest_service is None
        and resolved_settings.database_url is not None
        and resolved_settings.guest_token_signing_key is not None
    ):
        signing_key = resolved_settings.signing_key_bytes()
        engine = create_database_engine(resolved_settings.database_url)
        app.state.database_engine = engine
        repository = GuestRunRepository(
            create_session_factory(engine),
            signing_key,
            guest_ttl=timedelta(hours=resolved_settings.guest_session_ttl_hours),
            run_ttl=timedelta(hours=resolved_settings.run_ttl_hours),
        )
        tokens = GuestTokenService(
            signing_key,
            timedelta(minutes=resolved_settings.guest_access_token_ttl_minutes),
        )
        resolved_guest_service = GuestRunService(repository=repository, tokens=tokens)
    if resolved_guest_service is not None:
        app.state.guest_run_service = resolved_guest_service
        app.include_router(create_guest_run_router(resolved_guest_service))
    return app


app = create_app()
