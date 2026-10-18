"""Cursor pagination: ?cursor=&limit=, with nextCursor in the response."""

from __future__ import annotations

import base64
import json
from typing import Any

from fastapi import Query

from app.errors import ApiError

DEFAULT_LIMIT = 20
MAX_LIMIT = 100


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
