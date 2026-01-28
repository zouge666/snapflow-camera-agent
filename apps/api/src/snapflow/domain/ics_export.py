"""Typed contracts for the basic approved-action calendar export."""

from datetime import date
from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field, StringConstraints

from snapflow.domain.action_plan import EvidenceRange

ApprovedTitle = Annotated[
    str,
    StringConstraints(strip_whitespace=True, min_length=1, max_length=240),
]
ApprovedOwner = Annotated[
    str,
    StringConstraints(strip_whitespace=True, min_length=1, max_length=120),
]


class ApprovedActionItem(BaseModel):
    """A reviewed item that is explicitly allowed to cross the tool boundary."""

    model_config = ConfigDict(extra="forbid", frozen=True)

    id: str = Field(pattern=r"^action-[1-9][0-9]*$")
    title: ApprovedTitle
    owner: ApprovedOwner | None
    due_date: date | None
    priority: Literal["low", "medium", "high", "unknown"]
    evidence: tuple[EvidenceRange, ...] = Field(min_length=1)
    decision: Literal["approved"]


class IcsExportRequest(BaseModel):
    """Reference date and approved items accepted by the demo export endpoint."""

    model_config = ConfigDict(extra="forbid", frozen=True)

    schema_version: Literal["1.0"] = "1.0"
    reference_date: date
    approved_items: tuple[ApprovedActionItem, ...]


class IcsExportWarning(BaseModel):
    """One deterministic reason an approved item was not exported."""

    model_config = ConfigDict(extra="forbid", frozen=True)

    action_id: str
    code: Literal["missing_due_date"]
    message: str


class IcsToolResult(BaseModel):
    """In-memory output returned by the deterministic calendar tool."""

    model_config = ConfigDict(extra="forbid", frozen=True)

    content: str
    exported_action_ids: tuple[str, ...]
    warnings: tuple[IcsExportWarning, ...]


class IcsExportResponse(IcsToolResult):
    """Download metadata and in-memory content returned over HTTP."""

    schema_version: Literal["1.0"] = "1.0"
    filename: Literal["snapflow-approved-actions.ics"] = "snapflow-approved-actions.ics"
    content_type: Literal["text/calendar; charset=utf-8"] = (
        "text/calendar; charset=utf-8"
    )
