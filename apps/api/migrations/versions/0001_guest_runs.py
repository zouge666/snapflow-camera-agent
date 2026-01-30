"""Create short-lived guest sessions and idempotent runs.

Revision ID: 0001_guest_runs
Revises:
Create Date: 2026-09-06
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0001_guest_runs"
down_revision: str | None = None
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    """Create the first durable guest-run schema."""
    op.create_table(
        "guest_sessions",
        sa.Column("id", sa.String(length=100), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(
        op.f("ix_guest_sessions_expires_at"),
        "guest_sessions",
        ["expires_at"],
        unique=False,
    )
    op.create_table(
        "runs",
        sa.Column("id", sa.String(length=100), nullable=False),
        sa.Column("guest_session_id", sa.String(length=100), nullable=False),
        sa.Column("schema_version", sa.String(length=10), nullable=False),
        sa.Column("status", sa.String(length=64), nullable=False),
        sa.Column("source_text", sa.Text(), nullable=False),
        sa.Column("locale", sa.String(length=64), nullable=False),
        sa.Column("timezone", sa.String(length=128), nullable=False),
        sa.Column("reference_date", sa.Date(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(
            ["guest_session_id"],
            ["guest_sessions.id"],
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(
        op.f("ix_runs_expires_at"),
        "runs",
        ["expires_at"],
        unique=False,
    )
    op.create_index(
        op.f("ix_runs_guest_session_id"),
        "runs",
        ["guest_session_id"],
        unique=False,
    )
    op.create_table(
        "run_idempotency",
        sa.Column("id", sa.Integer(), autoincrement=True, nullable=False),
        sa.Column("guest_session_id", sa.String(length=100), nullable=False),
        sa.Column("scope", sa.String(length=64), nullable=False),
        sa.Column("idempotency_key", sa.String(length=128), nullable=False),
        sa.Column("request_hash", sa.String(length=64), nullable=False),
        sa.Column("run_id", sa.String(length=100), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(
            ["guest_session_id"],
            ["guest_sessions.id"],
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(["run_id"], ["runs.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("run_id"),
        sa.UniqueConstraint(
            "guest_session_id",
            "scope",
            "idempotency_key",
            name="uq_run_idempotency_owner_scope_key",
        ),
    )
    op.create_index(
        op.f("ix_run_idempotency_guest_session_id"),
        "run_idempotency",
        ["guest_session_id"],
        unique=False,
    )


def downgrade() -> None:
    """Remove guest-run state in reverse dependency order."""
    op.drop_index(
        op.f("ix_run_idempotency_guest_session_id"),
        table_name="run_idempotency",
    )
    op.drop_table("run_idempotency")
    op.drop_index(op.f("ix_runs_guest_session_id"), table_name="runs")
    op.drop_index(op.f("ix_runs_expires_at"), table_name="runs")
    op.drop_table("runs")
    op.drop_index(op.f("ix_guest_sessions_expires_at"), table_name="guest_sessions")
    op.drop_table("guest_sessions")
