"""API bootstrap and liveness tests."""

import pytest
from fastapi.testclient import TestClient

from snapflow.config import Settings
from snapflow.main import create_app

pytestmark = pytest.mark.integration


def test_app_starts_with_mock_settings() -> None:
    app = create_app(Settings(app_env="test", model_provider="mock"))

    assert app.state.settings.app_env == "test"
    assert app.state.settings.model_provider == "mock"


def test_liveness_returns_ok() -> None:
    app = create_app(Settings(app_env="test", model_provider="mock"))

    with TestClient(app) as client:
        response = client.get("/health/live")

    assert response.status_code == 200
    assert response.json() == {"service": "api", "status": "ok"}
    assert response.headers["content-type"] == "application/json"


def test_default_environment_uses_mock_provider(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.delenv("APP_ENV", raising=False)
    monkeypatch.delenv("MODEL_PROVIDER", raising=False)

    app = create_app()

    assert app.state.settings.app_env == "local"
    assert app.state.settings.model_provider == "mock"


def test_unimplemented_provider_is_rejected(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("MODEL_PROVIDER", "deepseek")

    with pytest.raises(ValueError, match="must be 'mock'"):
        create_app()


def test_environment_validates_guest_security_and_ttl_values(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("GUEST_TOKEN_SIGNING_KEY", "not-hex")
    with pytest.raises(ValueError, match="64 hexadecimal"):
        Settings.from_env()

    monkeypatch.setenv("GUEST_TOKEN_SIGNING_KEY", "11" * 32)
    monkeypatch.setenv("RUN_TTL_HOURS", "0")
    with pytest.raises(ValueError, match="positive integer"):
        Settings.from_env()

    monkeypatch.setenv("RUN_TTL_HOURS", "24")
    settings = Settings.from_env()
    assert settings.signing_key_bytes() == bytes.fromhex("11" * 32)

    with pytest.raises(ValueError, match="required"):
        Settings().signing_key_bytes()
