"""The shared Redis connection. Tests replace it with fakeredis through `set_redis`."""

from __future__ import annotations

from redis import Redis

from app.config import get_settings

_client: Redis | None = None


def get_redis() -> Redis:
    global _client
    if _client is None:
        _client = Redis.from_url(get_settings().redis_url, decode_responses=True, socket_timeout=2, socket_connect_timeout=2)
    return _client


def set_redis(client: Redis | None) -> None:
    global _client
    _client = client
