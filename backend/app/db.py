"""Database engine and sessions (SQLAlchemy 2, synchronous; FastAPI runs sync handlers in a thread pool)."""

from __future__ import annotations

from collections.abc import Iterator
from contextlib import contextmanager
from functools import lru_cache

from sqlalchemy import Engine, create_engine
from sqlalchemy.orm import DeclarativeBase, Session, sessionmaker

from app.config import get_settings


class Base(DeclarativeBase):
    pass


@lru_cache
def engine() -> Engine:
    return create_engine(get_settings().database_url, pool_pre_ping=True, pool_size=10, max_overflow=10)


@lru_cache
def _factory() -> sessionmaker[Session]:
    return sessionmaker(bind=engine(), expire_on_commit=False)


def get_session() -> Iterator[Session]:
    """FastAPI dependency: one session per request, committed by the handler's service calls."""
    with _factory()() as session:
        yield session


@contextmanager
def session_scope() -> Iterator[Session]:
    """For workers and scripts: commit on success, roll back on error."""
    with _factory()() as session:
        try:
            yield session
            session.commit()
        except Exception:
            session.rollback()
            raise
