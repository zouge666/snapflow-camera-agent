"""Transactional repository for guest sessions and idempotent runs."""

from __future__ import annotations

import hashlib
import hmac
import json
import secrets
from collections.abc import Callable
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta

from sqlalchemy import delete, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session, sessionmaker

from snapflow.domain.run_contract import CreateRunRequest, RunStatus, RunView
from snapflow.persistence.models import (
    GuestSessionRecord,
    IdempotencyRecord,
    RunRecord,
)


class GuestSessionNotFoundError(LookupError):
    """Raised when the authenticated guest owner is gone or expired."""


class RunNotFoundError(LookupError):
    """Raised when a run is absent, expired, or owned by another guest."""


class IdempotencyConflictError(RuntimeError):
    """Raised when a key is reused for a different create payload."""


@dataclass(frozen=True, slots=True)
class GuestSession:
    """Small persistence-neutral view of a guest session."""

    id: str
    created_at: datetime
    expires_at: datetime


@dataclass(frozen=True, slots=True)
class CreatedRun:
    """Run result plus whether this request performed the insertion."""

    run: RunView
    created: bool


def _utc_now() -> datetime:
    return datetime.now(UTC)


class GuestRunRepository:
    """Enforce owner, TTL, cascade, and idempotency invariants in PostgreSQL."""

    def __init__(
        self,
        session_factory: sessionmaker[Session],
        fingerprint_key: bytes,
        *,
        guest_ttl: timedelta,
        run_ttl: timedelta,
        clock: Callable[[], datetime] = _utc_now,
        session_id: Callable[[], str] = lambda: f"ses_{secrets.token_urlsafe(18)}",
        run_id: Callable[[], str] = lambda: f"run_{secrets.token_urlsafe(18)}",
    ) -> None:
        self._session_factory = session_factory
        self._fingerprint_key = fingerprint_key
        self._guest_ttl = guest_ttl
        self._run_ttl = run_ttl
        self._clock = clock
        self._session_id = session_id
        self._run_id = run_id

    def create_guest_session(self) -> GuestSession:
        """Persist a new anonymous owner with no account or personal profile."""
        now = self._now()
        record = GuestSessionRecord(
            id=self._session_id(),
            created_at=now,
            expires_at=now + self._guest_ttl,
        )
        with self._session_factory.begin() as database:
            database.add(record)
        return self._session_view(record)

    def require_guest_session(self, session_id: str) -> GuestSession:
        """Return only a live session and remove expired state opportunistically."""
        now = self._now()
        result: GuestSession | None = None
        with self._session_factory.begin() as database:
            record = database.get(GuestSessionRecord, session_id)
            if record is None:
                raise GuestSessionNotFoundError
            if self._as_utc(record.expires_at) <= now:
                database.delete(record)
            else:
                result = self._session_view(record)
        if result is None:
            raise GuestSessionNotFoundError
        return result

    def create_run(
        self,
        session_id: str,
        idempotency_key: str,
        request: CreateRunRequest,
    ) -> CreatedRun:
        """Create at most one run for an owner/key/payload tuple."""
        request_hash = self._request_hash(request)
        try:
            return self._insert_run(
                session_id,
                idempotency_key,
                request_hash,
                request,
            )
        except IntegrityError as error:
            return self._resolve_concurrent_insert(
                session_id,
                idempotency_key,
                request_hash,
                error,
            )

    def get_owned_run(self, session_id: str, run_id: str) -> RunView:
        """Read a live run only when the authenticated guest owns it."""
        now = self._now()
        with self._session_factory.begin() as database:
            record = database.scalar(
                select(RunRecord).where(
                    RunRecord.id == run_id,
                    RunRecord.guest_session_id == session_id,
                    RunRecord.expires_at > now,
                )
            )
            if record is None:
                raise RunNotFoundError
            return self._run_view(record)

    def delete_expired(self) -> tuple[int, int]:
        """Delete expired sessions and runs; database cascades dependent rows."""
        now = self._now()
        with self._session_factory.begin() as database:
            run_ids = database.scalars(
                select(RunRecord.id).where(RunRecord.expires_at <= now)
            ).all()
            session_ids = database.scalars(
                select(GuestSessionRecord.id).where(
                    GuestSessionRecord.expires_at <= now
                )
            ).all()
            database.execute(delete(RunRecord).where(RunRecord.id.in_(run_ids)))
            database.execute(
                delete(GuestSessionRecord).where(GuestSessionRecord.id.in_(session_ids))
            )
            runs = len(run_ids)
            sessions = len(session_ids)
        return sessions, runs

    def _insert_run(
        self,
        session_id: str,
        idempotency_key: str,
        request_hash: str,
        request: CreateRunRequest,
    ) -> CreatedRun:
        now = self._now()
        with self._session_factory.begin() as database:
            guest = database.scalar(
                select(GuestSessionRecord)
                .where(
                    GuestSessionRecord.id == session_id,
                    GuestSessionRecord.expires_at > now,
                )
                .with_for_update()
            )
            if guest is None:
                raise GuestSessionNotFoundError

            existing = self._idempotency_record(
                database,
                session_id,
                idempotency_key,
            )
            if existing is not None:
                return self._existing_result(existing, request_hash)

            expires_at = min(
                now + self._run_ttl,
                self._as_utc(guest.expires_at),
            )
            run = RunRecord(
                id=self._run_id(),
                guest_session_id=session_id,
                schema_version=request.schema_version,
                status=RunStatus.RECEIVED.value,
                source_text=request.source_text,
                locale=request.locale,
                timezone=request.timezone,
                reference_date=request.reference_date,
                created_at=now,
                expires_at=expires_at,
            )
            database.add(run)
            database.flush()
            database.add(
                IdempotencyRecord(
                    guest_session_id=session_id,
                    scope="create_run",
                    idempotency_key=idempotency_key,
                    request_hash=request_hash,
                    run_id=run.id,
                    created_at=now,
                )
            )
            database.flush()
            return CreatedRun(run=self._run_view(run), created=True)

    def _resolve_concurrent_insert(
        self,
        session_id: str,
        idempotency_key: str,
        request_hash: str,
        original_error: IntegrityError,
    ) -> CreatedRun:
        with self._session_factory() as database:
            existing = self._idempotency_record(
                database,
                session_id,
                idempotency_key,
            )
            if existing is None:
                raise original_error
            return self._existing_result(existing, request_hash)

    @staticmethod
    def _idempotency_record(
        database: Session,
        session_id: str,
        idempotency_key: str,
    ) -> IdempotencyRecord | None:
        return database.scalar(
            select(IdempotencyRecord).where(
                IdempotencyRecord.guest_session_id == session_id,
                IdempotencyRecord.scope == "create_run",
                IdempotencyRecord.idempotency_key == idempotency_key,
            )
        )

    def _existing_result(
        self,
        existing: IdempotencyRecord,
        request_hash: str,
    ) -> CreatedRun:
        if not hmac.compare_digest(existing.request_hash, request_hash):
            raise IdempotencyConflictError
        return CreatedRun(run=self._run_view(existing.run), created=False)

    def _request_hash(self, request: CreateRunRequest) -> str:
        canonical = json.dumps(
            request.model_dump(mode="json"),
            separators=(",", ":"),
            sort_keys=True,
        ).encode("utf-8")
        return hmac.new(
            self._fingerprint_key,
            canonical,
            hashlib.sha256,
        ).hexdigest()

    @staticmethod
    def _session_view(record: GuestSessionRecord) -> GuestSession:
        return GuestSession(
            id=record.id,
            created_at=GuestRunRepository._as_utc(record.created_at),
            expires_at=GuestRunRepository._as_utc(record.expires_at),
        )

    @staticmethod
    def _run_view(record: RunRecord) -> RunView:
        return RunView(
            schema_version="1.0",
            run_id=record.id,
            status=RunStatus(record.status),
            candidate_items=(),
            clarification_questions=(),
            clarification_count=0,
            safe_trace=(),
            created_at=GuestRunRepository._as_utc(record.created_at),
            expires_at=GuestRunRepository._as_utc(record.expires_at),
        )

    def _now(self) -> datetime:
        return self._as_utc(self._clock())

    @staticmethod
    def _as_utc(value: datetime) -> datetime:
        if value.tzinfo is None:
            message = "Persistence timestamps must be timezone aware."
            raise ValueError(message)
        return value.astimezone(UTC)
