"""API composition root."""

from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from datetime import timedelta

from fastapi import FastAPI
from sqlalchemy import Engine

from snapflow import __version__
from snapflow.application.build_plan import BuildActionPlan
from snapflow.application.export_ics import ExportApprovedIcs, IcsExportTool
from snapflow.application.guest_runs import GuestRunService
from snapflow.config import Settings
from snapflow.persistence.checkpoints import PostgresCheckpointStore
from snapflow.persistence.database import create_database_engine, create_session_factory
from snapflow.persistence.guest_runs import GuestRunRepository
from snapflow.presentation.action_plans import create_action_plan_router
from snapflow.presentation.guest_runs import create_guest_run_router
from snapflow.presentation.health import router as health_router
from snapflow.providers.base import ActionExtractionProvider
from snapflow.providers.mock import MockProvider
from snapflow.security.guest_tokens import GuestTokenService
from snapflow.tools.ics import IcsExporter
from snapflow.workflow.graph import create_action_extraction_workflow
from snapflow.workflow.state import WorkflowLimits


def create_action_extraction_provider(settings: Settings) -> ActionExtractionProvider:
    """Select the configured model adapter at the composition root."""
    provider_factories = {"mock": MockProvider}
    return provider_factories[settings.model_provider]()


def create_app(
    settings: Settings | None = None,
    action_extraction_provider: ActionExtractionProvider | None = None,
    ics_export_tool: IcsExportTool | None = None,
    guest_run_service: GuestRunService | None = None,
    checkpoint_store: PostgresCheckpointStore | None = None,
) -> FastAPI:
    """Build the API and wire its presentation routes."""
    resolved_settings = settings or Settings.from_env()
    resolved_provider = action_extraction_provider or create_action_extraction_provider(
        resolved_settings
    )
    resolved_ics_tool = ics_export_tool or IcsExporter()
    build_action_plan = BuildActionPlan(provider=resolved_provider)
    action_extraction_workflow = create_action_extraction_workflow(
        build_action_plan,
        WorkflowLimits(
            max_clarifications=resolved_settings.max_clarifications,
            max_provider_retries=resolved_settings.max_provider_retries,
        ),
    )
    export_approved_ics = ExportApprovedIcs(tool=resolved_ics_tool)
    resolved_guest_service = guest_run_service
    managed_engine: Engine | None = None
    managed_checkpoint_store = checkpoint_store
    if (
        resolved_guest_service is None
        and resolved_settings.database_url is not None
        and resolved_settings.guest_token_signing_key is not None
    ):
        signing_key = resolved_settings.signing_key_bytes()
        engine = create_database_engine(resolved_settings.database_url)
        managed_engine = engine
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
        managed_checkpoint_store = PostgresCheckpointStore(
            resolved_settings.database_url
        )
        durable_workflow = create_action_extraction_workflow(
            build_action_plan,
            WorkflowLimits(
                max_clarifications=resolved_settings.max_clarifications,
                max_provider_retries=resolved_settings.max_provider_retries,
            ),
            checkpointer=managed_checkpoint_store.checkpointer,
        )
        resolved_guest_service = GuestRunService(
            repository=repository,
            tokens=tokens,
            workflow=durable_workflow,
        )

    @asynccontextmanager
    async def lifespan(_: FastAPI) -> AsyncIterator[None]:
        try:
            if managed_checkpoint_store is not None:
                managed_checkpoint_store.setup()
            yield
        finally:
            if managed_checkpoint_store is not None:
                managed_checkpoint_store.close()
            if managed_engine is not None:
                managed_engine.dispose()

    app = FastAPI(title="SnapFlow API", version=__version__, lifespan=lifespan)
    app.state.settings = resolved_settings
    app.state.build_action_plan = build_action_plan
    app.state.action_extraction_workflow = action_extraction_workflow
    app.state.export_approved_ics = export_approved_ics
    if managed_engine is not None:
        app.state.database_engine = managed_engine
    if managed_checkpoint_store is not None:
        app.state.checkpoint_store = managed_checkpoint_store
    app.include_router(health_router)
    app.include_router(create_action_plan_router(action_extraction_workflow))
    if resolved_guest_service is not None:
        app.state.guest_run_service = resolved_guest_service
        app.include_router(create_guest_run_router(resolved_guest_service))
    return app


app = create_app()
