"""Database engine construction kept at the infrastructure boundary."""

from sqlalchemy import Engine, create_engine
from sqlalchemy.orm import Session, sessionmaker


def normalize_database_url(database_url: str) -> str:
    """Select psycopg 3 when a generic PostgreSQL URL is supplied."""
    if database_url.startswith("postgresql://"):
        return database_url.replace("postgresql://", "postgresql+psycopg://", 1)
    return database_url


def create_database_engine(database_url: str) -> Engine:
    """Build the shared synchronous engine used by FastAPI worker threads."""
    return create_engine(
        normalize_database_url(database_url),
        pool_pre_ping=True,
    )


def create_session_factory(engine: Engine) -> sessionmaker[Session]:
    """Return transaction-scoped ORM sessions without hidden commits."""
    return sessionmaker(bind=engine, expire_on_commit=False)
