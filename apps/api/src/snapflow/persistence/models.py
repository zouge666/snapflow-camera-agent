"""SQLAlchemy models for short-lived guest workflow state."""

from __future__ import annotations

from datetime import date, datetime

from sqlalchemy import Date, DateTime, ForeignKey, String, Text, UniqueConstraint
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column, relationship


class Base(DeclarativeBase):
    """Metadata root shared with Alembic."""


class GuestSessionRecord(Base):
    """Anonymous owner with a bounded lifetime."""

    __tablename__ = "guest_sessions"

    id: Mapped[str] = mapped_column(String(100), primary_key=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    expires_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        index=True,
    )
    runs: Mapped[list[RunRecord]] = relationship(
        back_populates="guest_session",
        cascade="all, delete-orphan",
        passive_deletes=True,
    )


class RunRecord(Base):
    """User-confirmed text retained only for the configured run TTL."""

    __tablename__ = "runs"

    id: Mapped[str] = mapped_column(String(100), primary_key=True)
    guest_session_id: Mapped[str] = mapped_column(
        ForeignKey("guest_sessions.id", ondelete="CASCADE"),
        index=True,
    )
    schema_version: Mapped[str] = mapped_column(String(10))
    status: Mapped[str] = mapped_column(String(64))
    source_text: Mapped[str] = mapped_column(Text)
    locale: Mapped[str] = mapped_column(String(64))
    timezone: Mapped[str] = mapped_column(String(128))
    reference_date: Mapped[date] = mapped_column(Date)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    expires_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        index=True,
    )
    guest_session: Mapped[GuestSessionRecord] = relationship(back_populates="runs")
    idempotency_records: Mapped[list[IdempotencyRecord]] = relationship(
        back_populates="run",
        cascade="all, delete-orphan",
        passive_deletes=True,
    )


class IdempotencyRecord(Base):
    """One request fingerprint mapped to the run created for it."""

    __tablename__ = "run_idempotency"
    __table_args__ = (
        UniqueConstraint(
            "guest_session_id",
            "scope",
            "idempotency_key",
            name="uq_run_idempotency_owner_scope_key",
        ),
    )

    id: Mapped[int] = mapped_column(primary_key=True, autoincrement=True)
    guest_session_id: Mapped[str] = mapped_column(
        ForeignKey("guest_sessions.id", ondelete="CASCADE"),
        index=True,
    )
    scope: Mapped[str] = mapped_column(String(64))
    idempotency_key: Mapped[str] = mapped_column(String(128))
    request_hash: Mapped[str] = mapped_column(String(64))
    run_id: Mapped[str] = mapped_column(
        ForeignKey("runs.id", ondelete="CASCADE"),
        unique=True,
    )
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    run: Mapped[RunRecord] = relationship(back_populates="idempotency_records")
