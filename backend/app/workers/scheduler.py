"""The scheduler: every minute it finds trips with an active plan for today and, every 5 minutes per
trip, enqueues the automatic check. Run with: python -m app.workers.scheduler
"""

from __future__ import annotations

import logging
import time
from datetime import UTC, datetime, timedelta

from sqlalchemy import select

from app.clock import now_for, tz_for
from app.db import session_scope
from app.models import Plan, Trip
from app.redis_client import get_redis
from app.workers.jobs import five_minute_check
from app.workers.queue import get_queue

log = logging.getLogger("reroute.scheduler")
CHECK_EVERY_SECONDS = 5 * 60


def due_trips() -> list[str]:
    with session_scope() as db:
        # A day of slack either side covers every time zone; the exact check is per trip below.
        utc_today = datetime.now(UTC).date()
        rows = db.execute(
            select(Trip, Plan)
            .join(Plan, Plan.trip_id == Trip.trip_id)
            .where(Plan.status == "active", Trip.end_date >= utc_today - timedelta(days=1), Trip.start_date <= utc_today + timedelta(days=1))
        ).all()
        due = []
        for trip, plan in rows:
            local_today = now_for(trip.trip_id).astimezone(tz_for(trip.utc_offset)).date()
            # Only trips running today: finished and future trips aren't checked every minute.
            if trip.start_date <= local_today <= trip.end_date and plan.day == local_today:
                due.append(trip.trip_id)
        return due


def tick() -> int:
    r = get_redis()
    queued = 0
    for trip_id in due_trips():
        if r.set(f"check_lock:{trip_id}", datetime.now(UTC).isoformat(), nx=True, ex=CHECK_EVERY_SECONDS):
            get_queue().enqueue(five_minute_check, trip_id, job_id=f"check-{trip_id}-{int(time.time() // CHECK_EVERY_SECONDS)}")
            queued += 1
    return queued


def main() -> None:
    logging.basicConfig(level=logging.INFO)
    log.info("Scheduler started")
    while True:
        try:
            n = tick()
            if n:
                log.info("Queued %s checks", n)
        except Exception:  # keep the scheduler alive; the next tick retries
            log.exception("Scheduler tick failed")
        time.sleep(60)


if __name__ == "__main__":
    main()
