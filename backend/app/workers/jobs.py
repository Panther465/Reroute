"""Worker jobs. Each gathers its inputs first (database, travel times, Raasta), then runs the pure planner."""

from __future__ import annotations

import contextlib
import logging
from datetime import date, datetime

from sqlalchemy import select

from app import events
from app.adapters.transit import RaastaHttpAdapter
from app.adapters.travel_times import make_adapter
from app.clock import at_minutes, minutes_of_day, now_for, tz_for
from app.db import session_scope
from app.errors import ApiError
from app.models import Plan, Task, Trip
from app.redis_client import get_redis
from app.services import loop, morning
from app.services.day import trip_day

log = logging.getLogger("reroute.jobs")


def default_adapter():
    return make_adapter(RaastaHttpAdapter(redis_client=get_redis()), get_redis())


#: Tests replace this with a fixed transit answer; deployments use Raasta over HTTP.
adapter_factory = default_adapter


def _adapter():
    return adapter_factory()


def plan_trip(trip_id: str, trigger: str = "created", checkin_id: str | None = None) -> dict:
    with session_scope() as db:
        trip = db.get(Trip, trip_id)
        if trip is None:
            return {"error": "Trip not found."}
        try:
            plan = loop.create_plan(db, trip, _adapter(), now_for(trip_id), trigger=trigger, checkin_id=checkin_id)
        except ApiError as exc:
            return {"error": exc.message, "code": exc.code, **exc.extra}
        return {"planId": plan.plan_id, "planVersion": plan.version}


def morning_plan(trip_id: str, day: str) -> dict:
    """Plan a trip day in the morning. The scheduler queues it once per trip-day; a failed run is retried
    after 30 minutes. The day is checked again here and under the trip's lock: the traveller may have
    planned it meanwhile."""
    key = morning.lock_key(trip_id, date.fromisoformat(day))
    try:
        with session_scope() as db:
            trip = db.get(Trip, trip_id)
            if trip is None:
                return {"error": "Trip not found."}
            now = now_for(trip_id)
            if morning.due_day(db, trip, now) != date.fromisoformat(day):
                return {"result": "not_due"}
            try:
                plan = loop.create_plan(db, trip, _adapter(), now, trigger="morning")
            except ApiError as exc:
                if exc.code == "NOT_DUE":
                    return {"result": "not_due"}
                log.warning("Morning plan for %s on %s failed: %s", trip_id, day, exc.code)
                _retry_morning_later(key)
                return {"error": exc.message, "code": exc.code, **exc.extra}
            return {"planId": plan.plan_id, "planVersion": plan.version}
    except Exception:
        _retry_morning_later(key)
        raise


def _retry_morning_later(key: str) -> None:
    with contextlib.suppress(Exception):
        get_redis().expire(key, morning.RETRY_SECONDS)


def replan_trip(trip_id: str, delay_min: int = 0, automatic: bool = False, checkin_id: str | None = None, done_at: str | None = None) -> dict:
    with session_scope() as db:
        trip = db.get(Trip, trip_id)
        if trip is None:
            return {"error": "Trip not found."}
        try:
            outcome = loop.run(
                db,
                trip,
                _adapter(),
                now_for(trip_id),
                delay_min=delay_min,
                automatic=automatic,
                checkin_id=checkin_id,
                done_at=datetime.fromisoformat(done_at) if done_at else None,
            )
        except ApiError as exc:
            return {"error": exc.message, "code": exc.code}
        return {
            "result": outcome.result,
            "reasonCodes": outcome.reason_codes,
            "explanation": outcome.explanation,
            "planId": outcome.plan.plan_id if outcome.plan else None,
            "optionSetId": outcome.option_set_id,
            "blocked": outcome.blocked,
        }


def five_minute_check(trip_id: str) -> dict:
    """The automatic run: detect a late traveller, shift times if that's enough, else refresh options."""
    result = replan_trip(trip_id, automatic=True)
    send_leave_now_alerts(trip_id)
    return result


def send_leave_now_alerts(trip_id: str) -> None:
    """10 minutes before each leave-by time, and at it. Each alert goes out once."""
    r = get_redis()
    with session_scope() as db:
        trip = db.get(Trip, trip_id)
        plan = db.scalar(select(Plan).where(Plan.trip_id == trip_id, Plan.status == "active")) if trip else None
        if trip is None or plan is None:
            return
        now = now_for(trip_id)
        tz = tz_for(trip.utc_offset)
        day = trip_day(trip, now)
        now_min = minutes_of_day(now, day, tz)
        for leg in plan.legs:
            leave = minutes_of_day(datetime.fromisoformat(leg["leaveBy"]), day, tz)
            for lead, label in ((10, "soon"), (0, "now")):
                if leave - lead <= now_min < leave - lead + 5 and r.set(f"leave_now:{plan.plan_id}:{leg['seq']}:{label}", "1", nx=True, ex=86400):
                    events.publish(
                        trip_id,
                        "leave_now",
                        {
                            "seq": leg["seq"],
                            "taskId": leg.get("taskId"),
                            "leaveBy": at_minutes(day, leave, tz).isoformat(),
                            "inMin": max(0, leave - now_min),
                            "label": leg["label"],
                        },
                    )
        # Tasks the plan named as unplaced won't happen: they don't keep the trip from ending.
        unplaced = {m["taskId"] for m in plan.moved or [] if m.get("kind") == "unplaced"}
        open_tasks = [
            t
            for t in db.scalars(select(Task.task_id).where(Task.trip_id == trip_id, Task.day == trip.end_date, Task.state.notin_(("done", "skipped"))))
            if t not in unplaced
        ]
        if (
            plan.day == trip.end_date
            and day == trip.end_date
            and not open_tasks
            and now_min > minutes_of_day(datetime.fromisoformat(plan.legs[-1]["arriveAt"]), day, tz)
            and r.set(f"trip_ended:{trip_id}", "1", nx=True, ex=7 * 86400)
        ):
            events.publish(trip_id, "trip_ended", {"tripId": trip_id})
