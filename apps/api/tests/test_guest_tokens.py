"""Unit tests for minimal signed guest access tokens."""

import base64
import json
from datetime import UTC, datetime, timedelta

import pytest

from snapflow.security.guest_tokens import (
    GuestTokenService,
    InvalidGuestTokenError,
)

pytestmark = pytest.mark.unit
KEY = bytes.fromhex("11" * 32)
FIXED_TEST_TIME = datetime(2026, 1, 15, 10, tzinfo=UTC)


class Clock:
    """Mutable deterministic UTC clock."""

    def __init__(self) -> None:
        self.now = FIXED_TEST_TIME

    def __call__(self) -> datetime:
        return self.now


def service(clock: Clock) -> GuestTokenService:
    return GuestTokenService(
        KEY,
        timedelta(minutes=30),
        clock=clock,
        nonce=lambda: "public-nonce",
    )


def test_token_round_trip_contains_only_minimal_claims() -> None:
    clock = Clock()
    tokens = service(clock)

    token, issued = tokens.issue(
        "ses_test-owner",
        clock.now + timedelta(hours=24),
    )
    verified = tokens.verify(token)
    payload_segment = token.split(".")[0]
    payload = json.loads(
        base64.urlsafe_b64decode(
            f"{payload_segment}{'=' * (-len(payload_segment) % 4)}"
        )
    )

    assert verified == issued
    assert set(payload) == {"exp", "iat", "jti", "sid", "v"}
    assert "source" not in token
    assert "Alex will ship" not in token


def test_token_is_capped_by_session_expiry_and_can_be_refreshed() -> None:
    clock = Clock()
    tokens = service(clock)
    session_expiry = clock.now + timedelta(minutes=35)

    first, _ = tokens.issue("ses_test-owner", session_expiry)
    clock.now += timedelta(minutes=10)
    second, refreshed = tokens.issue("ses_test-owner", session_expiry)

    assert first != second
    assert refreshed.expires_at == session_expiry


def test_tampered_expired_future_and_malformed_tokens_are_rejected() -> None:
    clock = Clock()
    tokens = service(clock)
    token, _ = tokens.issue(
        "ses_test-owner",
        clock.now + timedelta(hours=1),
    )

    with pytest.raises(InvalidGuestTokenError):
        tokens.verify(f"{token[:-1]}A")

    clock.now += timedelta(minutes=31)
    with pytest.raises(InvalidGuestTokenError, match="expired"):
        tokens.verify(token)

    future_clock = Clock()
    future_clock.now -= timedelta(minutes=10)
    with pytest.raises(InvalidGuestTokenError):
        service(future_clock).verify(token)

    for invalid in (
        "",
        "one-part",
        "a.b.c",
        "@@.@@" + ("x" * 20),
        f"{'é' * 20}.{'A' * 43}",
        "a" * 2_001,
    ):
        with pytest.raises(InvalidGuestTokenError):
            tokens.verify(invalid)


def test_token_service_rejects_unsafe_configuration_and_naive_time() -> None:
    with pytest.raises(ValueError, match="at least 32"):
        GuestTokenService(b"short", timedelta(minutes=1))
    with pytest.raises(ValueError, match="positive"):
        GuestTokenService(KEY, timedelta(0))

    naive = GuestTokenService(
        KEY,
        timedelta(minutes=1),
        clock=lambda: FIXED_TEST_TIME.replace(tzinfo=None),
    )
    with pytest.raises(ValueError, match="timezone aware"):
        naive.issue("ses_test-owner", FIXED_TEST_TIME + timedelta(days=1))
