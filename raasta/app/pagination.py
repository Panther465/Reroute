"""Cursor pagination: ?cursor=&limit=, with nextCursor in the response."""

from __future__ import annotations

import base64
import json
from datetime import datetime
from typing import Any

from fastapi import Query

from app.errors import ApiError

DEFAULT_LIMIT = 20
MAX_LIMIT = 100
#: The largest offset a cursor may carry.
MAX_OFFSET = 100_000


class Page:
    def __init__(self, cursor: str | None = Query(default=None, max_length=512), limit: int = Query(default=DEFAULT_LIMIT, ge=1, le=MAX_LIMIT)) -> None:
        self.limit = limit
        self.position = decode_cursor(cursor) if cursor else None


def encode_cursor(position: dict[str, Any]) -> str:
    return base64.urlsafe_b64encode(json.dumps(position, separators=(",", ":")).encode()).decode().rstrip("=")


def decode_cursor(cursor: str) -> dict[str, Any]:
    try:
        padded = cursor + "=" * (-len(cursor) % 4)
        value = json.loads(base64.urlsafe_b64decode(padded.encode()))
    except (ValueError, json.JSONDecodeError) as exc:
        raise ApiError(400, "BAD_REQUEST", "The cursor is not valid.") from exc
    if not isinstance(value, dict):
        raise ApiError(400, "BAD_REQUEST", "The cursor is not valid.")
    return value


def cursor_value(position: dict[str, Any], key: str, kind: type) -> Any:
    """One field of a decoded cursor: a timezone-aware datetime, an offset (int) or an ID (str).

    Cursors come from the caller, so a missing or malformed field is a 400, never a 500.
    """
    value = position.get(key)
    if kind is datetime and isinstance(value, str):
        try:
            parsed = datetime.fromisoformat(value)
        except ValueError:
            parsed = None
        if parsed is not None and parsed.tzinfo is not None:
            return parsed
    valid = {
        int: type(value) is int and 0 <= value <= MAX_OFFSET,
        str: isinstance(value, str) and 0 < len(value) <= 64,
    }
    if valid.get(kind, False):
        return value
    raise ApiError(400, "BAD_REQUEST", "The cursor is not valid.")
