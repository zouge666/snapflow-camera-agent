"""Schema-only guest-session routes used for client generation."""

from typing import Annotated

from fastapi import APIRouter, Response, Security, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer

from snapflow.domain.run_contract import ErrorEnvelope, GuestSessionResponse
from snapflow.presentation.run_contracts import ERROR_RESPONSES, _not_implemented

router = APIRouter(prefix="/api/guest-sessions", tags=["guest sessions"])
bearer_scheme = HTTPBearer(auto_error=False)


@router.post(
    "",
    operation_id="create_guest_session",
    response_model=GuestSessionResponse,
    status_code=status.HTTP_201_CREATED,
    responses=ERROR_RESPONSES,
)
async def create_guest_session_contract() -> Response:
    """Describe anonymous guest creation for generated clients."""
    return _not_implemented()


@router.post(
    "/refresh",
    operation_id="refresh_guest_session",
    response_model=GuestSessionResponse,
    responses={
        **ERROR_RESPONSES,
        status.HTTP_401_UNAUTHORIZED: {"model": ErrorEnvelope},
    },
)
async def refresh_guest_session_contract(
    credentials: Annotated[
        HTTPAuthorizationCredentials | None,
        Security(bearer_scheme),
    ],
) -> Response:
    """Describe safe access-token rotation for generated clients."""
    del credentials
    return _not_implemented()
