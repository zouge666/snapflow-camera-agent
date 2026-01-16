"""Runtime configuration for the API composition root."""

from dataclasses import dataclass
from os import environ
from typing import Literal

ModelProvider = Literal["mock"]


@dataclass(frozen=True, slots=True)
class Settings:
    """Settings required by the current mock-only API."""

    app_env: str = "local"
    model_provider: ModelProvider = "mock"

    @classmethod
    def from_env(cls) -> "Settings":
        app_env = environ.get("APP_ENV", "local").strip() or "local"
        model_provider = environ.get("MODEL_PROVIDER", "mock").strip().lower()

        if model_provider != "mock":
            message = "MODEL_PROVIDER must be 'mock' until an adapter is implemented"
            raise ValueError(message)

        return cls(app_env=app_env, model_provider="mock")
