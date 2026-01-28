"""Unit tests for the typed, deterministic in-memory ICS tool."""

import builtins
from datetime import date
from typing import Never

import pytest
from icalendar import Calendar
from pydantic import ValidationError

from snapflow.application.export_ics import ExportApprovedIcs
from snapflow.domain.action_plan import EvidenceRange
from snapflow.domain.ics_export import (
    ApprovedActionItem,
    IcsExportRequest,
)
from snapflow.tools.ics import IcsExporter

pytestmark = pytest.mark.unit


def approved_item(
    *,
    action_id: str,
    title: str,
    owner: str | None,
    due_date: date | None,
) -> ApprovedActionItem:
    """Build one explicit approved-item boundary value."""
    return ApprovedActionItem(
        id=action_id,
        title=title,
        owner=owner,
        due_date=due_date,
        priority="unknown",
        evidence=(EvidenceRange(quote=title, start=0, end=len(title)),),
        decision="approved",
    )


def test_tool_exports_only_typed_approved_dated_items_without_writing_files(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    items = (
        approved_item(
            action_id="action-1",
            title=r"Send checklist, confirm scope; keep \ notes",
            owner="Alex",
            due_date=date(2026, 7, 17),
        ),
        approved_item(
            action_id="action-2",
            title="Prepare the support FAQ",
            owner=None,
            due_date=None,
        ),
        approved_item(
            action_id="action-3",
            title="Book the pilot review",
            owner=None,
            due_date=date(2026, 7, 22),
        ),
    )

    def reject_file_access(*_args: object, **_kwargs: object) -> Never:
        raise AssertionError("the ICS tool attempted file access")

    monkeypatch.setattr(builtins, "open", reject_file_access)
    exporter = IcsExporter()
    first = exporter.export(items, reference_date=date(2026, 7, 16))
    second = exporter.export(items, reference_date=date(2026, 7, 16))

    assert first == second
    assert first.exported_action_ids == ("action-1", "action-3")
    assert [warning.action_id for warning in first.warnings] == ["action-2"]
    assert first.warnings[0].code == "missing_due_date"
    assert "action-2 was skipped" in first.warnings[0].message
    assert first.content.startswith("BEGIN:VCALENDAR\r\n")
    assert first.content.endswith("END:VCALENDAR\r\n")
    assert first.content.count("BEGIN:VEVENT") == 2
    assert "SUMMARY:Prepare the support FAQ" not in first.content

    calendar = Calendar.from_ical(first.content.encode("utf-8"))
    events = list(calendar.walk("VEVENT"))

    assert calendar["VERSION"] == "2.0"
    assert len(events) == 2
    assert str(events[0]["SUMMARY"]) == r"Send checklist, confirm scope; keep \ notes"
    assert str(events[0]["DESCRIPTION"]) == "Owner: Alex"
    assert events[0].decoded("DTSTART") == date(2026, 7, 17)
    assert events[1].decoded("DTSTART") == date(2026, 7, 22)
    assert "DESCRIPTION" not in events[1]


def test_contract_rejects_items_that_are_not_explicitly_approved() -> None:
    payload = approved_item(
        action_id="action-1",
        title="Send checklist",
        owner="Alex",
        due_date=date(2026, 7, 17),
    ).model_dump(mode="json")
    payload["decision"] = "rejected"

    with pytest.raises(ValidationError, match="approved"):
        ApprovedActionItem.model_validate(payload)


def test_application_returns_download_metadata_for_an_empty_valid_calendar() -> None:
    request = IcsExportRequest(
        reference_date=date(2026, 7, 16),
        approved_items=(
            approved_item(
                action_id="action-2",
                title="Prepare the support FAQ",
                owner=None,
                due_date=None,
            ),
        ),
    )

    response = ExportApprovedIcs(tool=IcsExporter()).execute(request)
    calendar = Calendar.from_ical(response.content.encode("utf-8"))

    assert response.schema_version == "1.0"
    assert response.filename == "snapflow-approved-actions.ics"
    assert response.content_type == "text/calendar; charset=utf-8"
    assert response.exported_action_ids == ()
    assert len(response.warnings) == 1
    assert list(calendar.walk("VEVENT")) == []
