"""The scheduler: every minute it finds trips with an active plan for today and, every 5 minutes per
trip, enqueues the automatic check. It also queues each trip day's morning plan once the day starts
(see app.services.morning). Run with: python -m app.workers.scheduler
"""

from __future__ import annotations

import logging
import time
from datetime import UTC, date, datetime, timedelta

from sqlalchemy import select

from app.clock import now_for, tz_for
from app.db import session_scope
from app.models import Plan, Trip
from app.redis_client import get_redis
from app.services import morning
from app.workers.jobs import five_minute_check, morning_plan
from app.workers.queue import get_queue

log = logging.getLogger("reroute.scheduler")
CHECK_EVERY_SECONDS = 5 * 60


def _near(utc_now: datetime | None):
    """Trips running around today: a day of slack either side covers every time zone; the exact check is per trip."""
    utc_today = (utc_now or datetime.now(UTC)).date()
    return Trip.end_date >= utc_today - timedelta(days=1), Trip.start_date <= utc_today + timedelta(days=1)


def due_trips(utc_now: datetime | None = None) -> list[str]:
    with session_scope() as db:
        rows = db.execute(select(Trip, Plan).join(Plan, Plan.trip_id == Trip.trip_id).where(Plan.status == "active", *_near(utc_now))).all()
        due = []
        for trip, plan in rows:
            local_today = now_for(trip.trip_id).astimezone(tz_for(trip.utc_offset)).date()
            # Only trips running today: finished and future trips aren't checked every minute.
            if trip.start_date <= local_today <= trip.end_date and plan.day == local_today:
                due.append(trip.trip_id)
        return due


def due_morning_plans(utc_now: datetime | None = None) -> list[tuple[str, date]]:
    """Trip days to plan now. The local time comes from now_for, so a trip on the demo clock follows it."""
    r = get_redis()
    due = []
    with session_scope() as db:
        for trip in db.scalars(select(Trip).where(*_near(utc_now)).order_by(Trip.trip_id)):
            now = now_for(trip.trip_id)
            # Already queued today: skip the database checks.
            if r.exists(morning.lock_key(trip.trip_id, morning.local_day(trip, now))):
                continue
            day = morning.due_day(db, trip, now)
            if day is not None:
                due.append((trip.trip_id, day))
    return due


def queue_morning_plans(utc_now: datetime | None = None) -> int:
    """Each trip day once: a Redis key (36 h) and a fixed job ID. A run that fails shortens the key to 30 min."""
    r = get_redis()
    queued = 0
    for trip_id, day in due_morning_plans(utc_now):
        key = morning.lock_key(trip_id, day)
        if not r.set(key, datetime.now(UTC).isoformat(), nx=True, ex=morning.ONCE_SECONDS):
            continue
        try:
            get_queue().enqueue(morning_plan, trip_id, day.isoformat(), job_id=morning.job_id(trip_id, day))
        except Exception:
            r.expire(key, morning.RETRY_SECONDS)
            raise
        queued += 1
    return queued


def tick(utc_now: datetime | None = None) -> int:
    r = get_redis()
    queued = 0
    for trip_id in due_trips(utc_now):
        if r.set(f"check_lock:{trip_id}", datetime.now(UTC).isoformat(), nx=True, ex=CHECK_EVERY_SECONDS):
            get_queue().enqueue(five_minute_check, trip_id, job_id=f"check-{trip_id}-{int(time.time() // CHECK_EVERY_SECONDS)}")
            queued += 1
    return queued + queue_morning_plans(utc_now)


def main() -> None:
    logging.basicConfig(level=logging.INFO)
    log.info("Scheduler started")
    while True:
        try:
            n = tick()
            if n:
                log.info("Queued %s jobs", n)
        except Exception:  # keep the scheduler alive; the next tick retries
            log.exception("Scheduler tick failed")
        time.sleep(60)


if __name__ == "__main__":
    main()
