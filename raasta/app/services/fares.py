"""The fare a route shows: the most common accepted fare reported in the last 30 days.

On a tie the newer report wins. With no recent reports the route keeps its own fare.
"""

from __future__ import annotations

from collections.abc import Iterable
from datetime import datetime, timedelta

FARE_WINDOW_DAYS = 30


def current_fare(reports: Iterable[tuple[int, datetime]], now: datetime, fallback: int, window_days: int = FARE_WINDOW_DAYS) -> int:
    since = now - timedelta(days=window_days)
    counts: dict[int, int] = {}
    newest: dict[int, datetime] = {}
    for fare, at in reports:
        if at < since or at > now:
            continue
        counts[fare] = counts.get(fare, 0) + 1
        if fare not in newest or at > newest[fare]:
            newest[fare] = at
    if not counts:
        return fallback
    return max(counts, key=lambda f: (counts[f], newest[f]))
