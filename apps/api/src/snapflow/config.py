"""Runtime configuration for the API composition root."""

from dataclasses import dataclass
from os import environ
from typing import Literal

from dotenv import dotenv_values

ModelProvider = Literal["mock"]
DEFAULT_DATABASE_URL = (
    "postgresql+psycopg://snapflow:snapflow-local-only@127.0.0.1:5432/snapflow"
)


@dataclass(frozen=True, slots=True)
class Settings:
    """Validated runtime settings with secrets kept outside source control."""

    app_env: str = "local"
    model_provider: ModelProvider = "mock"
    database_url: str | None = None
    guest_token_signing_key: str | None = None
    guest_session_ttl_hours: int = 24
    guest_access_token_ttl_minutes: int = 30
    run_ttl_hours: int = 24
    max_clarifications: int = 2
    max_provider_retries: int = 2

    @classmethod
    def from_env(cls) -> "Settings":
        local_values = dotenv_values(".env", interpolate=False)

        def value(name: str, default: str = "") -> str:
            configured = environ.get(name)
            if configured is None:
                configured = local_values.get(name)
            return (configured or default).strip()

        app_env = value("APP_ENV", "local") or "local"
        model_provider = value("MODEL_PROVIDER", "mock").lower()

        if model_provider != "mock":
            message = "MODEL_PROVIDER must be 'mock' until an adapter is implemented"
            raise ValueError(message)

        signing_key = value("GUEST_TOKEN_SIGNING_KEY") or None
        if signing_key is not None:
            try:
                decoded_key = bytes.fromhex(signing_key)
            except ValueError as error:
                message = "GUEST_TOKEN_SIGNING_KEY must be 64 hexadecimal characters"
                raise ValueError(message) from error
            if len(decoded_key) != 32:
                message = "GUEST_TOKEN_SIGNING_KEY must be 64 hexadecimal characters"
                raise ValueError(message)

        return cls(
            app_env=app_env,
            model_provider="mock",
            database_url=value("DATABASE_URL", DEFAULT_DATABASE_URL)
            or DEFAULT_DATABASE_URL,
            guest_token_signing_key=signing_key,
            guest_session_ttl_hours=cls._positive_int(
                "GUEST_SESSION_TTL_HOURS",
                value("GUEST_SESSION_TTL_HOURS", "24"),
            ),
            guest_access_token_ttl_minutes=cls._positive_int(
                "GUEST_ACCESS_TOKEN_TTL_MINUTES",
                value("GUEST_ACCESS_TOKEN_TTL_MINUTES", "30"),
            ),
            run_ttl_hours=cls._positive_int(
                "RUN_TTL_HOURS",
                value("RUN_TTL_HOURS", "24"),
            ),
            max_clarifications=cls._bounded_non_negative_int(
                "MAX_CLARIFICATIONS",
                value("MAX_CLARIFICATIONS", "2"),
                maximum=2,
            ),
            max_provider_retries=cls._bounded_non_negative_int(
                "MAX_PROVIDER_RETRIES",
                value("MAX_PROVIDER_RETRIES", "2"),
                maximum=2,
            ),
        )

    @staticmethod
    def _positive_int(name: str, raw_value: str) -> int:
        try:
            value = int(raw_value)
        except ValueError as error:
            raise ValueError(f"{name} must be a positive integer") from error
        if value <= 0:
            raise ValueError(f"{name} must be a positive integer")
        return value

    @staticmethod
    def _bounded_non_negative_int(
        name: str,
        raw_value: str,
        *,
        maximum: int,
    ) -> int:
        try:
            value = int(raw_value)
        except ValueError as error:
            raise ValueError(
                f"{name} must be an integer between 0 and {maximum}"
            ) from error
        if not 0 <= value <= maximum:
            raise ValueError(f"{name} must be an integer between 0 and {maximum}")
        return value

    def signing_key_bytes(self) -> bytes:
        """Decode a previously validated local signing key."""
        if self.guest_token_signing_key is None:
            message = "GUEST_TOKEN_SIGNING_KEY is required for guest sessions"
            raise ValueError(message)
        return bytes.fromhex(self.guest_token_signing_key)
