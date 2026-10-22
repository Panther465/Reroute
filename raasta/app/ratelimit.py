"""Rate limits in Redis: 60 requests a minute per user (or per IP), 10 contributions a day per user.

Requests with the Reroute API's service token share one bucket of SERVICE_RATE_LIMIT_PER_MINUTE.
"""

from __future__ import annotations

import logging
import time

from fastapi import Depends, Request
from redis.exceptions import RedisError

from app.config import Settings, get_settings
from app.errors import ApiError
from app.redis_client import get_redis
from app.security import User, is_service_caller, optional_user

log = logging.getLogger("raasta")


def _hit(key: str, window_s: int) -> int:
    redis = get_redis()
    pipe = redis.pipeline()
    pipe.incr(key)
    pipe.expire(key, window_s, nx=True)
    count, _ = pipe.execute()
    return int(count)


def per_minute_limit(
    request: Request,
    user: User | None = Depends(optional_user),
    service: bool = Depends(is_service_caller),
    settings: Settings = Depends(get_settings),
) -> None:
    if service:
        who, limit = "svc:reroute", settings.service_rate_limit_per_minute
    else:
        who = f"u:{user.user_id}" if user else f"ip:{request.client.host if request.client else 'unknown'}"
        limit = settings.rate_limit_per_minute
    minute = int(time.time() // 60)
    try:
        count = _hit(f"rl:raasta:{who}:{minute}", 60)
    except RedisError:
        log.warning("rate limiter unavailable; allowing request")
        return
    if count > limit:
        raise ApiError(429, "RATE_LIMITED", "Too many requests. Wait a minute and try again.", {"Retry-After": str(60 - int(time.time()) % 60)})


def enforce_daily_contributions(user: User, day_key: str, limit: int) -> None:
    """Count one contribution for today; refuse the 11th."""
    try:
        count = _hit(f"rl:raasta:contrib:{user.user_id}:{day_key}", 24 * 60 * 60)
    except RedisError:
        log.warning("contribution limiter unavailable; allowing request")
        return
    if count > limit:
        raise ApiError(429, "RATE_LIMITED", f"You can add {limit} routes a day. Try again tomorrow.")
