"""Morning planning: each trip day gets its plan on its own, early in the local morning.

The app tells the traveller "Reroute plans these in the morning" for tasks on a later day. The
scheduler looks every minute; a day is due once its local time reaches MORNING_PLAN_FROM_MIN (06:00),
when it has open tasks and no plan yet, and only on a trip the traveller planned before. Reroute
never plans a trip that nobody started. Each trip-day is queued once (a Redis key and a fixed job ID).
"""

from __future__ import annotations

from datetime import date, datetime

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.clock import tz_for
from app.config import get_settings
from app.models import Plan, Task, Trip
from app.services.plan_store import active_plan

#: A trip-day is queued at most once in this time; a failed run makes it due again sooner.
ONCE_SECONDS = 36 * 3600
RETRY_SECONDS = 30 * 60


def lock_key(trip_id: str, day: date) -> str:
    return f"morning_plan:{trip_id}:{day.isoformat()}"


def job_id(trip_id: str, day: date) -> str:
    return f"morning-{trip_id}-{day.isoformat()}"


def is_due(start: date, end: date, local_now: datetime, from_min: int, *, open_tasks: bool, planned_today: bool, planned_before: bool) -> bool:
    """The rule itself, on plain values. `local_now` is the trip's local time (the demo clock, if set)."""
    day = local_now.date()
    minute = local_now.hour * 60 + local_now.minute
    return start <= day <= end and minute >= from_min and open_tasks and not planned_today and planned_before


def local_day(trip: Trip, now: datetime) -> date:
    return now.astimezone(tz_for(trip.utc_offset)).date()


def due_day(db: Session, trip: Trip, now: datetime) -> date | None:
    """The trip day to plan now, or None."""
    local = now.astimezone(tz_for(trip.utc_offset))
    day = local.date()
    if not trip.start_date <= day <= trip.end_date:
        return None
    active = active_plan(db, trip.trip_id)
    open_tasks = db.scalar(select(Task.task_id).where(Task.trip_id == trip.trip_id, Task.day == day, Task.state.notin_(("done", "skipped"))).limit(1))
    planned_before = db.scalar(select(Plan.plan_id).where(Plan.trip_id == trip.trip_id, Plan.version.is_not(None)).limit(1))
    due = is_due(
        trip.start_date,
        trip.end_date,
        local,
        get_settings().morning_plan_from_min,
        open_tasks=open_tasks is not None,
        planned_today=active is not None and active.day == day,
        planned_before=planned_before is not None,
    )
    return day if due else None
