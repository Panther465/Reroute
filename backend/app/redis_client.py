"""Redis connections: a text client for handlers and workers, a bytes client for RQ, an async client for live streams."""

from __future__ import annotations

from functools import lru_cache

import redis
import redis.asyncio as aioredis

from app.config import get_settings

_override: redis.Redis | None = None
_override_bytes: redis.Redis | None = None


def use_clients(text_client: redis.Redis | None, bytes_client: redis.Redis | None = None) -> None:
    """Tests swap in in-memory clients here."""
    global _override, _override_bytes
    _override, _override_bytes = text_client, bytes_client


@lru_cache
def _text() -> redis.Redis:
    return redis.Redis.from_url(get_settings().redis_url, decode_responses=True)


@lru_cache
def _bytes() -> redis.Redis:
    return redis.Redis.from_url(get_settings().redis_url)


def get_redis() -> redis.Redis:
    return _override or _text()


def get_redis_bytes() -> redis.Redis:
    """RQ stores pickled job data, so its connection must not decode responses."""
    return _override_bytes or _bytes()


@lru_cache
def get_async_redis() -> aioredis.Redis:
    return aioredis.Redis.from_url(get_settings().redis_url, decode_responses=True)
