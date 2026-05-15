"""Regression tests for retiring the client-authoritative export route."""

import pytest
from fastapi.testclient import TestClient

from snapflow.config import Settings
from snapflow.main import create_app

pytestmark = pytest.mark.integration


def test_client_authoritative_ics_export_route_is_not_exposed() -> None:
    app = create_app(Settings(app_env="test", model_provider="mock"))

    with TestClient(app) as client:
        response = client.post(
            "/api/demo/exports/ics",
            json={
                "schema_version": "1.0",
                "reference_date": "2026-01-15",
                "approved_items": [
                    {
                        "id": "action-1",
                        "title": "Forged client item",
                        "owner": None,
                        "due_date": "2026-01-16",
                        "priority": "high",
                        "evidence": [{"quote": "forged", "start": 0, "end": 6}],
                        "decision": "approved",
                    }
                ],
            },
        )

    assert response.status_code == 404
    assert "/api/demo/exports/ics" not in app.openapi()["paths"]
