"""Time helpers. Times of day are "HH:MM"; timestamps are ISO 8601 with the city's offset."""

from __future__ import annotations

from datetime import UTC, datetime, time, timedelta, timezone


def parse_offset(offset: str) -> timezone:
    sign = -1 if offset.startswith("-") else 1
    hours, minutes = offset.lstrip("+-").split(":")
    return timezone(sign * timedelta(hours=int(hours), minutes=int(minutes)))


def to_local_iso(value: datetime | None, offset: str) -> str | None:
    if value is None:
        return None
    if value.tzinfo is None:
        value = value.replace(tzinfo=UTC)
    return value.astimezone(parse_offset(offset)).isoformat(timespec="seconds")


def hhmm(value: time) -> str:
    return f"{value.hour:02d}:{value.minute:02d}"


def parse_hhmm(value: str) -> time:
    h, m = value.split(":")
    return time(int(h), int(m))


def minutes_of_day(value: time) -> int:
    return value.hour * 60 + value.minute


def local_minutes(at: datetime, offset: str) -> int:
    local = at.astimezone(parse_offset(offset)) if at.tzinfo else at
    return local.hour * 60 + local.minute
