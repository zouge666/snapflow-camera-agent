"""HTTP integration tests for the deterministic demo action plan."""

import socket

import pytest
from fastapi.testclient import TestClient

from snapflow.config import Settings
from snapflow.domain.action_plan import MAX_SOURCE_CHARS
from snapflow.main import create_app
from test_action_plan_contract import sample_payload

pytestmark = pytest.mark.integration


def test_action_plan_endpoint_is_stable_and_never_opens_a_network_connection(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    app = create_app(Settings(app_env="test", model_provider="mock"))

    def reject_network(*_args: object, **_kwargs: object) -> None:
        raise AssertionError("the mock plan endpoint attempted network access")

    with TestClient(app) as client:
        monkeypatch.setattr(socket.socket, "connect", reject_network)
        first = client.post("/api/demo/action-plan", json=sample_payload())
        second = client.post("/api/demo/action-plan", json=sample_payload())

    assert first.status_code == 200
    assert first.headers["content-type"] == "application/json"
    assert first.json() == second.json()
    assert first.json()["schema_version"] == "1.0"
    assert first.json()["provider"] == "mock"
    assert len(first.json()["candidate_actions"]) == 3
    assert len(first.json()["clarifications"]) == 1


@pytest.mark.parametrize(
    ("field", "value"),
    [
        ("source_text", ""),
        ("source_text", "x" * (MAX_SOURCE_CHARS + 1)),
        ("timezone", ""),
        ("reference_date", "2026-02-30"),
    ],
    ids=["empty-text", "over-limit", "empty-timezone", "invalid-date"],
)
def test_action_plan_endpoint_rejects_invalid_contract(
    field: str,
    value: str,
) -> None:
    payload = sample_payload()
    payload[field] = value
    app = create_app(Settings(app_env="test", model_provider="mock"))

    with TestClient(app) as client:
        response = client.post("/api/demo/action-plan", json=payload)

    assert response.status_code == 422


def test_action_plan_openapi_exposes_versioned_response_contract() -> None:
    app = create_app(Settings(app_env="test", model_provider="mock"))

    operation = app.openapi()["paths"]["/api/demo/action-plan"]["post"]

    assert operation["requestBody"]["content"]["application/json"]["schema"] == {
        "$ref": "#/components/schemas/ActionPlanRequest"
    }
    assert operation["responses"]["200"]["content"]["application/json"]["schema"] == {
        "$ref": "#/components/schemas/ActionPlanResponse"
    }
