"""PostgreSQL integration tests for migrations and guest-run invariants."""

from __future__ import annotations

import os
import secrets
from collections.abc import Iterator
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from datetime import UTC, date, datetime, timedelta
from pathlib import Path
from typing import NoReturn

import pytest
from alembic import command
from alembic.config import Config
from fastapi.testclient import TestClient
from langgraph.checkpoint.memory import InMemorySaver
from sqlalchemy import Engine, create_engine, delete, func, inspect, select
from sqlalchemy.engine import URL, make_url
from sqlalchemy.exc import OperationalError
from sqlalchemy.orm import Session, sessionmaker

from snapflow.application.build_plan import BuildActionPlan
from snapflow.application.guest_runs import GuestRunService
from snapflow.config import Settings
from snapflow.domain.action_plan import ActionPlanRequest, ActionPlanResponse
from snapflow.domain.ics_export import ApprovedActionItem
from snapflow.domain.run_contract import CreateRunRequest, RunStatus
from snapflow.main import create_app
from snapflow.persistence.checkpoints import PostgresCheckpointStore
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
from snapflow.providers.base import ProviderTimeoutError
from snapflow.providers.mock import MockProvider
from snapflow.security.guest_tokens import GuestTokenService
from snapflow.workflow.graph import (
    WorkflowCheckpointError,
    create_action_extraction_workflow,
)
from snapflow.workflow.state import WorkflowLimits
from test_action_plan_contract import sample_payload

pytestmark = pytest.mark.integration
API_ROOT = Path(__file__).parents[1]
KEY = bytes.fromhex("22" * 32)
FIXED_TEST_TIME = datetime(2026, 1, 15, 10, tzinfo=UTC)
FIXED_REFERENCE_DATE = date(2026, 1, 15)


@dataclass(slots=True)
class Clock:
    now: datetime = FIXED_TEST_TIME

    def __call__(self) -> datetime:
        return self.now


@dataclass(frozen=True, slots=True)
class DatabaseHarness:
    url: str
    engine: Engine
    sessions: sessionmaker[Session]
    alembic: Config


class CountingMockProvider:
    """Delegate to the deterministic adapter while recording call count."""

    def __init__(self) -> None:
        self.calls = 0
        self._delegate = MockProvider()

    def extract_actions(self, request: ActionPlanRequest) -> ActionPlanResponse:
        self.calls += 1
        return self._delegate.extract_actions(request)


class AlwaysTimeoutProvider:
    """Expose retry calls while returning only the safe provider taxonomy."""

    def __init__(self) -> None:
        self.calls = 0

    def extract_actions(self, request: ActionPlanRequest) -> ActionPlanResponse:
        del request
        self.calls += 1
        raise ProviderTimeoutError


