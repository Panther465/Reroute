"""Live updates as server-sent events (GET /v1/trips/:id/live).

Each API copy subscribes to the trip's Redis channel, so whichever copy holds the phone's
connection forwards the event. NGINX must not buffer this path (proxy_buffering off).
"""

from __future__ import annotations

import asyncio
import json

from fastapi import APIRouter, Request
from sse_starlette.sse import EventSourceResponse

from app.deps import OwnedTrip
from app.events import channel
from app.redis_client import get_async_redis

router = APIRouter(prefix="/v1", tags=["live"])


@router.get("/trips/{trip_id}/live", summary="Live updates (text/event-stream)", response_class=EventSourceResponse)
async def live(trip: OwnedTrip, request: Request) -> EventSourceResponse:
    trip_id = trip.trip_id

    async def stream():
        pubsub = get_async_redis().pubsub()
        await pubsub.subscribe(channel(trip_id))
        try:
            yield {"event": "ready", "data": json.dumps({"tripId": trip_id})}
            while not await request.is_disconnected():
                message = await pubsub.get_message(ignore_subscribe_messages=True, timeout=15.0)
                if message is None:
                    continue
                payload = json.loads(message["data"])
                yield {"event": payload["event"], "data": json.dumps(payload["data"] | {"at": payload["at"]})}
        except asyncio.CancelledError:
            raise
        finally:
            await pubsub.unsubscribe(channel(trip_id))
            await pubsub.aclose()

    return EventSourceResponse(stream(), ping=15, headers={"X-Accel-Buffering": "no", "Cache-Control": "no-cache"})
