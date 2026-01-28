"""Pure, deterministic serializer for the basic approved-action ICS export."""

from datetime import date

from snapflow.domain.ics_export import (
    ApprovedActionItem,
    IcsExportWarning,
    IcsToolResult,
)

_CRLF = "\r\n"


def _escape_text(value: str) -> str:
    """Escape the text separators used by the minimal fixture-backed export."""
    normalized = value.replace("\r\n", "\n").replace("\r", "\n")
    return (
        normalized.replace("\\", "\\\\")
        .replace("\n", "\\n")
        .replace(";", "\\;")
        .replace(",", "\\,")
    )


def _event_lines(
    item: ApprovedActionItem,
    due_date: date,
    *,
    reference_date: date,
) -> list[str]:
    lines = [
        "BEGIN:VEVENT",
        f"UID:{item.id}-{due_date:%Y%m%d}@demo.snapflow.local",
        f"DTSTAMP:{reference_date:%Y%m%d}T000000Z",
        f"DTSTART;VALUE=DATE:{due_date:%Y%m%d}",
        f"SUMMARY:{_escape_text(item.title)}",
    ]
    if item.owner is not None:
        lines.append(f"DESCRIPTION:Owner: {_escape_text(item.owner)}")
    lines.append("END:VEVENT")
    return lines


class IcsExporter:
    """Generate an RFC 5545-shaped calendar entirely in memory."""

    def export(
        self,
        approved_items: tuple[ApprovedActionItem, ...],
        *,
        reference_date: date,
    ) -> IcsToolResult:
        """Serialize dated approved items and report undated items."""
        lines = [
            "BEGIN:VCALENDAR",
            "VERSION:2.0",
            "PRODID:-//SnapFlow//Basic approved action export//EN",
            "CALSCALE:GREGORIAN",
            "METHOD:PUBLISH",
        ]
        exported_action_ids: list[str] = []
        warnings: list[IcsExportWarning] = []

        for item in approved_items:
            if item.due_date is None:
                warnings.append(
                    IcsExportWarning(
                        action_id=item.id,
                        code="missing_due_date",
                        message=(
                            f"{item.id} was skipped because no approved date is "
                            "available."
                        ),
                    )
                )
                continue

            lines.extend(
                _event_lines(
                    item,
                    item.due_date,
                    reference_date=reference_date,
                )
            )
            exported_action_ids.append(item.id)

        lines.append("END:VCALENDAR")
        return IcsToolResult(
            content=_CRLF.join(lines) + _CRLF,
            exported_action_ids=tuple(exported_action_ids),
            warnings=tuple(warnings),
        )
