"""The scheduler: every minute it finds trips with an active plan for today and, every 5 minutes per
trip, enqueues the automatic check. Run with: python -m app.workers.scheduler
"""

from __future__ import annotations

import logging
import time
from datetime import UTC, datetime

from sqlalchemy import select

from app.clock import now_for
from app.db import session_scope
from app.models import Plan, Trip
from app.redis_client import get_redis
from app.services.day import trip_day
from app.workers.jobs import five_minute_check
from app.workers.queue import get_queue

log = logging.getLogger("reroute.scheduler")
CHECK_EVERY_SECONDS = 5 * 60


def due_trips() -> list[str]:
    with session_scope() as db:
        rows = db.execute(select(Trip, Plan).join(Plan, Plan.trip_id == Trip.trip_id).where(Plan.status == "active")).all()
        due = []
        for trip, plan in rows:
            now = now_for(trip.trip_id)
            if trip.start_date <= now.date() <= trip.end_date or trip_day(trip, now) == plan.day:
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
