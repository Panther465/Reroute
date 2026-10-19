"""Live updates as server-sent events (GET /v1/trips/:id/live).

Each API copy subscribes to the trip's Redis channel, so whichever copy holds the phone's
connection forwards the event. NGINX must not buffer this path (proxy_buffering off).

The stream holds no database connection: ownership is checked with a short session that closes
before streaming starts, and each traveller may keep only a few streams open at once.
"""

from __future__ import annotations

import asyncio
import json
import time
import uuid
from typing import Annotated

from fastapi import APIRouter, Header, Request
from sse_starlette.sse import EventSourceResponse

from app.db import session_scope
from app.errors import ApiError
from app.events import channel
from app.models import Trip, User
from app.redis_client import get_async_redis, get_redis
from app.security import decode_access_token

router = APIRouter(prefix="/v1", tags=["live"])

MAX_STREAMS_PER_USER = 4
#: Each open stream renews its slot on every heartbeat (at most 15 s apart). A slot not renewed for
#: a minute belongs to a stream that is gone (a closed tab, a crashed process) and stops counting.
SLOT_STALE_SECONDS = 60


def _check_owner(trip_id: str, authorization: str | None) -> str:
    if not authorization or not authorization.lower().startswith("bearer "):
        raise ApiError(401, "Sign in to continue.", headers={"WWW-Authenticate": "Bearer"})
    claims = decode_access_token(authorization[7:])
    with session_scope() as db:
        user = db.get(User, claims["sub"])
        trip = db.get(Trip, trip_id)
        if user is None:
            raise ApiError(401, "Sign in to continue.")
        if trip is None or (trip.user_id != user.user_id and user.role != "admin"):
            raise ApiError(404, "Trip not found.")
        return user.user_id


@router.get("/trips/{trip_id}/live", summary="Live updates (text/event-stream)", response_class=EventSourceResponse)
async def live(trip_id: str, request: Request, authorization: Annotated[str | None, Header()] = None) -> EventSourceResponse:
    user_id = await asyncio.to_thread(_check_owner, trip_id, authorization)
    r = get_redis()
    # A new key name: earlier releases kept a plain counter under "streams:{user}".
    slots = f"live_slots:{user_id}"
    slot = uuid.uuid4().hex
    now = time.time()
    r.zremrangebyscore(slots, 0, now - SLOT_STALE_SECONDS)
    if r.zcard(slots) >= MAX_STREAMS_PER_USER:
        raise ApiError(429, "Too many live connections. Close another Reroute tab and try again.", headers={"Retry-After": "30"})
    r.zadd(slots, {slot: now})
    r.expire(slots, SLOT_STALE_SECONDS * 2)

    async def stream():
        pubsub = get_async_redis().pubsub()
        await pubsub.subscribe(channel(trip_id))
        try:
            yield {"event": "ready", "data": json.dumps({"tripId": trip_id})}
            while not await request.is_disconnected():
                r.zadd(slots, {slot: time.time()})
                r.expire(slots, SLOT_STALE_SECONDS * 2)
                message = await pubsub.get_message(ignore_subscribe_messages=True, timeout=15.0)
                if message is None:
                    continue
                payload = json.loads(message["data"])
                yield {"event": payload["event"], "data": json.dumps(payload["data"] | {"at": payload["at"]})}
        finally:
            r.zrem(slots, slot)
            await pubsub.unsubscribe(channel(trip_id))
            await pubsub.aclose()

    return EventSourceResponse(stream(), ping=15, headers={"X-Accel-Buffering": "no", "Cache-Control": "no-cache"})
