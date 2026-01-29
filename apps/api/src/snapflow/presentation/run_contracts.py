"""Contract-only routes used to generate the future workflow client."""

from typing import Annotated

from fastapi import APIRouter, Body, Path, Response, status
from fastapi.responses import JSONResponse

from snapflow.domain.run_contract import (
    ApprovalRequest,
    ClarificationAnswerRequest,
    CreateRunRequest,
    DeleteRunResponse,
    ErrorEnvelope,
    ExportRequest,
    ExportResponse,
    PublicError,
    PublicErrorCode,
    ResumeRunRequest,
    RunResponse,
)

RunPath = Annotated[
    str,
    Path(
        min_length=8,
        max_length=100,
        pattern=r"^run_[A-Za-z0-9_-]+$",
    ),
]

ERROR_RESPONSES: dict[int | str, dict[str, object]] = {
    status.HTTP_400_BAD_REQUEST: {"model": ErrorEnvelope},
    status.HTTP_401_UNAUTHORIZED: {"model": ErrorEnvelope},
    status.HTTP_404_NOT_FOUND: {"model": ErrorEnvelope},
    status.HTTP_409_CONFLICT: {"model": ErrorEnvelope},
    status.HTTP_422_UNPROCESSABLE_CONTENT: {"model": ErrorEnvelope},
    status.HTTP_429_TOO_MANY_REQUESTS: {"model": ErrorEnvelope},
    status.HTTP_500_INTERNAL_SERVER_ERROR: {"model": ErrorEnvelope},
    status.HTTP_501_NOT_IMPLEMENTED: {"model": ErrorEnvelope},
}

router = APIRouter(prefix="/api/runs", tags=["runs"])


def _not_implemented() -> JSONResponse:
    """Keep contract preview routes honest if invoked in isolation."""
    body = ErrorEnvelope(
        schema_version="1.0",
        error=PublicError(
            code=PublicErrorCode.NOT_IMPLEMENTED,
            message="This contract operation is not implemented yet.",
            retryable=False,
        ),
    )
    return JSONResponse(
        status_code=status.HTTP_501_NOT_IMPLEMENTED,
        content=body.model_dump(mode="json"),
    )


@router.post(
    "",
    operation_id="create_run",
    summary="Create run",
    response_model=RunResponse,
    status_code=status.HTTP_201_CREATED,
    responses=ERROR_RESPONSES,
)
async def create_run_contract(
    request: Annotated[CreateRunRequest, Body()],
) -> Response:
    """Describe creation without exposing the route in the runtime app."""
    del request
    return _not_implemented()


@router.post(
    "/{run_id}/resume",
    operation_id="resume_run",
    summary="Resume run",
    response_model=RunResponse,
    responses=ERROR_RESPONSES,
)
async def resume_run_contract(
    run_id: RunPath,
    request: Annotated[ResumeRunRequest, Body()],
) -> Response:
    """Describe checkpoint resume for the generated client."""
    del run_id, request
    return _not_implemented()


@router.post(
    "/{run_id}/clarifications",
    operation_id="answer_clarification",
    summary="Answer clarification",
    response_model=RunResponse,
    responses=ERROR_RESPONSES,
)
async def answer_clarification_contract(
    run_id: RunPath,
    request: Annotated[ClarificationAnswerRequest, Body()],
) -> Response:
    """Describe one typed clarification answer."""
    del run_id, request
    return _not_implemented()


@router.post(
    "/{run_id}/approval",
    operation_id="submit_approval",
    summary="Submit approval",
    response_model=RunResponse,
    responses=ERROR_RESPONSES,
)
async def submit_approval_contract(
    run_id: RunPath,
    request: Annotated[ApprovalRequest, Body()],
) -> Response:
    """Describe server-validated per-item approval."""
    del run_id, request
    return _not_implemented()


@router.post(
    "/{run_id}/exports",
    operation_id="export_run",
    summary="Export run",
    response_model=ExportResponse,
    responses=ERROR_RESPONSES,
)
async def export_run_contract(
    run_id: RunPath,
    request: Annotated[ExportRequest, Body()],
) -> Response:
    """Describe approved-only deterministic export."""
    del run_id, request
    return _not_implemented()


@router.delete(
    "/{run_id}",
    operation_id="delete_run",
    summary="Delete run",
    response_model=DeleteRunResponse,
    responses=ERROR_RESPONSES,
)
async def delete_run_contract(run_id: RunPath) -> Response:
    """Describe immediate online deletion."""
    del run_id
    return _not_implemented()
