"""HTTP boundary for guest credentials and idempotent run creation."""

from typing import Annotated

from fastapi import APIRouter, Body, Header, Response, Security, status
from fastapi.responses import JSONResponse
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer

from snapflow.application.guest_runs import GuestRunService
from snapflow.domain.run_contract import (
    CreateRunRequest,
    ErrorEnvelope,
    GuestSessionResponse,
    PublicError,
    PublicErrorCode,
    RunResponse,
)
from snapflow.persistence.guest_runs import (
    GuestSessionNotFoundError,
    IdempotencyConflictError,
)
from snapflow.security.guest_tokens import InvalidGuestTokenError

bearer_scheme = HTTPBearer(auto_error=False)
ERROR_RESPONSES: dict[int | str, dict[str, object]] = {
    status.HTTP_401_UNAUTHORIZED: {"model": ErrorEnvelope},
    status.HTTP_409_CONFLICT: {"model": ErrorEnvelope},
    status.HTTP_422_UNPROCESSABLE_CONTENT: {"model": ErrorEnvelope},
    status.HTTP_500_INTERNAL_SERVER_ERROR: {"model": ErrorEnvelope},
}


def _error(
    status_code: int,
    code: PublicErrorCode,
    message: str,
) -> JSONResponse:
    body = ErrorEnvelope(
        schema_version="1.0",
        error=PublicError(
            code=code,
            message=message,
            retryable=False,
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

        response.status_code = (
            status.HTTP_201_CREATED if result.created else status.HTTP_200_OK
        )
        return RunResponse(schema_version="1.0", run=result.run)

    return router
