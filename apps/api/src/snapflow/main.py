"""API composition root."""

from fastapi import FastAPI

from snapflow import __version__
from snapflow.config import Settings
from snapflow.presentation.health import router as health_router


def create_app(settings: Settings | None = None) -> FastAPI:
    """Build the API and wire its presentation routes."""
    resolved_settings = settings or Settings.from_env()
    app = FastAPI(title="SnapFlow API", version=__version__)
    app.state.settings = resolved_settings
    app.include_router(health_router)
    return app


app = create_app()