class FailIfCalledIcsTool:
    """Prove a failed workflow cannot cross the export tool boundary."""

    def __init__(self) -> None:
        self.calls = 0

    def export(
        self,
        approved_items: tuple[ApprovedActionItem, ...],
        *,
        reference_date: date,
    ) -> NoReturn:
        del approved_items, reference_date
        self.calls += 1
        raise AssertionError("export must not run during extraction")


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
        reference_date=FIXED_REFERENCE_DATE,
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
        encoded_payload, encoded_signature = token.split(".")
        replacement = "A" if encoded_signature[0] != "A" else "B"
        tampered_token = f"{encoded_payload}.{replacement}{encoded_signature[1:]}"
        tampered = client.post(
            "/api/guest-sessions/refresh",
            headers={"authorization": f"Bearer {tampered_token}"},
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


def _durable_settings(database: DatabaseHarness) -> Settings:
    return Settings(
        app_env="test",
        model_provider="mock",
        database_url=database.url,
        guest_token_signing_key=KEY.hex(),
        guest_session_ttl_hours=24,
        guest_access_token_ttl_minutes=30,
        run_ttl_hours=12,
    )


def test_postgres_checkpoint_survives_restart_and_duplicate_resume(
    database: DatabaseHarness,
    caplog: pytest.LogCaptureFixture,
) -> None:
    provider = CountingMockProvider()
    settings = _durable_settings(database)
    sensitive_text = "PRIVATE-CHECKPOINT-CANARY Alex will prepare release notes."
    payload = request(sensitive_text).model_dump(mode="json")

    with TestClient(
        create_app(settings, action_extraction_provider=provider)
    ) as first_client:
        session = first_client.post("/api/guest-sessions").json()
        headers = {
            "authorization": f"Bearer {session['access_token']}",
            "idempotency-key": "create-run:durable-restart",
        }
        created = first_client.post("/api/runs", headers=headers, json=payload)

    assert created.status_code == 201
    created_run = created.json()["run"]
    assert created_run["status"] == "interrupted_for_approval"
    assert created_run["safe_trace"][-1]["outcome"] == "interrupted"
    assert provider.calls == 1

    with TestClient(
        create_app(settings, action_extraction_provider=provider)
    ) as restarted_client:
        resume_payload = {
            "schema_version": "1.0",
            "last_seen_trace_sequence": created_run["safe_trace"][-1]["sequence"],
        }
        resumed = restarted_client.post(
            f"/api/runs/{created_run['run_id']}/resume",
            headers={"authorization": headers["authorization"]},
            json=resume_payload,
        )
        duplicate = restarted_client.post(
            f"/api/runs/{created_run['run_id']}/resume",
            headers={"authorization": headers["authorization"]},
            json=resume_payload,
        )
        stranger = restarted_client.post("/api/guest-sessions").json()
        wrong_owner = restarted_client.post(
            f"/api/runs/{created_run['run_id']}/resume",
            headers={"authorization": f"Bearer {stranger['access_token']}"},
            json=resume_payload,
        )

    assert resumed.status_code == 200
    assert duplicate.status_code == 200
    assert resumed.json()["run"] == created_run
    assert duplicate.json() == resumed.json()
    assert wrong_owner.status_code == 404
    assert wrong_owner.json()["error"]["code"] == "run_not_found"
    assert provider.calls == 1
    assert sensitive_text not in caplog.text
    checkpoint_tables = {
        "checkpoint_blobs",
        "checkpoint_migrations",
        "checkpoint_writes",
        "checkpoints",
    }
    assert checkpoint_tables <= set(inspect(database.engine).get_table_names())


def test_clarification_answer_resumes_after_refresh_without_creating_a_run(
    database: DatabaseHarness,
    caplog: pytest.LogCaptureFixture,
) -> None:
    provider = CountingMockProvider()
    settings = _durable_settings(database)
    payload = {"schema_version": "1.0", **sample_payload()}

    with TestClient(
        create_app(settings, action_extraction_provider=provider)
    ) as first_client:
        session = first_client.post("/api/guest-sessions").json()
        authorization = f"Bearer {session['access_token']}"
        created_response = first_client.post(
            "/api/runs",
            headers={
                "authorization": authorization,
                "idempotency-key": "create-run:clarification-refresh",
            },
            json=payload,
        )

    assert created_response.status_code == 201
    created = created_response.json()["run"]
    assert created["status"] == "interrupted_for_clarification"
    assert created["run_id"].startswith("run_")
    assert created["clarification_count"] == 0
    assert created["clarification_questions"] == [
        {
            "id": "clarification-1",
            "field_path": "candidate_items[1].due_date",
            "question": "What date is the pilot review for the support FAQ deadline?",
            "reason": (
                "The pilot review deadline cannot be resolved to an ISO date from "
                "this text alone."
            ),
            "answer_kind": "free_text",
            "options": [],
            "evidence": {
                "quote": "before the pilot review",
                "start": 133,
                "end": 156,
            },
        }
    ]
    assert provider.calls == 1

    with TestClient(
        create_app(settings, action_extraction_provider=provider)
    ) as restarted_client:
        refreshed = restarted_client.post(
            f"/api/runs/{created['run_id']}/resume",
            headers={"authorization": authorization},
            json={"schema_version": "1.0"},
        )
        invalid = restarted_client.post(
            f"/api/runs/{created['run_id']}/clarifications",
            headers={"authorization": authorization},
            json={
                "schema_version": "1.0",
                "clarification_id": "clarification-1",
                "kind": "free_text",
                "answer": "ANSWER-CANARY sometime later",
            },
        )
        answered = restarted_client.post(
            f"/api/runs/{created['run_id']}/clarifications",
            headers={"authorization": authorization},
            json={
                "schema_version": "1.0",
                "clarification_id": "clarification-1",
                "kind": "free_text",
                "answer": "ANSWER-CANARY 2026-01-22",
            },
        )
        duplicate = restarted_client.post(
            f"/api/runs/{created['run_id']}/clarifications",
            headers={"authorization": authorization},
            json={
                "schema_version": "1.0",
                "clarification_id": "clarification-1",
                "kind": "free_text",
                "answer": "2026-01-22",
            },
        )
        stranger = restarted_client.post("/api/guest-sessions").json()
        wrong_owner = restarted_client.post(
            f"/api/runs/{created['run_id']}/clarifications",
            headers={"authorization": f"Bearer {stranger['access_token']}"},
            json={
                "schema_version": "1.0",
                "clarification_id": "clarification-1",
                "kind": "free_text",
                "answer": "2026-01-22",
            },
        )

    assert refreshed.status_code == 200
    assert refreshed.json()["run"] == created
    assert invalid.status_code == 422
    assert invalid.json()["error"]["code"] == "invalid_request"
    assert answered.status_code == 200
    answered_run = answered.json()["run"]
    assert answered_run["run_id"] == created["run_id"]
    assert answered_run["status"] == "interrupted_for_approval"
    assert answered_run["clarification_count"] == 1
    assert answered_run["clarification_questions"] == []
    assert answered_run["candidate_items"][1]["due_date"] == "2026-01-22"
    assert duplicate.status_code == 409
    assert wrong_owner.status_code == 404
    assert provider.calls == 1
    with database.sessions() as database_session:
        run_count = database_session.scalar(select(func.count()).select_from(RunRecord))
    assert run_count == 1
    assert "ANSWER-CANARY" not in caplog.text
    assert all(
        set(event)
        <= {
            "sequence",
            "node",
            "outcome",
            "occurred_at",
            "duration_ms",
            "provider",
            "model_alias",
            "prompt_version",
            "schema_version",
            "retry_count",
            "input_tokens",
            "output_tokens",
            "tool_name",
            "tool_succeeded",
        }
        for event in answered_run["safe_trace"]
    )


def test_server_approval_is_owned_audited_idempotent_and_survives_restart(
    database: DatabaseHarness,
) -> None:
    provider = CountingMockProvider()
    tool = FailIfCalledIcsTool()
    settings = _durable_settings(database)
    source_text = (
        "Alex: Send the revised onboarding checklist by Friday.\n"
        "Mina: Book a 30-minute pilot review on 2026-01-22."
    )
    payload = request(source_text).model_dump(mode="json")
    approval_payload = {
        "schema_version": "1.0",
        "decisions": [
            {
                "action_id": "action-1",
                "decision": "approve",
                "reviewed": {
                    "title": "Send the final onboarding checklist",
                    "owner": "Alex",
                    "due_date": "2026-01-17",
                    "priority": "high",
                },
            },
            {"action_id": "action-3", "decision": "reject", "reviewed": None},
        ],
    }

    with TestClient(
        create_app(
            settings,
            action_extraction_provider=provider,
            ics_export_tool=tool,
        )
    ) as first_client:
        session = first_client.post("/api/guest-sessions").json()
        authorization = f"Bearer {session['access_token']}"
        created_response = first_client.post(
            "/api/runs",
            headers={
                "authorization": authorization,
                "idempotency-key": "create-run:approval",
            },
            json=payload,
        )
        created = created_response.json()["run"]
        invalid = first_client.post(
            f"/api/runs/{created['run_id']}/approval",
            headers={
                "authorization": authorization,
                "idempotency-key": "approve-run:invalid",
            },
            json={
                "schema_version": "1.0",
                "decisions": [
                    {
                        "action_id": "action-99",
                        "decision": "approve",
                        "reviewed": None,
                    }
                ],
            },
        )
        still_waiting = first_client.post(
            f"/api/runs/{created['run_id']}/resume",
            headers={"authorization": authorization},
            json={"schema_version": "1.0"},
        )
        approved = first_client.post(
            f"/api/runs/{created['run_id']}/approval",
            headers={
                "authorization": authorization,
                "idempotency-key": "approve-run:accepted",
            },
            json=approval_payload,
        )
        repeated = first_client.post(
            f"/api/runs/{created['run_id']}/approval",
            headers={
                "authorization": authorization,
                "idempotency-key": "approve-run:accepted",
            },
            json=approval_payload,
        )
        changed_retry = first_client.post(
            f"/api/runs/{created['run_id']}/approval",
            headers={
                "authorization": authorization,
                "idempotency-key": "approve-run:accepted",
            },
            json={
                **approval_payload,
                "decisions": [
                    {"action_id": "action-1", "decision": "reject", "reviewed": None},
                    {"action_id": "action-3", "decision": "reject", "reviewed": None},
                ],
            },
        )
        stranger = first_client.post("/api/guest-sessions").json()
        wrong_owner = first_client.post(
            f"/api/runs/{created['run_id']}/approval",
            headers={
                "authorization": f"Bearer {stranger['access_token']}",
                "idempotency-key": "approve-run:accepted",
            },
            json=approval_payload,
        )

    assert created_response.status_code == 201
    assert created["status"] == "interrupted_for_approval"
    assert created["approval_decisions"] == []
    assert invalid.status_code == 422
    assert still_waiting.json()["run"]["status"] == "interrupted_for_approval"
    assert approved.status_code == 200
    approved_run = approved.json()["run"]
    assert approved_run["status"] == "approval_received"
    assert approved_run["approval_decisions"] == [
        {
            "action_id": "action-1",
            "decision": "approve",
            "reviewed": {
                "title": "Send the final onboarding checklist",
                "owner": "Alex",
                "due_date": "2026-01-17",
                "priority": "high",
            },
            "audit_diff": [
                {
                    "field": "title",
                    "before": "Send the revised onboarding checklist",
                    "after": "Send the final onboarding checklist",
                },
                {
                    "field": "due_date",
                    "before": "2026-01-16",
                    "after": "2026-01-17",
                },
                {"field": "priority", "before": "unknown", "after": "high"},
            ],
        },
        {
            "action_id": "action-3",
            "decision": "reject",
            "reviewed": None,
            "audit_diff": [],
        },
    ]
    assert repeated.json() == approved.json()
    assert changed_retry.status_code == 409
    assert wrong_owner.status_code == 404
    assert provider.calls == 1
    assert tool.calls == 0

    with TestClient(
        create_app(
            settings,
            action_extraction_provider=provider,
            ics_export_tool=tool,
        )
    ) as restarted_client:
        resumed = restarted_client.post(
            f"/api/runs/{created['run_id']}/resume",
            headers={"authorization": authorization},
            json={"schema_version": "1.0"},
        )

    assert resumed.json()["run"] == approved_run
    assert provider.calls == 1
    assert tool.calls == 0


def test_expired_approval_interrupt_cannot_be_consumed(
    database: DatabaseHarness,
) -> None:
    clock = Clock()
    runs = repository(database, clock)
    tokens = GuestTokenService(KEY, timedelta(hours=24), clock=clock)
    workflow = create_action_extraction_workflow(
        BuildActionPlan(CountingMockProvider()),
        WorkflowLimits(),
        checkpointer=InMemorySaver(),
        clock=clock,
    )
    service = GuestRunService(repository=runs, tokens=tokens, workflow=workflow)
    app = create_app(
        Settings(app_env="test", model_provider="mock"),
        guest_run_service=service,
    )

    with TestClient(app) as client:
        session = client.post("/api/guest-sessions").json()
        authorization = f"Bearer {session['access_token']}"
        created = client.post(
            "/api/runs",
            headers={
                "authorization": authorization,
                "idempotency-key": "create-run:expired-approval",
            },
            json=request().model_dump(mode="json"),
        ).json()["run"]
        clock.now += timedelta(hours=13)
        expired = client.post(
            f"/api/runs/{created['run_id']}/approval",
            headers={
                "authorization": authorization,
                "idempotency-key": "approve-run:expired",
            },
            json={"schema_version": "1.0", "decisions": []},
        )

    assert expired.status_code == 404
    assert expired.json()["error"]["code"] == "run_not_found"


def test_resume_reports_a_missing_checkpoint_without_starting_work(
    database: DatabaseHarness,
) -> None:
    settings = _durable_settings(database)
    provider = CountingMockProvider()
    with TestClient(
        create_app(settings, action_extraction_provider=provider)
    ) as client:
        session = client.post("/api/guest-sessions").json()
        orphaned = GuestRunRepository(
            database.sessions,
            KEY,
            guest_ttl=timedelta(hours=24),
            run_ttl=timedelta(hours=12),
        ).create_run(
            session["guest_session_id"],
            "create-run:missing-checkpoint",
            request(),
        )
        response = client.post(
            f"/api/runs/{orphaned.run.run_id}/resume",
            headers={"authorization": f"Bearer {session['access_token']}"},
            json={"schema_version": "1.0"},
        )

    assert response.status_code == 409
    assert response.json()["error"]["code"] == "run_conflict"
    assert provider.calls == 0


def test_expired_run_blocks_checkpoint_load(
    database: DatabaseHarness,
) -> None:
    clock = Clock()
    runs = repository(database, clock)
    tokens = GuestTokenService(KEY, timedelta(hours=24), clock=clock)
    provider = CountingMockProvider()
    store = PostgresCheckpointStore(database.url)
    workflow = create_action_extraction_workflow(
        BuildActionPlan(provider),
        WorkflowLimits(),
        checkpointer=store.checkpointer,
        clock=clock,
    )
    service = GuestRunService(repository=runs, tokens=tokens, workflow=workflow)
    app = create_app(
        Settings(app_env="test", model_provider="mock"),
        guest_run_service=service,
        checkpoint_store=store,
    )

    with TestClient(app) as client:
        session = client.post("/api/guest-sessions").json()
        created = client.post(
            "/api/runs",
            headers={
                "authorization": f"Bearer {session['access_token']}",
                "idempotency-key": "create-run:expired-checkpoint",
            },
            json=request().model_dump(mode="json"),
        ).json()["run"]
        clock.now += timedelta(hours=13)
        expired = client.post(
            f"/api/runs/{created['run_id']}/resume",
            headers={"authorization": f"Bearer {session['access_token']}"},
            json={"schema_version": "1.0"},
        )

    assert expired.status_code == 404
    assert expired.json()["error"]["code"] == "run_not_found"
    assert provider.calls == 1


def test_checkpoint_write_failure_leaves_persisted_run_received(
    database: DatabaseHarness,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    clock = Clock()
    runs = repository(database, clock)
    tokens = GuestTokenService(KEY, timedelta(hours=1), clock=clock)
    saver = InMemorySaver()

    def fail_write(*args: object, **kwargs: object) -> NoReturn:
        del args, kwargs
        raise OSError("private checkpoint write detail")

    monkeypatch.setattr(saver, "put", fail_write)
    workflow = create_action_extraction_workflow(
        BuildActionPlan(CountingMockProvider()),
        WorkflowLimits(),
        checkpointer=saver,
        clock=clock,
    )
    service = GuestRunService(repository=runs, tokens=tokens, workflow=workflow)
    session = service.create_session()

    with pytest.raises(WorkflowCheckpointError) as raised:
        service.create_run(
            session.access_token,
            "create-run:checkpoint-failure",
            request("PRIVATE-WRITE-CANARY Alex will prepare release notes."),
        )

    assert "PRIVATE-WRITE-CANARY" not in str(raised.value)
    with database.sessions() as database_session:
        stored_status = database_session.scalar(select(RunRecord.status))
    assert stored_status == RunStatus.RECEIVED.value


def test_retry_exhaustion_is_safe_and_never_invokes_an_export_tool(
    database: DatabaseHarness,
) -> None:
    provider = AlwaysTimeoutProvider()
    tool = FailIfCalledIcsTool()
    app = create_app(
        _durable_settings(database),
        action_extraction_provider=provider,
        ics_export_tool=tool,
    )

    with TestClient(app) as client:
        session = client.post("/api/guest-sessions").json()
        response = client.post(
            "/api/runs",
            headers={
                "authorization": f"Bearer {session['access_token']}",
                "idempotency-key": "create-run:retry-limit",
            },
            json=request("PRIVATE-FAILURE-CANARY").model_dump(mode="json"),
        )

    assert response.status_code == 503
    assert response.json()["error"] == {
        "code": "provider_unavailable",
        "message": "The action workflow could not produce a recoverable result.",
        "request_id": None,
        "retryable": False,
        "details": [],
    }
    assert provider.calls == 3
    assert tool.calls == 0
    with database.sessions() as database_session:
        stored_status = database_session.scalar(select(RunRecord.status))
    assert stored_status == RunStatus.FATAL_FAILURE.value
