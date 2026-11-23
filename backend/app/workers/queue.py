"""The Redis job queue (RQ). The API never plans inside a request: it enqueues, the worker plans."""

from __future__ import annotations

from rq import Queue

from app.config import get_settings
from app.redis_client import get_redis_bytes

QUEUE_NAME = "planning"
#: Drawing legs along the roads (leg_paths): a worker takes planning first, then this.
MAPS_QUEUE_NAME = "maps"
#: Account emails (workers/jobs.account_email): their own queue, so a slow mail server never holds up planning.
MAIL_QUEUE_NAME = "mail"


def get_queue() -> Queue:
    return Queue(QUEUE_NAME, connection=get_redis_bytes(), default_timeout=60, is_async=not get_settings().queue_sync)


def get_maps_queue() -> Queue:
    return Queue(MAPS_QUEUE_NAME, connection=get_redis_bytes(), default_timeout=300, is_async=not get_settings().queue_sync)


def get_mail_queue() -> Queue:
    return Queue(MAIL_QUEUE_NAME, connection=get_redis_bytes(), default_timeout=60, is_async=not get_settings().queue_sync)
