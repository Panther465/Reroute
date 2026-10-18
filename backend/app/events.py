"""Live events: one Redis pub/sub channel per trip, forwarded to the phone as server-sent events.

Events: plan_updated, options_ready, leave_now, checkin_recorded, trip_ended.
"""

from __future__ import annotations

import json
from datetime import UTC, datetime
from typing import Literal

from app.redis_client import get_redis

EventName = Literal["plan_updated", "options_ready", "leave_now", "checkin_recorded", "trip_ended"]


def channel(trip_id: str) -> str:
    return f"trip:{trip_id}"


def publish(trip_id: str, event: EventName, data: dict) -> None:
    r = get_redis()
    payload = json.dumps({"event": event, "data": data, "at": datetime.now(UTC).isoformat()}, default=str)
    r.publish(channel(trip_id), payload)
    r.set(f"trip_updated:{trip_id}", datetime.now(UTC).isoformat(), ex=7 * 24 * 3600)


def last_updated(trip_id: str) -> datetime | None:
    value = get_redis().get(f"trip_updated:{trip_id}")
    return datetime.fromisoformat(value) if value else None


def may_alert(trip_id: str, seconds: int = 15 * 60) -> bool:
    """Automatic shifts alert at most once every 15 minutes; the timeline always updates."""
    return bool(get_redis().set(f"alert_throttle:{trip_id}", "1", nx=True, ex=seconds))
