"""Build the schema-only application used for contract generation."""

from fastapi import FastAPI

from snapflow.config import Settings
from snapflow.main import create_app
from snapflow.presentation.run_contracts import router as run_contract_router


def create_contract_app() -> FastAPI:
    """Combine current runtime routes with planned versioned run operations."""
    app = create_app(Settings(app_env="test", model_provider="mock"))
    app.title = "SnapFlow API Contract"
    app.include_router(run_contract_router)
    return app
