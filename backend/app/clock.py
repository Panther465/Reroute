"""The current time. With DEMO_LOGIN=true a trip can run on a simulated clock (section 16, demo clock);
production ignores it. Only services read the clock; the planner never does.
"""

from __future__ import annotations

from datetime import UTC, date, datetime, time, timedelta, timezone

from app.config import get_settings
from app.redis_client import get_redis


def tz_for(utc_offset: str) -> timezone:
    sign = -1 if utc_offset.startswith("-") else 1
    hours, minutes = utc_offset.lstrip("+-").split(":")
    return timezone(sign * timedelta(hours=int(hours), minutes=int(minutes)))


def demo_key(trip_id: str) -> str:
    return f"demo_now:{trip_id}"


def now_for(trip_id: str | None = None) -> datetime:
    if trip_id and get_settings().demo_login:
        stored = get_redis().get(demo_key(trip_id))
        if stored:
            return datetime.fromisoformat(stored)
    return datetime.now(UTC)


def set_demo_now(trip_id: str, now: datetime) -> None:
    get_redis().set(demo_key(trip_id), now.isoformat(), ex=7 * 24 * 3600)


def minutes_of_day(moment: datetime, day: date, tz: timezone) -> int:
    """Minutes from local midnight of `day`; negative or above 1440 when on another day."""
    local = moment.astimezone(tz)
    midnight = datetime.combine(day, time(0), tz)
    return int((local - midnight).total_seconds() // 60)


def at_minutes(day: date, minutes: int, tz: timezone) -> datetime:
    return datetime.combine(day, time(0), tz) + timedelta(minutes=minutes)
