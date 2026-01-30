"""PostgreSQL integration tests for migrations and guest-run invariants."""

from __future__ import annotations

import os
import secrets
from collections.abc import Iterator
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from datetime import UTC, date, datetime, timedelta
from pathlib import Path

import pytest
from alembic import command
from alembic.config import Config
from fastapi.testclient import TestClient
from sqlalchemy import Engine, create_engine, delete, func, inspect, select
from sqlalchemy.engine import URL, make_url
from sqlalchemy.exc import OperationalError
from sqlalchemy.orm import Session, sessionmaker

from snapflow.application.guest_runs import GuestRunService
from snapflow.config import Settings
from snapflow.domain.run_contract import CreateRunRequest
from snapflow.main import create_app
from snapflow.persistence.database import (
    create_database_engine,
    create_session_factory,
)
from snapflow.persistence.guest_runs import (
    GuestRunRepository,
    GuestSessionNotFoundError,
    IdempotencyConflictError,
    RunNotFoundError,
)
from snapflow.persistence.models import (
    GuestSessionRecord,
    IdempotencyRecord,
    RunRecord,
)
from snapflow.security.guest_tokens import GuestTokenService

pytestmark = pytest.mark.integration
API_ROOT = Path(__file__).parents[1]
KEY = bytes.fromhex("22" * 32)


@dataclass(slots=True)
class Clock:
    now: datetime = datetime(2026, 9, 6, 10, tzinfo=UTC)

    def __call__(self) -> datetime:
        return self.now


@dataclass(frozen=True, slots=True)
class DatabaseHarness:
    url: str
    engine: Engine
    sessions: sessionmaker[Session]
    alembic: Config


def _base_database_url() -> str:
    return os.environ.get(
        "TEST_DATABASE_URL",
        os.environ.get(
            "DATABASE_URL",
            "postgresql+psycopg://snapflow:snapflow-local-only@127.0.0.1:5432/snapflow",
        ),
    )


def _admin_url(url: URL) -> URL:
    return url.set(database="postgres")


@pytest.fixture
def database() -> Iterator[DatabaseHarness]:
    base_url = make_url(_base_database_url())
    database_name = f"snapflow_test_{secrets.token_hex(6)}"
    admin = create_engine(_admin_url(base_url), isolation_level="AUTOCOMMIT")
    try:
        with admin.connect() as connection:
            connection.exec_driver_sql(f'CREATE DATABASE "{database_name}"')
    except OperationalError as error:
        admin.dispose()
        pytest.skip(f"PostgreSQL integration service is unavailable: {error}")

    test_url = base_url.set(database=database_name).render_as_string(
        hide_password=False
    )
    config = Config(str(API_ROOT / "alembic.ini"))
    config.set_main_option("sqlalchemy.url", test_url.replace("%", "%%"))
    engine = create_database_engine(test_url)
    try:
        command.upgrade(config, "head")
        yield DatabaseHarness(
            url=test_url,
            engine=engine,
            sessions=create_session_factory(engine),
            alembic=config,
        )
    finally:
        engine.dispose()
        with admin.connect() as connection:
            connection.exec_driver_sql(f'DROP DATABASE IF EXISTS "{database_name}"')
        admin.dispose()


def request(text: str = "Alex will prepare the release notes.") -> CreateRunRequest:
    return CreateRunRequest(
        schema_version="1.0",
        source_text=text,
        locale="en-US",
        timezone="Europe/Copenhagen",
        reference_date=date(2026, 9, 6),
    )


def repository(
    database: DatabaseHarness,
    clock: Clock,
) -> GuestRunRepository:
    return GuestRunRepository(
        database.sessions,
        KEY,
        guest_ttl=timedelta(hours=24),
        run_ttl=timedelta(hours=12),
        clock=clock,
    )


def test_clean_migration_round_trip(database: DatabaseHarness) -> None:
    expected = {"alembic_version", "guest_sessions", "run_idempotency", "runs"}
    assert set(inspect(database.engine).get_table_names()) == expected

    command.downgrade(database.alembic, "base")
    assert inspect(database.engine).get_table_names() == ["alembic_version"]
    command.upgrade(database.alembic, "head")
    assert set(inspect(database.engine).get_table_names()) == expected


def test_run_round_trip_enforces_owner_utc_expiry_and_idempotency(
    database: DatabaseHarness,
) -> None:
    clock = Clock()
    runs = repository(database, clock)
    owner = runs.create_guest_session()
    stranger = runs.create_guest_session()

    first = runs.create_run(owner.id, "create-run:round-trip", request())
    repeated = runs.create_run(owner.id, "create-run:round-trip", request())

    assert first.created is True
    assert repeated.created is False
    assert repeated.run.run_id == first.run.run_id
    assert first.run.created_at.tzinfo is UTC
    assert first.run.expires_at == clock.now + timedelta(hours=12)
    assert runs.get_owned_run(owner.id, first.run.run_id) == first.run
    with pytest.raises(RunNotFoundError):
        runs.get_owned_run(stranger.id, first.run.run_id)
    with pytest.raises(IdempotencyConflictError):
        runs.create_run(
            owner.id,
            "create-run:round-trip",
            request("Mina will prepare a different brief."),
        )

    with database.sessions() as session:
        stored = session.get(RunRecord, first.run.run_id)
        assert stored is not None
        assert stored.source_text == request().source_text
        fingerprint = session.scalar(select(IdempotencyRecord.request_hash))
        assert fingerprint is not None
        assert request().source_text not in fingerprint


