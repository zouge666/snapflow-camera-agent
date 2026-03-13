"""Explicit locale, timezone, and reference-date context for date rules."""

from dataclasses import dataclass
from datetime import date
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError


class InvalidTimezoneError(ValueError):
    """The supplied timezone is not an available IANA timezone."""

    def __init__(self) -> None:
        super().__init__("timezone must be a valid IANA timezone")


def validate_timezone_name(value: str) -> str:
    """Return a trimmed IANA timezone name without consulting server defaults."""
    normalized = value.strip()
    if not normalized:
        raise InvalidTimezoneError
    try:
        ZoneInfo(normalized)
    except (ValueError, ZoneInfoNotFoundError) as error:
        raise InvalidTimezoneError from error
    return normalized


@dataclass(frozen=True, slots=True)
class DateContext:
    """The only context from which a relative calendar date may be resolved."""

    locale: str
    timezone: ZoneInfo
    reference_date: date

    @classmethod
    def create(
        cls,
        *,
        locale: str,
        timezone: str,
        reference_date: date,
    ) -> "DateContext":
        normalized_locale = locale.strip()
        if not normalized_locale:
            raise ValueError("locale must contain non-whitespace text")
        timezone_name = validate_timezone_name(timezone)
        return cls(
            locale=normalized_locale,
            timezone=ZoneInfo(timezone_name),
            reference_date=reference_date,
        )

    @property
    def language(self) -> str:
        """Return the lower-case BCP-47 language subtag used by finite rules."""
        return self.locale.replace("_", "-").split("-", maxsplit=1)[0].lower()
