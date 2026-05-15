"""HTTP boundary for guest credentials and idempotent run creation."""

from typing import Annotated

from fastapi import APIRouter, Body, Header, Path, Response, Security, status
from fastapi.responses import JSONResponse
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer

from snapflow.application.guest_runs import GuestRunService
from snapflow.domain.run_contract import (
    ApprovalRequest,
    ClarificationAnswerRequest,
    CreateRunRequest,
    ErrorEnvelope,
    GuestSessionResponse,
    PublicError,
    PublicErrorCode,
    ResumeRunRequest,
    RunResponse,
)
from snapflow.persistence.guest_runs import (
    GuestSessionNotFoundError,
    IdempotencyConflictError,
    RunNotFoundError,
)
from snapflow.security.guest_tokens import InvalidGuestTokenError
from snapflow.workflow.graph import (
    WorkflowApprovalConflictError,
    WorkflowApprovalValidationError,
    WorkflowCheckpointError,
    WorkflowCheckpointNotFoundError,
    WorkflowClarificationAnswerError,
    WorkflowClarificationConflictError,
)
from snapflow.workflow.state import ActionExtractionWorkflowError

bearer_scheme = HTTPBearer(auto_error=False)
ERROR_RESPONSES: dict[int | str, dict[str, object]] = {
    status.HTTP_401_UNAUTHORIZED: {"model": ErrorEnvelope},
    status.HTTP_404_NOT_FOUND: {"model": ErrorEnvelope},
    status.HTTP_409_CONFLICT: {"model": ErrorEnvelope},
    status.HTTP_422_UNPROCESSABLE_CONTENT: {"model": ErrorEnvelope},
    status.HTTP_500_INTERNAL_SERVER_ERROR: {"model": ErrorEnvelope},
    status.HTTP_503_SERVICE_UNAVAILABLE: {"model": ErrorEnvelope},
}


def _error(
    status_code: int,
    code: PublicErrorCode,
    message: str,
    *,
    retryable: bool = False,
) -> JSONResponse:
    body = ErrorEnvelope(
        schema_version="1.0",
        error=PublicError(
            code=code,
            message=message,
            retryable=retryable,
        ),
    )
    return JSONResponse(
        status_code=status_code,
        content=body.model_dump(mode="json"),
    )


def _bearer_token(
    credentials: HTTPAuthorizationCredentials | None,
) -> str | JSONResponse:
    if credentials is None or credentials.scheme.lower() != "bearer":
        return _error(
            status.HTTP_401_UNAUTHORIZED,
            PublicErrorCode.UNAUTHORIZED,
            "A valid guest access token is required.",
        )
    return credentials.credentials


