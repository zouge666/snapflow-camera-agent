"""Alembic environment for SnapFlow's PostgreSQL schema."""

from logging.config import fileConfig

from alembic import context
from sqlalchemy import engine_from_config, pool

from snapflow.config import Settings
from snapflow.persistence.database import normalize_database_url
from snapflow.persistence.models import Base

config = context.config
if config.config_file_name is not None:
    fileConfig(config.config_file_name)

target_metadata = Base.metadata


def database_url() -> str:
    """Prefer a command override, then the validated application setting."""
    configured = config.get_main_option("sqlalchemy.url")
    if configured:
        return normalize_database_url(configured)
    settings = Settings.from_env()
    if settings.database_url is None:
        raise RuntimeError("DATABASE_URL is required to run migrations")
    return normalize_database_url(settings.database_url)


def run_migrations_offline() -> None:
    """Render migration SQL without opening a database connection."""
    context.configure(
        url=database_url(),
        target_metadata=target_metadata,
        literal_binds=True,
        dialect_opts={"paramstyle": "named"},
        compare_type=True,
    )
    with context.begin_transaction():
        context.run_migrations()


def run_migrations_online() -> None:
    """Apply migrations in one transactional PostgreSQL connection."""
    section = config.get_section(config.config_ini_section, {})
    section["sqlalchemy.url"] = database_url()
    connectable = engine_from_config(
        section,
        prefix="sqlalchemy.",
        poolclass=pool.NullPool,
    )
    with connectable.connect() as connection:
        context.configure(
            connection=connection,
            target_metadata=target_metadata,
            compare_type=True,
        )
        with context.begin_transaction():
            context.run_migrations()


if context.is_offline_mode():
    run_migrations_offline()
else:
    run_migrations_online()
