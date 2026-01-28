"""HTTP integration tests for the basic approved-action ICS export."""

from datetime import date

import pytest
from fastapi.testclient import TestClient

from snapflow.config import Settings
from snapflow.main import create_app
from test_ics_tool import approved_item

pytestmark = pytest.mark.integration


def export_payload() -> dict[str, object]:
    """Return a JSON-safe request with one dated and one undated approval."""
    items = (
        approved_item(
            action_id="action-1",
            title="Send the revised onboarding checklist",
            owner="Alex",
            due_date=date(2026, 7, 17),
        ),
        approved_item(
            action_id="action-2",
            title="Prepare the support FAQ",
            owner=None,
            due_date=None,
        ),
    )
    return {
        "schema_version": "1.0",
        "reference_date": "2026-07-16",
        "approved_items": [item.model_dump(mode="json") for item in items],
    }


def test_ics_export_endpoint_returns_in_memory_content_and_warning() -> None:
    app = create_app(Settings(app_env="test", model_provider="mock"))

    with TestClient(app) as client:
        first = client.post("/api/demo/exports/ics", json=export_payload())
        second = client.post("/api/demo/exports/ics", json=export_payload())

    assert first.status_code == 200
    assert first.headers["content-type"] == "application/json"
    assert first.json() == second.json()
    assert first.json()["filename"] == "snapflow-approved-actions.ics"
    assert first.json()["content_type"] == "text/calendar; charset=utf-8"
    assert first.json()["exported_action_ids"] == ["action-1"]
    assert first.json()["warnings"][0]["action_id"] == "action-2"
    assert first.json()["content"].count("BEGIN:VEVENT") == 1


@pytest.mark.parametrize("decision", ["pending", "rejected"])
def test_ics_export_endpoint_rejects_non_approved_items(decision: str) -> None:
    payload = export_payload()
    approved_items = payload["approved_items"]
    assert isinstance(approved_items, list)
    first_item = approved_items[0]
    assert isinstance(first_item, dict)
    first_item["decision"] = decision
    app = create_app(Settings(app_env="test", model_provider="mock"))

    with TestClient(app) as client:
        response = client.post("/api/demo/exports/ics", json=payload)

    assert response.status_code == 422


def test_ics_export_openapi_exposes_typed_request_and_response() -> None:
    app = create_app(Settings(app_env="test", model_provider="mock"))

    operation = app.openapi()["paths"]["/api/demo/exports/ics"]["post"]

    assert operation["requestBody"]["content"]["application/json"]["schema"] == {
        "$ref": "#/components/schemas/IcsExportRequest"
    }
    assert operation["responses"]["200"]["content"]["application/json"]["schema"] == {
        "$ref": "#/components/schemas/IcsExportResponse"
    }