def create_guest_run_router(service: GuestRunService) -> APIRouter:
    """Bind guest-run use cases without global mutable dependencies."""
    router = APIRouter(tags=["guest sessions"])

    @router.post(
        "/api/guest-sessions",
        operation_id="create_guest_session",
        response_model=GuestSessionResponse,
        status_code=status.HTTP_201_CREATED,
        responses=ERROR_RESPONSES,
    )
    def create_guest_session() -> GuestSessionResponse:
        return service.create_session()

    @router.post(
        "/api/guest-sessions/refresh",
        operation_id="refresh_guest_session",
        response_model=GuestSessionResponse,
        responses=ERROR_RESPONSES,
    )
    def refresh_guest_session(
        credentials: Annotated[
            HTTPAuthorizationCredentials | None,
            Security(bearer_scheme),
        ],
    ) -> GuestSessionResponse | Response:
        token = _bearer_token(credentials)
        if isinstance(token, JSONResponse):
            return token
        try:
            return service.refresh_session(token)
        except (InvalidGuestTokenError, GuestSessionNotFoundError):
            return _error(
                status.HTTP_401_UNAUTHORIZED,
                PublicErrorCode.UNAUTHORIZED,
                "The guest session is invalid or expired.",
            )

    @router.post(
        "/api/runs",
        operation_id="create_run",
        response_model=RunResponse,
        status_code=status.HTTP_201_CREATED,
        responses={
            **ERROR_RESPONSES,
            status.HTTP_200_OK: {
                "model": RunResponse,
                "description": "Existing idempotent run",
            },
        },
    )
    def create_run(
        request: Annotated[CreateRunRequest, Body()],
        response: Response,
        credentials: Annotated[
            HTTPAuthorizationCredentials | None,
            Security(bearer_scheme),
        ],
        idempotency_key: Annotated[
            str,
            Header(
                alias="Idempotency-Key",
                min_length=8,
                max_length=128,
                pattern=r"^[A-Za-z0-9._:-]+$",
            ),
        ],
    ) -> RunResponse | Response:
        token = _bearer_token(credentials)
        if isinstance(token, JSONResponse):
            return token
        try:
            result = service.create_run(token, idempotency_key, request)
        except (InvalidGuestTokenError, GuestSessionNotFoundError):
            return _error(
                status.HTTP_401_UNAUTHORIZED,
                PublicErrorCode.UNAUTHORIZED,
                "The guest session is invalid or expired.",
            )
        except IdempotencyConflictError:
            return _error(
                status.HTTP_409_CONFLICT,
                PublicErrorCode.RUN_CONFLICT,
                "This idempotency key was already used for another request.",
            )
        except ActionExtractionWorkflowError as error:
            return _error(
                status.HTTP_503_SERVICE_UNAVAILABLE,
                PublicErrorCode.PROVIDER_UNAVAILABLE,
                "The action workflow could not produce a recoverable result.",
                retryable=error.retryable,
            )
        except WorkflowCheckpointError:
            return _error(
                status.HTTP_500_INTERNAL_SERVER_ERROR,
                PublicErrorCode.INTERNAL_ERROR,
                "The run could not be checkpointed safely.",
                retryable=True,
            )

        response.status_code = (
            status.HTTP_201_CREATED if result.created else status.HTTP_200_OK
        )
        return RunResponse(schema_version="1.0", run=result.run)

    @router.post(
        "/api/runs/{run_id}/resume",
        operation_id="resume_run",
        response_model=RunResponse,
        responses=ERROR_RESPONSES,
    )
    def resume_run(
        run_id: Annotated[
            str,
            Path(
                min_length=8,
                max_length=100,
                pattern=r"^run_[A-Za-z0-9_-]+$",
            ),
        ],
        request: Annotated[ResumeRunRequest, Body()],
        credentials: Annotated[
            HTTPAuthorizationCredentials | None,
            Security(bearer_scheme),
        ],
    ) -> RunResponse | Response:
        token = _bearer_token(credentials)
        if isinstance(token, JSONResponse):
            return token
        try:
            run = service.resume_run(token, run_id, request)
        except (InvalidGuestTokenError, GuestSessionNotFoundError):
            return _error(
                status.HTTP_401_UNAUTHORIZED,
                PublicErrorCode.UNAUTHORIZED,
                "The guest session is invalid or expired.",
            )
        except RunNotFoundError:
            return _error(
                status.HTTP_404_NOT_FOUND,
                PublicErrorCode.RUN_NOT_FOUND,
                "The requested run was not found.",
            )
        except WorkflowCheckpointNotFoundError:
            return _error(
                status.HTTP_409_CONFLICT,
                PublicErrorCode.RUN_CONFLICT,
                "The run checkpoint is unavailable.",
            )
        except WorkflowCheckpointError:
            return _error(
                status.HTTP_500_INTERNAL_SERVER_ERROR,
                PublicErrorCode.INTERNAL_ERROR,
                "The run checkpoint could not be loaded safely.",
                retryable=True,
            )
        return RunResponse(schema_version="1.0", run=run)

    @router.post(
        "/api/runs/{run_id}/clarifications",
        operation_id="answer_clarification",
        response_model=RunResponse,
        responses=ERROR_RESPONSES,
    )
    def answer_clarification(
        run_id: Annotated[
            str,
            Path(
                min_length=8,
                max_length=100,
                pattern=r"^run_[A-Za-z0-9_-]+$",
            ),
        ],
        request: Annotated[ClarificationAnswerRequest, Body()],
        credentials: Annotated[
            HTTPAuthorizationCredentials | None,
            Security(bearer_scheme),
        ],
    ) -> RunResponse | Response:
        token = _bearer_token(credentials)
        if isinstance(token, JSONResponse):
            return token
        try:
            run = service.answer_clarification(token, run_id, request)
        except (InvalidGuestTokenError, GuestSessionNotFoundError):
            return _error(
                status.HTTP_401_UNAUTHORIZED,
                PublicErrorCode.UNAUTHORIZED,
                "The guest session is invalid or expired.",
            )
        except RunNotFoundError:
            return _error(
                status.HTTP_404_NOT_FOUND,
                PublicErrorCode.RUN_NOT_FOUND,
                "The requested run was not found.",
            )
        except WorkflowClarificationConflictError:
            return _error(
                status.HTTP_409_CONFLICT,
                PublicErrorCode.RUN_CONFLICT,
                "This clarification is stale or has already been answered.",
            )
        except WorkflowClarificationAnswerError:
            return _error(
                status.HTTP_422_UNPROCESSABLE_CONTENT,
                PublicErrorCode.INVALID_REQUEST,
                "The answer does not resolve the current clarification.",
            )
        except ActionExtractionWorkflowError:
            return _error(
                status.HTTP_409_CONFLICT,
                PublicErrorCode.RUN_CONFLICT,
                "The clarification limit was reached before the run was resolved.",
            )
        except WorkflowCheckpointNotFoundError:
            return _error(
                status.HTTP_409_CONFLICT,
                PublicErrorCode.RUN_CONFLICT,
                "The run checkpoint is unavailable.",
            )
        except WorkflowCheckpointError:
            return _error(
                status.HTTP_500_INTERNAL_SERVER_ERROR,
                PublicErrorCode.INTERNAL_ERROR,
                "The clarification could not be checkpointed safely.",
                retryable=True,
            )
        return RunResponse(schema_version="1.0", run=run)

    @router.post(
        "/api/runs/{run_id}/approval",
        operation_id="submit_approval",
        response_model=RunResponse,
        responses=ERROR_RESPONSES,
    )
    def submit_approval(
        run_id: Annotated[
            str,
            Path(
                min_length=8,
                max_length=100,
                pattern=r"^run_[A-Za-z0-9_-]+$",
            ),
        ],
        request: Annotated[ApprovalRequest, Body()],
        credentials: Annotated[
            HTTPAuthorizationCredentials | None,
            Security(bearer_scheme),
        ],
        idempotency_key: Annotated[
            str,
            Header(
                alias="Idempotency-Key",
                min_length=8,
                max_length=128,
                pattern=r"^[A-Za-z0-9._:-]+$",
            ),
        ],
    ) -> RunResponse | Response:
        token = _bearer_token(credentials)
        if isinstance(token, JSONResponse):
            return token
        try:
            run = service.submit_approval(
                token,
                run_id,
                idempotency_key,
                request,
            )
        except (InvalidGuestTokenError, GuestSessionNotFoundError):
            return _error(
                status.HTTP_401_UNAUTHORIZED,
                PublicErrorCode.UNAUTHORIZED,
                "The guest session is invalid or expired.",
            )
        except RunNotFoundError:
            return _error(
                status.HTTP_404_NOT_FOUND,
                PublicErrorCode.RUN_NOT_FOUND,
                "The requested run was not found.",
            )
        except WorkflowApprovalConflictError:
            return _error(
                status.HTTP_409_CONFLICT,
                PublicErrorCode.RUN_CONFLICT,
                "This approval is stale, changed, or has already been submitted.",
            )
        except WorkflowApprovalValidationError:
            return _error(
                status.HTTP_422_UNPROCESSABLE_CONTENT,
                PublicErrorCode.INVALID_REQUEST,
                "The decisions do not match the current approval snapshot.",
            )
        except WorkflowCheckpointNotFoundError:
            return _error(
                status.HTTP_409_CONFLICT,
                PublicErrorCode.RUN_CONFLICT,
                "The run checkpoint is unavailable.",
            )
        except WorkflowCheckpointError:
            return _error(
                status.HTTP_500_INTERNAL_SERVER_ERROR,
                PublicErrorCode.INTERNAL_ERROR,
                "The approval could not be checkpointed safely.",
                retryable=True,
            )
        return RunResponse(schema_version="1.0", run=run)

    return router
