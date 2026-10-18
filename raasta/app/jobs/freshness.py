"""Daily freshness check: run with `python -m app.jobs.freshness` (cron, or the worker's scheduler).

Verified routes with no confirmation for 90 days become stale and go back to the moderator queue.
"""

from __future__ import annotations

import logging
from datetime import UTC, datetime

from sqlalchemy.orm import Session

from app.db import get_engine
from app.services.community import mark_stale

log = logging.getLogger("raasta.freshness")


def main() -> None:
    logging.basicConfig(level=logging.INFO)
    with Session(get_engine()) as session:
        changed = mark_stale(session, datetime.now(UTC))
    log.info("marked %d routes stale: %s", len(changed), ", ".join(changed) or "none")


if __name__ == "__main__":
    main()
