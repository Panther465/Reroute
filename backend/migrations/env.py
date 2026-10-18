"""Alembic environment for the Reroute tables (public schema only; Raasta migrates its own schema)."""

from __future__ import annotations

from alembic import context
from sqlalchemy import create_engine, pool

import app.models  # noqa: F401  (registers the tables)
from app.config import get_settings
from app.db import Base

target_metadata = Base.metadata


def include_object(obj, name, type_, reflected, compare_to):
    # Leave PostGIS's own tables and everything outside the public schema alone.
    return not (type_ == "table" and (name in ("spatial_ref_sys",) or getattr(obj, "schema", None) not in (None, "public")))


def run_migrations_offline() -> None:
    context.configure(url=get_settings().database_url, target_metadata=target_metadata, literal_binds=True, include_object=include_object)
    with context.begin_transaction():
        context.run_migrations()


def run_migrations_online() -> None:
    engine = create_engine(get_settings().database_url, poolclass=pool.NullPool)
    with engine.connect() as connection:
        context.configure(connection=connection, target_metadata=target_metadata, include_object=include_object)
        with context.begin_transaction():
            context.run_migrations()


if context.is_offline_mode():
    run_migrations_offline()
else:
    run_migrations_online()