def test_concurrent_same_key_creates_one_run(database: DatabaseHarness) -> None:
    clock = Clock()
    runs = repository(database, clock)
    owner = runs.create_guest_session()

    with ThreadPoolExecutor(max_workers=2) as executor:
        results = list(
            executor.map(
                lambda _: runs.create_run(
                    owner.id,
                    "create-run:concurrent",
                    request(),
                ),
                range(2),
            )
        )

    assert len({result.run.run_id for result in results}) == 1
    assert sorted(result.created for result in results) == [False, True]
    with database.sessions() as session:
        assert session.scalar(select(func.count()).select_from(RunRecord)) == 1
        assert session.scalar(select(func.count()).select_from(IdempotencyRecord)) == 1


def test_expired_state_is_unavailable_and_deleted_with_cascades(
    database: DatabaseHarness,
) -> None:
    clock = Clock()
    runs = repository(database, clock)
    guest = runs.create_guest_session()
    created = runs.create_run(guest.id, "create-run:expiry", request())

    clock.now += timedelta(hours=13)
    with pytest.raises(RunNotFoundError):
        runs.get_owned_run(guest.id, created.run.run_id)
    assert runs.delete_expired() == (0, 1)

    second_guest = runs.create_guest_session()
    runs.create_run(second_guest.id, "create-run:cascade", request())
    with database.sessions.begin() as session:
        session.execute(
            delete(GuestSessionRecord).where(GuestSessionRecord.id == second_guest.id)
        )
    with database.sessions() as session:
        assert session.scalar(select(func.count()).select_from(RunRecord)) == 0
        assert session.scalar(select(func.count()).select_from(IdempotencyRecord)) == 0


def test_expired_guest_is_removed_and_cannot_create_runs(
    database: DatabaseHarness,
) -> None:
    clock = Clock()
    runs = repository(database, clock)
    guest = runs.create_guest_session()
    clock.now += timedelta(hours=25)

    with pytest.raises(GuestSessionNotFoundError):
        runs.require_guest_session(guest.id)
    with database.sessions() as session:
        assert session.get(GuestSessionRecord, guest.id) is None
    with pytest.raises(GuestSessionNotFoundError):
        runs.create_run(guest.id, "create-run:expired", request())


def _api_client(database: DatabaseHarness, clock: Clock) -> TestClient:
    runs = repository(database, clock)
    tokens = GuestTokenService(
        KEY,
        timedelta(minutes=30),
        clock=clock,
    )
    service = GuestRunService(repository=runs, tokens=tokens)
    app = create_app(
        Settings(app_env="test", model_provider="mock"),
        guest_run_service=service,
    )
    return TestClient(app)


def test_guest_session_refresh_and_idempotent_run_http_boundary(
    database: DatabaseHarness,
    caplog: pytest.LogCaptureFixture,
) -> None:
    clock = Clock()
    sensitive_text = "PRIVATE-CANARY Alex will prepare the release notes."
    payload = request(sensitive_text).model_dump(mode="json")

    with _api_client(database, clock) as client:
        session_response = client.post("/api/guest-sessions")
        assert session_response.status_code == 201
        session = session_response.json()
        assert session["guest_session_id"].startswith("ses_")
        assert sensitive_text not in session["access_token"]

        refresh_response = client.post(
            "/api/guest-sessions/refresh",
            headers={"authorization": f"Bearer {session['access_token']}"},
        )
        assert refresh_response.status_code == 200
        refreshed = refresh_response.json()
        assert refreshed["guest_session_id"] == session["guest_session_id"]

        headers = {
            "authorization": f"Bearer {refreshed['access_token']}",
            "idempotency-key": "create-run:http-test",
        }
        first = client.post("/api/runs", headers=headers, json=payload)
        second = client.post("/api/runs", headers=headers, json=payload)
        conflict = client.post(
            "/api/runs",
            headers=headers,
            json={**payload, "source_text": "A different reviewed request."},
        )

    assert first.status_code == 201
    assert second.status_code == 200
    assert second.json()["run"]["run_id"] == first.json()["run"]["run_id"]
    assert conflict.status_code == 409
    assert conflict.json()["error"]["code"] == "run_conflict"
    assert sensitive_text not in caplog.text


def test_guest_http_boundary_rejects_missing_tampered_and_expired_credentials(
    database: DatabaseHarness,
) -> None:
    clock = Clock()
    with _api_client(database, clock) as client:
        missing = client.post(
            "/api/runs",
            headers={"idempotency-key": "create-run:no-auth"},
            json=request().model_dump(mode="json"),
        )
        session = client.post("/api/guest-sessions").json()
        token = session["access_token"]
        tampered = client.post(
            "/api/guest-sessions/refresh",
            headers={"authorization": f"Bearer {token[:-1]}x"},
        )
        clock.now += timedelta(minutes=31)
        expired = client.post(
            "/api/guest-sessions/refresh",
            headers={"authorization": f"Bearer {token}"},
        )

    assert missing.status_code == 401
    assert tampered.status_code == 401
    assert expired.status_code == 401
    assert missing.json()["error"]["code"] == "unauthorized"
