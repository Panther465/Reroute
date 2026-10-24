"""Worker jobs. Each gathers its inputs first (database, travel times, Raasta), then runs the pure planner."""

from __future__ import annotations

import contextlib
import logging
from datetime import date, datetime

from sqlalchemy import select

from app import events
from app.adapters.metro import metro_lines
from app.adapters.road_path import Router
from app.adapters.transit import RaastaHttpAdapter
from app.adapters.travel_times import make_adapter
from app.clock import at_minutes, minutes_of_day, now_for, tz_for
from app.config import get_settings
from app.db import session_scope
from app.errors import ApiError
from app.models import Place, Plan, Task, Trip
from app.redis_client import get_redis
from app.services import leg_paths, loop, morning, push, traffic
from app.services.day import RULE, DayContext, sense, trip_day

log = logging.getLogger("reroute.jobs")

#: Rico checks in this many minutes before a road leg's leave-by when its roads are usually busy: early enough to
#: leave earlier, close enough to be about now. The first 5-minute check in between sends it.
NUDGE_FROM_MIN = 40
NUDGE_UNTIL_MIN = 20
#: "Are you there?" to a traveller who looks behind is worth showing for a quarter of an hour: by then the 5-minute
#: checks have moved the day on, or the traveller has answered.
BEHIND_NUDGE_SECONDS = 15 * 60


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


def warm_plan_paths(plan_id: str) -> dict:
    """Draw a plan's legs along real roads, rails and recorded paths, for the map and the directions."""
    with session_scope() as db:
        plan = db.get(Plan, plan_id)
        trip = db.get(Trip, plan.trip_id) if plan else None
        if plan is None or trip is None:
            return {"error": "Plan not found."}
        # Upcoming legs first: they're the ones the traveller looks at.
        legs = [*plan.legs, *(plan.done_legs or [])]
        ids = {x for leg in legs for x in (leg["fromPlaceId"], leg["toPlaceId"])}
        places = {p.place_id: (p.lng, p.lat) for p in db.scalars(select(Place).where(Place.place_id.in_(ids)))}
        version, trip_id, city = plan.version, trip.trip_id, trip.city_slug
    drawing = leg_paths.Drawing(
        router=Router(get_redis()),
        lines=metro_lines(get_settings().examples_dir / city / "metro.json"),
        shape=_adapter().transit.route_shape,
    )
    return leg_paths.warm(plan_id, version, trip_id, legs, places, drawing)


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
    """The automatic run: detect a late traveller, shift times if that's enough, else refresh options. Then the
    alerts: leave-by, and Rico's check-ins."""
    result = replan_trip(trip_id, automatic=True)
    send_leave_now_alerts(trip_id)
    try:
        send_nudges(trip_id)
    except Exception:  # a check-in is a bonus: the day and its leave-by alerts are already seen to
        log.exception("Couldn't send Rico's check-ins for %s", trip_id)
    return result


def send_leave_now_alerts(trip_id: str) -> None:
    """10 minutes before each leave-by time, and at it. Each alert goes out once, on the live stream and as a push."""
    r = get_redis()
    pushes: list[push.PushAlert] = []
    with session_scope() as db:
        trip = db.get(Trip, trip_id)
        plan = db.scalar(select(Plan).where(Plan.trip_id == trip_id, Plan.status == "active")) if trip else None
        if trip is None or plan is None:
            return
        user_id = trip.user_id
        now = now_for(trip_id)
        tz = tz_for(trip.utc_offset)
        day = trip_day(trip, now)
        now_min = minutes_of_day(now, day, tz)
        for leg in plan.legs:
            leave = minutes_of_day(datetime.fromisoformat(leg["leaveBy"]), day, tz)
            for lead, label in ((10, "soon"), (0, "now")):
                if leave - lead <= now_min < leave - lead + 5 and r.set(f"leave_now:{plan.plan_id}:{leg['seq']}:{label}", "1", nx=True, ex=86400):
                    in_min = max(0, leave - now_min)
                    events.publish(
                        trip_id,
                        "leave_now",
                        {
                            "seq": leg["seq"],
                            "taskId": leg.get("taskId"),
                            "leaveBy": at_minutes(day, leave, tz).isoformat(),
                            "inMin": in_min,
                            "label": leg["label"],
                        },
                    )
                    # Worth showing until the leave-by time, or for five minutes once it has come.
                    alert = push.PushAlert(
                        kind="leave_now",
                        body=push.leave_text(in_min, leg["label"]),
                        tag=f"leave-{leg['seq']}",
                        trip_id=trip_id,
                        ttl_seconds=(in_min or 5) * 60,
                        seq=leg["seq"],
                    )
                    pushes.append(alert)
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
    for alert in pushes:
        push.alert(user_id, alert)


