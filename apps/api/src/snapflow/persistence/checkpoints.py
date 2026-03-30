"""PostgreSQL lifecycle for durable LangGraph checkpoints."""

from __future__ import annotations

from langgraph.checkpoint.postgres import PostgresSaver
from psycopg import Connection
from psycopg.rows import DictRow, dict_row
from psycopg_pool import ConnectionPool


def normalize_checkpoint_database_url(database_url: str) -> str:
    """Convert the SQLAlchemy psycopg URL into a native psycopg URL."""
    return database_url.replace("postgresql+psycopg://", "postgresql://", 1)


class PostgresCheckpointStore:
    """Own a small connection pool and the shared Postgres checkpointer."""

    def __init__(
        self,
        database_url: str,
        *,
        min_size: int = 1,
        max_size: int = 4,
    ) -> None:
        if min_size < 0 or max_size < 1 or min_size > max_size:
            message = "checkpoint pool sizes must satisfy 0 <= min_size <= max_size"
            raise ValueError(message)
        self._pool: ConnectionPool[Connection[DictRow]] = ConnectionPool(
            normalize_checkpoint_database_url(database_url),
            connection_class=Connection,
            kwargs={
                "autocommit": True,
                "prepare_threshold": 0,
                "row_factory": dict_row,
            },
            min_size=min_size,
            max_size=max_size,
            open=False,
            name="snapflow-checkpoints",
        )
        self.checkpointer = PostgresSaver(self._pool)
        self._started = False

    def setup(self) -> None:
        """Open the pool and apply the vendor checkpoint schema migrations."""
        if self._started:
            return
        try:
            self._pool.open(wait=True)
            self.checkpointer.setup()
        except Exception:
            self._pool.close()
            raise
        self._started = True

    def close(self) -> None:
        """Release pooled connections after the application lifespan ends."""
        if not self._started:
            return
        self._pool.close()
        self._started = False
