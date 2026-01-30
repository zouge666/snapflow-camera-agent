"""Compact HMAC-signed access tokens for anonymous guest sessions."""

from __future__ import annotations

import base64
import binascii
import hmac
import json
import secrets
from collections.abc import Callable
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from typing import Final, cast

TOKEN_VERSION: Final = 1


class InvalidGuestTokenError(ValueError):
    """Raised when a guest token cannot be trusted."""


@dataclass(frozen=True, slots=True)
class GuestPrincipal:
    """Verified identity and lifetime carried by a guest access token."""

    session_id: str
    issued_at: datetime
    expires_at: datetime


def _utc_now() -> datetime:
    return datetime.now(UTC)


def _encode(value: bytes) -> str:
    return base64.urlsafe_b64encode(value).rstrip(b"=").decode("ascii")


def _decode(value: str) -> bytes:
    padding = "=" * (-len(value) % 4)
    try:
        return base64.b64decode(
            f"{value}{padding}",
            altchars=b"-_",
            validate=True,
        )
    except (binascii.Error, ValueError) as error:
        raise InvalidGuestTokenError("Guest access token is invalid.") from error


class GuestTokenService:
    """Issue and verify a minimal, source-free bearer token."""

    def __init__(
        self,
        signing_key: bytes,
        access_ttl: timedelta,
        *,
        clock: Callable[[], datetime] = _utc_now,
        nonce: Callable[[], str] = lambda: secrets.token_urlsafe(12),
    ) -> None:
        if len(signing_key) < 32:
            message = "Guest token signing key must be at least 32 bytes."
            raise ValueError(message)
        if access_ttl <= timedelta(0):
            message = "Guest access-token TTL must be positive."
            raise ValueError(message)
        self._signing_key = signing_key
        self._access_ttl = access_ttl
        self._clock = clock
        self._nonce = nonce

    def issue(
        self,
        session_id: str,
        session_expires_at: datetime,
    ) -> tuple[str, GuestPrincipal]:
        """Create a token capped by the persistent guest-session lifetime."""
        now = self._aware_utc(self._clock())
        session_expiry = self._aware_utc(session_expires_at)
        expires_at = min(now + self._access_ttl, session_expiry)
        if expires_at <= now:
            raise InvalidGuestTokenError("Guest session has expired.")

        payload: dict[str, object] = {
            "exp": int(expires_at.timestamp()),
            "iat": int(now.timestamp()),
            "jti": self._nonce(),
            "sid": session_id,
            "v": TOKEN_VERSION,
        }
        encoded_payload = _encode(
            json.dumps(
                payload,
                separators=(",", ":"),
                sort_keys=True,
            ).encode("utf-8")
        )
        signature = hmac.digest(
            self._signing_key,
            encoded_payload.encode("ascii"),
            "sha256",
        )
        principal = GuestPrincipal(
            session_id=session_id,
            issued_at=now,
            expires_at=expires_at,
        )
        return f"{encoded_payload}.{_encode(signature)}", principal

    def verify(self, token: str) -> GuestPrincipal:
        """Authenticate a token and reject malformed or expired claims."""
        if not 16 <= len(token) <= 2_000:
            raise InvalidGuestTokenError("Guest access token is invalid.")
        try:
            encoded_payload, encoded_signature = token.split(".")
            payload_bytes = encoded_payload.encode("ascii")
        except (UnicodeEncodeError, ValueError) as error:
            raise InvalidGuestTokenError("Guest access token is invalid.") from error

        expected_signature = hmac.digest(
            self._signing_key,
            payload_bytes,
            "sha256",
        )
        supplied_signature = _decode(encoded_signature)
        if not hmac.compare_digest(expected_signature, supplied_signature):
            raise InvalidGuestTokenError("Guest access token is invalid.")

        try:
            raw_payload = json.loads(_decode(encoded_payload))
        except (json.JSONDecodeError, UnicodeDecodeError) as error:
            raise InvalidGuestTokenError("Guest access token is invalid.") from error
        if not isinstance(raw_payload, dict):
            raise InvalidGuestTokenError("Guest access token is invalid.")

        payload = cast(dict[str, object], raw_payload)
        if set(payload) != {"exp", "iat", "jti", "sid", "v"}:
            raise InvalidGuestTokenError("Guest access token is invalid.")
        sid = payload["sid"]
        issued = payload["iat"]
        expires = payload["exp"]
        nonce = payload["jti"]
        if (
            not isinstance(payload["v"], int)
            or isinstance(payload["v"], bool)
            or payload["v"] != TOKEN_VERSION
            or not isinstance(sid, str)
            or not sid.startswith("ses_")
            or not 8 <= len(sid) <= 100
            or not isinstance(nonce, str)
            or not nonce
            or len(nonce) > 100
            or not isinstance(issued, int)
            or isinstance(issued, bool)
            or not isinstance(expires, int)
            or isinstance(expires, bool)
        ):
            raise InvalidGuestTokenError("Guest access token is invalid.")

        try:
            issued_at = datetime.fromtimestamp(issued, UTC)
            expires_at = datetime.fromtimestamp(expires, UTC)
        except (OSError, OverflowError, ValueError) as error:
            raise InvalidGuestTokenError("Guest access token is invalid.") from error
        now = self._aware_utc(self._clock())
        if issued_at > now + timedelta(seconds=30) or expires_at <= now:
            raise InvalidGuestTokenError("Guest access token is invalid or expired.")
        if expires_at <= issued_at:
            raise InvalidGuestTokenError("Guest access token is invalid.")
        return GuestPrincipal(
            session_id=sid,
            issued_at=issued_at,
            expires_at=expires_at,
        )

    @staticmethod
    def _aware_utc(value: datetime) -> datetime:
        if value.tzinfo is None:
            message = "Guest-token timestamps must be timezone aware."
            raise ValueError(message)
        return value.astimezone(UTC)
