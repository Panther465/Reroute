"""Sense: where the traveller is in the day, and the planner inputs for the rest of it.

The traveller's position comes from check-ins and the clock alone (location is optional):
- the current task is the first task in the active plan that isn't done or skipped and whose leg
  should already have left;
- if there is none, the traveller is at the last place they checked in done (or the place of stay).
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import date, datetime, timedelta, timezone

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.adapters.travel_times import PlacePoint, TravelTimeAdapter
from app.clock import minutes_of_day, tz_for
from app.models import Place, Plan, Task, Trip
from app.services.plan_store import active_plan
from app.services.planner import Objective, PlannerInput, PlanTask, RuleSettings, Start, Window
from app.services.planner.util import to_minutes

RULE = RuleSettings()
GONE = ("done", "skipped", "moved")


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

    @property
    def today_tasks(self) -> list[Task]:
        return [t for t in self.tasks.values() if t.planned_day == self.day]

    def planner_tasks(self) -> list[Task]:
        current_id = self.current.task_id if self.current else None
        return sorted(
            (t for t in self.tasks.values() if t.day == self.day and t.state not in GONE and t.task_id != current_id),
            key=lambda t: t.task_id,
        )


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
    last_done_idx = -1
    for i, leg in enumerate(legs):
        task = tasks.get(leg.get("taskId") or "")
        if task is None:
            break
        if task.state in GONE:
            last_done_idx = i
            continue
        if _leg_min(leg, "leaveBy", day, tz) <= now_min:
            ctx.current, ctx.current_leg = task, leg
            ctx.done_legs += legs[: i + 1]
            ctx.remaining_legs = legs[i + 1 :]
        break

    if ctx.current is not None:
        planned_end = _leg_min(ctx.current_leg, "taskEnd", day, tz)  # type: ignore[arg-type]
        ready = max(now_min, planned_end + delay_min)
        # Detect: still not checked in done more than 5 minutes after the next leg's leave-by time.
        if ctx.remaining_legs:
            leave = _leg_min(ctx.remaining_legs[0], "leaveBy", day, tz)
            if now_min > leave + RULE.behind_threshold_min:
                ctx.behind_min = now_min - leave
        ctx.behind_min = max(ctx.behind_min, delay_min)
        ctx.start = Start(place_id=ctx.current.place_id, ready_at=ready, kind="after_task")
        return ctx

    ctx.done_legs += legs[: last_done_idx + 1]
    ctx.remaining_legs = legs[last_done_idx + 1 :]
    if last_done_idx >= 0:
        last_task = tasks[legs[last_done_idx]["taskId"]]
        finished = minutes_of_day(done_at, day, tz) if done_at else now_min
        ctx.start = Start(place_id=last_task.place_id, ready_at=max(finished, now_min) + delay_min, kind="after_task")
        if ctx.remaining_legs:
            leave = _leg_min(ctx.remaining_legs[0], "leaveBy", day, tz)
            # Leave-by passed, nobody moved: behind.
            if now_min > leave + RULE.behind_threshold_min:
                ctx.behind_min = now_min - leave
    else:
        ctx.start = Start(place_id=trip.stay_place_id, ready_at=max(now_min, RULE.day_earliest_departure) + delay_min, kind="stay")
        if ctx.remaining_legs:
            leave = _leg_min(ctx.remaining_legs[0], "leaveBy", day, tz)
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
