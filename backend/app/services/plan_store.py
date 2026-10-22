"""Saving plan versions (section 8, plan rules).

- A plan's content is never edited; only its status changes. A database trigger enforces it.
- Exactly one plan per trip is active (a partial unique index).
- A proposed plan is an option waiting for the traveller; it gets a version number only when accepted.
- Undo makes an earlier version active again and marks the current one superseded.
"""

from __future__ import annotations

import logging
from datetime import UTC, date, datetime, timezone

from sqlalchemy import func, select, update
from sqlalchemy.orm import Session

from app.clock import at_minutes, tz_for
from app.errors import ApiError
from app.models import Plan, PlanLeg, Task, Trip
from app.schemas import LegExtraOut, LegOut, MovedOut, PlanOut, SegmentOut, TotalsOut, TransitRefOut
from app.services.planner import LegOption, PlannedLeg, PlannerInput, PlanResult
from app.services.planner.insight import plan_insight

log = logging.getLogger("reroute.plans")


def _transit(opt: LegOption) -> TransitRefOut | None:
    ref = opt.transit_ref
    return TransitRefOut(kind=ref.kind, ref_id=ref.ref_id, status=ref.status) if ref else None


def leg_out(leg: PlannedLeg, day: date, tz: timezone) -> LegOut:
    o = leg.option
    return LegOut(
        seq=leg.seq,
        task_id=leg.task_id,
        mode=o.mode.value,
        label=o.label,
        segments=[SegmentOut(mode=s.mode.value, minutes=s.minutes) for s in o.segments],
        from_place_id=leg.from_place,
        to_place_id=leg.to_place,
        leave_by=at_minutes(day, leg.leave_by, tz),
        arrive_at=at_minutes(day, leg.arrive_at, tz),
        task_start=at_minutes(day, leg.task_start, tz),
        task_end=at_minutes(day, leg.task_end, tz),
        travel_min=o.travel_min,
        wait_min=leg.wait_min,
        fare_inr=o.fare_inr,
        option_id=o.option_id,
        transit_ref=_transit(o),
        extras=[
            LegExtraOut(label=x.label, mode=x.mode.value, travel_min=x.travel_min, fare_inr=x.fare_inr, transit_ref=_transit(x), rough=x.rough)
            for x in leg.extras
        ],
        rough=o.rough,
    )


def new_plan_row(
    trip: Trip,
    day: date,
    inp: PlannerInput,
    result: PlanResult,
    *,
    status: str,
    trigger: str,
    explanation: str,
    done_legs: list[dict],
    checkin_id: str | None = None,
    option_set_id: str | None = None,
    option_id: str | None = None,
    option: dict | None = None,
    reason_codes: list[str] | None = None,
    carried_moved: list[dict] | None = None,
) -> tuple[Plan, list[PlanLeg]]:
    """`carried_moved`: entries of the previous version to keep, such as tasks still unplaced after a re-plan."""
    tz = tz_for(trip.utc_offset)
    legs = [leg_out(leg, day, tz) for leg in result.legs]
    moved = [
        MovedOut(
            task_id=m.task_id,
            title=m.title,
            kind=m.kind,
            to_day_start=at_minutes(date.fromordinal(day.toordinal() + 1), m.to_day_start, tz) if m.to_day_start is not None else None,
            reason=m.reason,
        )
        for m in result.moved
    ]
    named = {m.task_id for m in moved}
    moved += [MovedOut.model_validate(m) for m in carried_moved or [] if m["taskId"] not in named]
    plan = Plan(
        trip_id=trip.trip_id,
        day=day,
        version=None,
        status=status,
        trigger=trigger,
        checkin_id=checkin_id,
        inputs_hash=result.inputs_hash,
        rule_version=inp.rule.version,
        travel_time_snapshot_id=inp.snapshot.snapshot_id,
        inputs=inp.model_dump(mode="json"),
        legs=[x.model_dump(mode="json", by_alias=True) for x in legs],
        done_legs=done_legs,
        moved=[m.model_dump(mode="json", by_alias=True) for m in moved],
        travel_min=result.travel_min,
        fare_inr=result.fare_inr,
        wait_min=result.wait_min,
        cost=result.cost,
        reason_codes=reason_codes if reason_codes is not None else [c.value for c in result.reason_codes],
        explanation=explanation,
        approximate=result.approximate,
        option_set_id=option_set_id,
        option_id=option_id,
        option=option,
        insight=_insight(inp, result),
    )
    leg_rows = [
        PlanLeg(
            seq=x.seq,
            task_id=x.task_id,
            mode=x.mode,
            label=x.label,
            leave_by=x.leave_by,
            arrive_at=x.arrive_at,
            travel_min=x.travel_min,
            wait_min=x.wait_min,
            fare_inr=x.fare_inr,
            transit_ref=x.transit_ref.model_dump(mode="json", by_alias=True) if x.transit_ref else None,
        )
        for x in legs
    ]
    return plan, leg_rows


