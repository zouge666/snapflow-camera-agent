"""Application service for the basic approved-action calendar export."""

from dataclasses import dataclass
from datetime import date
from typing import Protocol

from snapflow.domain.ics_export import (
    ApprovedActionItem,
    IcsExportRequest,
    IcsExportResponse,
    IcsToolResult,
)


class IcsExportTool(Protocol):
    """Typed tool boundary available to the application layer."""

    def export(
        self,
        approved_items: tuple[ApprovedActionItem, ...],
        *,
        reference_date: date,
    ) -> IcsToolResult:
        """Return an in-memory calendar and any deterministic warnings."""
        ...


@dataclass(frozen=True, slots=True)
class ExportApprovedIcs:
    """Authorize only the already-typed approved item collection for export."""

    tool: IcsExportTool

    def execute(self, request: IcsExportRequest) -> IcsExportResponse:
        """Run the tool without creating a server-side file."""
        result = self.tool.export(
            request.approved_items,
            reference_date=request.reference_date,
        )
        return IcsExportResponse(
            schema_version="1.0",
            filename="snapflow-approved-actions.ics",
            content_type="text/calendar; charset=utf-8",
            content=result.content,
            exported_action_ids=result.exported_action_ids,
            warnings=result.warnings,
        )
