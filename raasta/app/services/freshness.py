"""Freshness rules (project brief, section 12).

After 90 days without a confirmation a verified route becomes stale and goes back to
verification. A moderator, or two different riders confirming it, makes it verified again.
"""

from __future__ import annotations

from collections.abc import Iterable
from datetime import datetime, timedelta

STALE_AFTER_DAYS = 90
RIDERS_TO_REVERIFY = 2


def is_stale(last_confirmed_at: datetime | None, verified_since: datetime, now: datetime, days: int = STALE_AFTER_DAYS) -> bool:
    """A verified route is stale when nothing confirmed it for `days` days."""
    reference = last_confirmed_at or verified_since
    return now - reference >= timedelta(days=days)


def reverified_by_riders(confirmations_since_stale: Iterable[str], needed: int = RIDERS_TO_REVERIFY) -> bool:
    """True once enough different riders have confirmed a stale route."""
    return len(set(confirmations_since_stale)) >= needed