def _insight(inp: PlannerInput, result: PlanResult) -> dict | None:
    """Why this plan, worked out now (in the worker) so the API only reads it. A plan never fails for it."""
    try:
        return plan_insight(inp, result).model_dump(mode="json")
    except Exception:  # an explanation is a bonus: the plan itself is already sound
        log.exception("Couldn't work out the plan's insight")
        return None


def add_plan(db: Session, plan: Plan, leg_rows: list[PlanLeg]) -> Plan:
    db.add(plan)
    db.flush()
    for row in leg_rows:
        row.plan_id = plan.plan_id
        db.add(row)
    return plan


def active_plan(db: Session, trip_id: str) -> Plan | None:
    return db.scalar(select(Plan).where(Plan.trip_id == trip_id, Plan.status == "active"))


def next_version(db: Session, trip_id: str) -> int:
    return (db.scalar(select(func.max(Plan.version)).where(Plan.trip_id == trip_id)) or 0) + 1


def activate(db: Session, plan: Plan) -> Plan:
    """Make a plan the trip's active version; the previous active one becomes superseded."""
    db.execute(update(Plan).where(Plan.trip_id == plan.trip_id, Plan.status == "active", Plan.plan_id != plan.plan_id).values(status="superseded"))
    db.flush()
    if plan.version is None:
        plan.version = next_version(db, plan.trip_id)
    plan.status = "active"
    plan.activated_at = datetime.now(UTC)
    db.flush()
    sync_tasks(db, plan)
    return plan


def close_open_options(db: Session, trip_id: str) -> None:
    db.execute(update(Plan).where(Plan.trip_id == trip_id, Plan.status == "proposed").values(status="superseded"))


def sync_tasks(db: Session, plan: Plan) -> None:
    """Make task days and states agree with the active plan, so Undo also brings tasks back.

    Check-ins marked "done" are facts and never change. A task the plan moves goes to the next day;
    a task the plan includes comes back to its planned day. A moved task that its new day's plan
    includes is planned again there (it keeps `planned_day`, so the first day's summary still says
    it moved).
    """
    tasks = {t.task_id: t for t in db.scalars(select(Task).where(Task.trip_id == plan.trip_id))}
    in_plan = {leg["taskId"] for leg in plan.legs if leg.get("taskId")} | {leg["taskId"] for leg in plan.done_legs if leg.get("taskId")}
    moved = {m["taskId"]: m for m in plan.moved}
    for task in tasks.values():
        if task.planned_day != plan.day and task.changed_by_plan_id is None:
            continue
        if task.state == "done":
            continue
        if task.task_id in moved and moved[task.task_id]["kind"] in ("moved", "skipped"):
            kind = moved[task.task_id]["kind"]
            task.state = "moved" if kind == "moved" else "skipped"
            if kind == "moved":
                task.day = date.fromordinal(plan.day.toordinal() + 1)
            task.changed_by_plan_id = plan.plan_id
        elif task.task_id in in_plan and task.state in ("moved", "skipped") and task.planned_day == plan.day:
            # Undo on the day the task was moved from brings it back.
            task.state = "planned"
            task.day = task.planned_day
            task.changed_by_plan_id = None
        elif task.task_id in in_plan and task.state == "moved" and task.day == plan.day:
            # Its new day's plan includes it: it's an ordinary task of that day now.
            task.state = "planned"


def plan_out(plan: Plan) -> PlanOut:
    return PlanOut(
        plan_id=plan.plan_id,
        trip_id=plan.trip_id,
        day=plan.day,
        version=plan.version,
        status=plan.status,  # type: ignore[arg-type]
        trigger=plan.trigger,  # type: ignore[arg-type]
        checkin_id=plan.checkin_id,
        inputs_hash=plan.inputs_hash,
        rule_version=plan.rule_version,
        travel_time_snapshot_id=plan.travel_time_snapshot_id,
        legs=[LegOut.model_validate(x) for x in plan.legs],
        done_legs=[LegOut.model_validate(x) for x in plan.done_legs or []],
        moved=[MovedOut.model_validate(x) for x in plan.moved or []],
        totals=TotalsOut(travel_min=plan.travel_min, fare_inr=plan.fare_inr, wait_min=plan.wait_min),
        reason_codes=list(plan.reason_codes or []),  # type: ignore[arg-type]
        explanation=plan.explanation,
        approximate=plan.approximate,
        cost=plan.cost,
        created_at=plan.created_at or datetime.now(UTC),
    )


def get_version(db: Session, trip_id: str, version: int) -> Plan:
    plan = db.scalar(select(Plan).where(Plan.trip_id == trip_id, Plan.version == version))
    if plan is None:
        raise ApiError(404, "That plan version doesn't exist.")
    return plan
