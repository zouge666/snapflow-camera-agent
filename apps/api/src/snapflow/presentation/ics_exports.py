"""HTTP route for the fixture-backed approved-action calendar export."""

from fastapi import APIRouter

from snapflow.application.export_ics import ExportApprovedIcs
from snapflow.domain.ics_export import IcsExportRequest, IcsExportResponse


def create_ics_export_router(export_approved_ics: ExportApprovedIcs) -> APIRouter:
    """Create a router with the application service injected."""
    router = APIRouter(prefix="/api/demo/exports", tags=["demo-exports"])

    @router.post("/ics", response_model=IcsExportResponse)
    async def export_ics(request: IcsExportRequest) -> IcsExportResponse:
        return export_approved_ics.execute(request)

    return router
