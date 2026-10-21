"""Sense: where the traveller is in the day, and the planner inputs for the rest of it.

The traveller's position comes from check-ins and the clock alone (location is optional):
- the current task is the first task in the active plan that isn't done or skipped and whose leg
  should already have left, or the task under way when the plan was last re-planned;
- if there is none, the traveller is at the last place they checked in done (or the place of stay).
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import date, datetime, timedelta, timezone

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.adapters.travel_times import PlacePoint, TravelTimeAdapter
from app.clock import at_minutes, minutes_of_day, tz_for
from app.models import Place, Plan, Task, Trip
from app.redis_client import get_redis
from app.services.plan_store import active_plan
from app.services.planner import Objective, PlannerInput, PlanTask, RuleSettings, Start, Window
from app.services.planner.util import to_minutes

RULE = RuleSettings()
#: States that take a task out of the day it was planned for. A moved task is plannable again on its new day.
GONE = ("done", "skipped", "moved")
FINISHED = ("done", "skipped")
#: A reported delay is remembered until the end of the day, so later automatic checks keep it.
READY_TTL_SECONDS = 24 * 3600


def _ready_key(trip_id: str, task_id: str) -> str:
    return f"reported_ready:{trip_id}:{task_id}"


def trip_day(trip: Trip, now: datetime) -> date:
    local = now.astimezone(tz_for(trip.utc_offset)).date()
    return min(max(local, trip.start_date), trip.end_date)


@dataclass
class DayContext:
    trip: Trip
    day: date
    tz: timezone
    now: datetime
    now_min: int
    tasks: dict[str, Task]
    active: Plan | None
    current: Task | None = None
    current_leg: dict | None = None
    remaining_legs: list[dict] = field(default_factory=list)
    done_legs: list[dict] = field(default_factory=list)
    start: Start | None = None
    behind_min: int = 0
    #: A delay reported on the way to a fixed task: (task, expected arrival in minutes).
    fixed_at_risk: tuple[Task, int] | None = None

    @property
    def today_tasks(self) -> list[Task]:
        return [t for t in self.tasks.values() if t.planned_day == self.day]

    def planner_tasks(self) -> list[Task]:
        """Tasks still to plan today. A task moved here from an earlier day counts (its `day` is today)."""
        current_id = self.current.task_id if self.current else None
        return sorted(
            (t for t in self.tasks.values() if t.day == self.day and t.state not in FINISHED and t.task_id != current_id),
            key=lambda t: t.task_id,
        )

    @property
    def day_finished(self) -> bool:
        """Every task of the day is done, skipped or moved away: nothing is left to plan."""
        return self.current is None and not self.planner_tasks()


def _leg_min(leg: dict, key: str, ctx_day: date, tz: timezone) -> int:
    return minutes_of_day(datetime.fromisoformat(leg[key]), ctx_day, tz)


def sense(db: Session, trip: Trip, now: datetime, delay_min: int = 0, done_at: datetime | None = None) -> DayContext:
    tz = tz_for(trip.utc_offset)
    day = trip_day(trip, now)
    tasks = {t.task_id: t for t in db.scalars(select(Task).where(Task.trip_id == trip.trip_id))}
    plan = active_plan(db, trip.trip_id)
    if plan is not None and plan.day != day:
        plan = None
    now_min = minutes_of_day(now, day, tz)
    ctx = DayContext(trip=trip, day=day, tz=tz, now=now, now_min=now_min, tasks=tasks, active=plan)

    if plan is None:
        ready = max(now_min, RULE.day_earliest_departure) if now.astimezone(tz).date() == day else RULE.day_earliest_departure
        ctx.start = Start(place_id=trip.stay_place_id, ready_at=ready, kind="stay")
        return ctx

    legs = list(plan.legs)
    ctx.done_legs = list(plan.done_legs or [])
    # Only a leg to a task checked in done was travelled: the traveller never went to a skipped task.
    reached: list[dict] = []
    passed = 0
    for i, leg in enumerate(legs):
        task = tasks.get(leg.get("taskId") or "")
        if task is None:
            break
        if task.state in GONE:
            passed = i + 1
            if task.state == "done":
                reached.append(leg)
            continue
        if _leg_min(leg, "leaveBy", day, tz) <= now_min:
            ctx.current, ctx.current_leg = task, leg
            ctx.done_legs += [*reached, leg]
            ctx.remaining_legs = legs[i + 1 :]
        break

    # A re-plan made while a task was under way keeps that task's leg with the done legs. Until the task
    # is checked in, the traveller is still there, so the next re-plan must start from it too.
    if ctx.current is None and not reached and ctx.done_legs:
        last = ctx.done_legs[-1]
        task = tasks.get(last.get("taskId") or "")
        if task is not None and task.state not in GONE:
            ctx.current, ctx.current_leg = task, last
            ctx.remaining_legs = legs[passed:]

    if ctx.current is not None:
        leg = ctx.current_leg
        planned_start = _leg_min(leg, "taskStart", day, tz)  # type: ignore[arg-type]
        planned_end = _leg_min(leg, "taskEnd", day, tz)  # type: ignore[arg-type]
        arrive = _leg_min(leg, "arriveAt", day, tz)  # type: ignore[arg-type]
        r = get_redis()
        key = _ready_key(trip.trip_id, ctx.current.task_id)
        if delay_min and now_min < planned_start:
            # Reported on the way: the arrival is late. A fixed start can't move, so say it's at risk.
            late_arrival = arrive + delay_min
            begin = max(planned_start, late_arrival)
            ready = begin + ctx.current.duration_min
            if ctx.current.fixed_start is not None and late_arrival > planned_start - RULE.fixed_buffer_min:
                ctx.fixed_at_risk = (ctx.current, late_arrival)
        else:
            ready = max(now_min, planned_end + delay_min)
        # Remember the latest reported delay so the 5-minute check doesn't forget it.
        stored = r.get(key)
        if stored:
            ready = max(ready, minutes_of_day(datetime.fromisoformat(stored), day, tz))
        if delay_min:
            r.set(key, at_minutes(day, ready, tz).isoformat(), ex=READY_TTL_SECONDS)
        # Detect: still not checked in done more than 5 minutes after the next leg's leave-by time.
        if ctx.remaining_legs:
            leave = _leg_min(ctx.remaining_legs[0], "leaveBy", day, tz)
            if now_min > leave + RULE.behind_threshold_min:
                ctx.behind_min = now_min - leave
        ctx.behind_min = max(ctx.behind_min, delay_min, (ready - planned_end) if stored or delay_min else 0)
        ctx.start = Start(place_id=ctx.current.place_id, ready_at=ready, kind="after_task")
        return ctx

    ctx.done_legs += reached
    ctx.remaining_legs = legs[passed:]
    # The traveller is where they last checked in done, which may be in an earlier version of the plan.
    last_task = next((t for leg in reversed(ctx.done_legs) if (t := tasks.get(leg.get("taskId") or "")) and t.state == "done"), None)
    if last_task is not None:
        finished = minutes_of_day(done_at, day, tz) if done_at else now_min
        ctx.start = Start(place_id=last_task.place_id, ready_at=max(finished, now_min) + delay_min, kind="after_task")
    else:
        ctx.start = Start(place_id=trip.stay_place_id, ready_at=max(now_min, RULE.day_earliest_departure) + delay_min, kind="stay")
    if ctx.remaining_legs:
        leave = _leg_min(ctx.remaining_legs[0], "leaveBy", day, tz)
        # Leave-by passed, nobody moved: behind.
        if now_min > leave + RULE.behind_threshold_min:
            ctx.behind_min = now_min - leave
    ctx.behind_min = max(ctx.behind_min, delay_min)
    return ctx


def to_plan_task(task: Task, day: date, tz: timezone) -> PlanTask:
    fixed = minutes_of_day(task.fixed_start, day, tz) if task.fixed_start else None
    window = Window(opens=to_minutes(task.opens_at), closes=to_minutes(task.closes_at)) if task.opens_at and task.closes_at else None
    return PlanTask(
        task_id=task.task_id,
        title=task.title,
        place_id=task.place_id,
        duration_min=task.duration_min,
        fixed_start=fixed,
        window=window,
        priority=task.priority,  # type: ignore[arg-type]
        hours_unknown=task.hours_unknown,
        movable=task.fixed_start is None,
    )


def planner_input(db: Session, ctx: DayContext, adapter: TravelTimeAdapter, objective: Objective | None = None) -> PlannerInput:
    tasks = ctx.planner_tasks()
    place_ids = {ctx.trip.stay_place_id, ctx.start.place_id, *(t.place_id for t in tasks)}  # type: ignore[union-attr]
    places = db.scalars(select(Place).where(Place.place_id.in_(place_ids))).all()
    snapshot = adapter.snapshot(ctx.trip.city_slug, [PlacePoint(p.place_id, p.lng, p.lat) for p in sorted(places, key=lambda p: p.place_id)], ctx.day)
    return PlannerInput(
        rule=RULE,
        day=ctx.day,
        utc_offset=ctx.trip.utc_offset,
        stay_place_id=ctx.trip.stay_place_id,
        start=ctx.start,  # type: ignore[arg-type]
        tasks=tuple(to_plan_task(t, ctx.day, ctx.tz) for t in tasks),
        snapshot=snapshot,
        has_next_day=ctx.day < ctx.trip.end_date,
        objective=objective or Objective(),
    )


def next_day(d: date) -> date:
    return d + timedelta(days=1)
