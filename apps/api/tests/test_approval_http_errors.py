"""HTTP error mapping tests for the runtime approval boundary."""

from dataclasses import dataclass
from typing import NoReturn, cast

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from snapflow.application.guest_runs import GuestRunService
from snapflow.domain.run_contract import ApprovalRequest
from snapflow.persistence.guest_runs import (
    GuestSessionNotFoundError,
    RunNotFoundError,
)
from snapflow.presentation.guest_runs import create_guest_run_router
from snapflow.security.guest_tokens import InvalidGuestTokenError
from snapflow.workflow.graph import (
    WorkflowApprovalConflictError,
    WorkflowApprovalValidationError,
    WorkflowCheckpointError,
    WorkflowCheckpointNotFoundError,
)

pytestmark = pytest.mark.integration


@dataclass(frozen=True)
class FailingApprovalService:
    error: Exception

    def submit_approval(
        self,
        bearer_token: str,
        run_id: str,
        idempotency_key: str,
        request: ApprovalRequest,
    ) -> NoReturn:
        del bearer_token, run_id, idempotency_key, request
        raise self.error


def client_for(error: Exception) -> TestClient:
    app = FastAPI()
    app.include_router(
        create_guest_run_router(cast(GuestRunService, FailingApprovalService(error)))
    )
    return TestClient(app)


@pytest.mark.parametrize(
    ("error", "status_code", "code"),
    [
        (InvalidGuestTokenError(), 401, "unauthorized"),
        (GuestSessionNotFoundError(), 401, "unauthorized"),
        (RunNotFoundError(), 404, "run_not_found"),
        (WorkflowApprovalConflictError(), 409, "run_conflict"),
        (WorkflowApprovalValidationError(), 422, "invalid_request"),
        (WorkflowCheckpointNotFoundError(), 409, "run_conflict"),
        (WorkflowCheckpointError(), 500, "internal_error"),
    ],
    ids=[
        "invalid-token",
        "expired-guest",
        "missing-run",
        "stale",
        "invalid-decisions",
        "missing-checkpoint",
        "checkpoint-failure",
    ],
)
def test_approval_errors_are_safe_and_versioned(
    error: Exception,
    status_code: int,
    code: str,
) -> None:
    with client_for(error) as client:
        response = client.post(
            "/api/runs/run_12345678/approval",
            headers={
                "authorization": "Bearer opaque-test-token",
                "idempotency-key": "approve-run:http-errors",
            },
            json={"schema_version": "1.0", "decisions": []},
        )

    assert response.status_code == status_code
    assert response.json()["error"]["code"] == code
    assert type(error).__name__ not in response.text


def test_approval_requires_a_bearer_token_before_calling_the_service() -> None:
    with client_for(AssertionError("service must not be called")) as client:
        response = client.post(
            "/api/runs/run_12345678/approval",
            headers={"idempotency-key": "approve-run:no-auth"},
            json={"schema_version": "1.0", "decisions": []},
        )

    assert response.status_code == 401
    assert response.json()["error"]["code"] == "unauthorized"
