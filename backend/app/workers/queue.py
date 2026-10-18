"""The Redis job queue (RQ). The API never plans inside a request: it enqueues, the worker plans."""

from __future__ import annotations

from rq import Queue

from app.config import get_settings
from app.redis_client import get_redis_bytes

QUEUE_NAME = "planning"


def get_queue() -> Queue:
    return Queue(QUEUE_NAME, connection=get_redis_bytes(), default_timeout=60, is_async=not get_settings().queue_sync)