def send_nudges(trip_id: str) -> None:
    """Rico checks in ("Hi, are you there? 👋") once per leg of a plan and reason, on the live stream and as a push.
    The app says why when it's opened:
    - "busy": 20 to 40 minutes before a road leg whose roads are usually busy then (services/traffic.py: typical
      traffic, not live data), with how much earlier to leave;
    - "behind": still not on the way 5 minutes after the next leave-by, as sense() sees it from the clock, and the
      leave-now alert at that time never went out (a check missed its 5 minutes, or the plan came after them).
    """
    r = get_redis()
    pushes: list[push.PushAlert] = []
    with session_scope() as db:
        trip = db.get(Trip, trip_id)
        if trip is None:
            return
        ctx = sense(db, trip, now_for(trip_id))
        if ctx.active is None:
            return
        user_id, plan_id = trip.user_id, ctx.active.plan_id
        for leg in ctx.remaining_legs:
            leave = minutes_of_day(datetime.fromisoformat(leg["leaveBy"]), ctx.day, ctx.tz)
            if leg["mode"] not in traffic.ROAD_MODES or not leave - NUDGE_FROM_MIN <= ctx.now_min <= leave - NUDGE_UNTIL_MIN:
                continue
            # A wait the plan already has at the other end takes up that much of the delay.
            extra = traffic.leg_delay_min(trip.city_slug, leg) - leg.get("waitMin", 0)
            if traffic.meaningful(extra, leg["travelMin"]) and r.set(f"nudge:{plan_id}:{leg['seq']}:busy", "1", nx=True, ex=86400):
                earlier = min(traffic.leave_earlier_min(extra), leave - ctx.now_min)
                why = {"reason": "busy", "suggestLeaveBy": at_minutes(ctx.day, leave - earlier, ctx.tz).isoformat(), "extraMin": earlier}
                # Worth showing until the leave-by time.
                pushes.append(_nudge(trip_id, ctx, leg, leave, (leave - ctx.now_min) * 60, why))
        nxt = ctx.remaining_legs[0] if ctx.remaining_legs else None
        if nxt is not None:
            leave = minutes_of_day(datetime.fromisoformat(nxt["leaveBy"]), ctx.day, ctx.tz)
            # Behind by the clock only: a delay the traveller reported counts as behind too, but they've just said
            # where they are. And the leave-now alert at the leave-by time has already told them to go.
            if (
                ctx.now_min > leave + RULE.behind_threshold_min
                and not r.exists(f"leave_now:{plan_id}:{nxt['seq']}:now")
                and r.set(f"nudge:{plan_id}:{nxt['seq']}:behind", "1", nx=True, ex=86400)
            ):
                pushes.append(_nudge(trip_id, ctx, nxt, leave, BEHIND_NUDGE_SECONDS, {"reason": "behind", "behindMin": ctx.behind_min}))
    for alert in pushes:
        push.alert(user_id, alert)


def _nudge(trip_id: str, ctx: DayContext, leg: dict, leave: int, ttl_seconds: int, why: dict) -> push.PushAlert:
    """Publish a check-in on the live stream. Its push is returned, to send once the database session has closed."""
    data = {"seq": leg["seq"], "taskId": leg.get("taskId"), "leaveBy": at_minutes(ctx.day, leave, ctx.tz).isoformat(), "label": leg["label"], **why}
    events.publish(trip_id, "nudge", data)
    return push.PushAlert(
        kind="nudge",
        title="Rico",
        body=push.NUDGE_TEXT,
        tag=f"nudge-{leg['seq']}",
        trip_id=trip_id,
        ttl_seconds=ttl_seconds,
        seq=leg["seq"],
        details={k: str(v) for k, v in data.items() if v is not None},
    )
