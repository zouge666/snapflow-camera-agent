"""Integration checks for the OpenAPI snapshot and generated client boundary."""

import json
from pathlib import Path
from typing import cast

import pytest
from fastapi.testclient import TestClient

from snapflow.config import Settings
from snapflow.contract import create_contract_app
from snapflow.export_openapi import export_openapi
from snapflow.main import create_app

pytestmark = pytest.mark.integration

REPOSITORY_ROOT = Path(__file__).parents[3]
OPENAPI_SNAPSHOT = REPOSITORY_ROOT / "packages" / "contracts" / "openapi.json"
GENERATED_CLIENT = REPOSITORY_ROOT / "apps" / "web" / "lib" / "api" / "generated"
RUN_OPERATIONS = {
    "create_run",
    "resume_run",
    "answer_clarification",
    "submit_approval",
    "export_run",
    "delete_run",
}


def test_runtime_app_does_not_expose_contract_only_run_routes() -> None:
    runtime_paths = create_app(
        Settings(app_env="test", model_provider="mock")
    ).openapi()["paths"]
    contract_paths = create_contract_app().openapi()["paths"]

    assert not any(path.startswith("/api/runs") for path in runtime_paths)
    assert {path for path in contract_paths if path.startswith("/api/runs")} == {
        "/api/runs",
        "/api/runs/{run_id}",
        "/api/runs/{run_id}/approval",
        "/api/runs/{run_id}/clarifications",
        "/api/runs/{run_id}/exports",
        "/api/runs/{run_id}/resume",
    }
    assert {
        path for path in contract_paths if path.startswith("/api/guest-sessions")
    } == {
        "/api/guest-sessions",
        "/api/guest-sessions/refresh",
    }


def test_contract_openapi_has_stable_operations_models_and_error_envelope() -> None:
    document = create_contract_app().openapi()
    operations: set[str] = set()

    for path, path_item in document["paths"].items():
        if not path.startswith("/api/runs"):
            continue
        for method, operation in path_item.items():
            if method not in {"delete", "get", "patch", "post", "put"}:
                continue
            operation_id = operation["operationId"]
            operations.add(operation_id)
            for status_code, response in operation["responses"].items():
                if status_code in {"200", "201"}:
                    continue
                schema = response["content"]["application/json"]["schema"]
                assert schema == {"$ref": "#/components/schemas/ErrorEnvelope"}

    assert operations == RUN_OPERATIONS

    components = document["components"]["schemas"]
    assert components["CreateRunRequest"]["additionalProperties"] is False
    assert components["ApprovalRequest"]["additionalProperties"] is False
    assert components["ErrorEnvelope"]["additionalProperties"] is False
    assert components["CreateRunRequest"]["properties"]["schema_version"] == {
        "const": "1.0",
        "title": "Schema Version",
        "type": "string",
    }


def test_checked_openapi_snapshot_matches_pydantic_source() -> None:
    checked = cast(
        dict[str, object],
        json.loads(OPENAPI_SNAPSHOT.read_text(encoding="utf-8")),
    )

    assert checked == create_contract_app().openapi()


def test_exporter_writes_the_same_stable_document(tmp_path: Path) -> None:
    output = tmp_path / "nested" / "openapi.json"

    export_openapi(output)

    assert (
        json.loads(output.read_text(encoding="utf-8"))
        == create_contract_app().openapi()
    )
    assert output.read_text(encoding="utf-8").endswith("\n")


def test_generated_client_contains_all_run_operations_and_shared_enums() -> None:
    index = (GENERATED_CLIENT / "index.ts").read_text(encoding="utf-8")
    types = (GENERATED_CLIENT / "types.gen.ts").read_text(encoding="utf-8")

    for operation in (
        "answerClarification",
        "createGuestSession",
        "createRun",
        "deleteRun",
        "exportRun",
        "refreshGuestSession",
        "resumeRun",
        "submitApproval",
    ):
        assert operation in index

    assert "export type RunStatus =" in types
    assert "export type ActionPriority =" in types
    assert "export type PublicErrorCode =" in types
    assert (
        "source_text"
        not in types.split("export type SafeTraceEvent =", maxsplit=1)[1].split(
            "};", maxsplit=1
        )[0]
    )


@pytest.mark.parametrize(
    ("method", "path", "body"),
    [
        (
            "post",
            "/api/runs",
            {
                "schema_version": "1.0",
                "source_text": "Alex will prepare the release notes by Friday.",
                "locale": "en-US",
                "timezone": "Europe/Copenhagen",
                "reference_date": "2026-07-29",
            },
        ),
        (
            "post",
            "/api/runs/run_12345678/resume",
            {"schema_version": "1.0", "last_seen_trace_sequence": 0},
        ),
        (
            "post",
            "/api/runs/run_12345678/clarifications",
            {
                "schema_version": "1.0",
                "clarification_id": "clarification-1",
                "kind": "free_text",
                "answer": "The review is on 2026-08-03.",
            },
        ),
        (
            "post",
            "/api/runs/run_12345678/approval",
            {
                "schema_version": "1.0",
                "decisions": [
                    {
                        "action_id": "action-1",
                        "decision": "approve",
                        "reviewed": None,
                    }
                ],
            },
        ),
        (
            "post",
            "/api/runs/run_12345678/exports",
            {
                "schema_version": "1.0",
                "formats": ["ics"],
                "approved_action_ids": ["action-1"],
            },
        ),
        ("delete", "/api/runs/run_12345678", None),
    ],
    ids=["create", "resume", "clarify", "approve", "export", "delete"],
)
def test_contract_preview_fails_honestly_with_versioned_error(
    method: str,
    path: str,
    body: dict[str, object] | None,
) -> None:
    app = create_contract_app()

    with TestClient(app) as client:
        response = client.request(method, path, json=body)

    assert response.status_code == 501
    assert response.json() == {
        "schema_version": "1.0",
        "error": {
            "code": "not_implemented",
            "message": "This contract operation is not implemented yet.",
            "request_id": None,
            "retryable": False,
            "details": [],
        },
    }


@pytest.mark.parametrize(
    ("path", "headers"),
    [
        ("/api/guest-sessions", {}),
        ("/api/guest-sessions/refresh", {"authorization": "Bearer preview"}),
    ],
    ids=["create-guest", "refresh-guest"],
)
def test_guest_contract_preview_is_versioned_and_honest(
    path: str,
    headers: dict[str, str],
) -> None:
    with TestClient(create_contract_app()) as client:
        response = client.post(path, headers=headers)

    assert response.status_code == 501
    assert response.json()["error"]["code"] == "not_implemented"
