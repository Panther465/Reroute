"""The re-plan loop (section 10): sense, detect, decide, act, explain.

It runs in the worker after every check-in, every 5 minutes during an active trip, and when the
traveller taps Running late. It decides with the deterministic planner and acts only within limits:
- on its own it may only shift times;
- a dearer mode, a moved task or a skipped task always waits for the traveller's choice;
- a trip has at most one open set of options; a new run replaces it;
- every action is logged and can be undone.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime

from sqlalchemy import select
from sqlalchemy.orm import Session

from app import events
from app.adapters.travel_times import TravelTimeAdapter
from app.clock import minutes_of_day
from app.errors import ApiError
from app.models import Plan, RerouteLog, Trip, new_id
from app.services import plan_store
from app.services.day import DayContext, planner_input, sense
from app.services.planner import Objective, ReplanInput, ReplanResult, explain, plan_day, replan
from app.services.planner.util import rupees


@dataclass
class LoopOutcome:
    result: str
    reason_codes: list[str] = field(default_factory=list)
    explanation: str = ""
    plan: Plan | None = None
    options: list[Plan] = field(default_factory=list)
    option_set_id: str | None = None
    blocked: dict | None = None


def _log(
    db: Session, trip: Trip, now: datetime, kind: str, text: str, automatic: bool, plan: Plan | None, previous: Plan | None, codes: list[str]
) -> RerouteLog:
    entry = RerouteLog(
        trip_id=trip.trip_id,
        at=now,
        kind=kind,
        text=text,
        automatic=automatic,
        plan_id=plan.plan_id if plan else None,
        previous_plan_id=previous.plan_id if previous else None,
        reason_codes=codes,
    )
    db.add(entry)
    return entry


def _plan_event(plan: Plan, notify: bool) -> dict:
    return {
        "planId": plan.plan_id,
        "version": plan.version,
        "trigger": plan.trigger,
        "reasonCodes": list(plan.reason_codes),
        "explanation": plan.explanation,
        "notify": notify,
    }


def create_plan(db: Session, trip: Trip, adapter: TravelTimeAdapter, now: datetime, trigger: str = "created", checkin_id: str | None = None) -> Plan:
    """Plan the rest of the day from scratch (a new trip, an edit or a skip) and make it active."""
    ctx = sense(db, trip, now)
    inp = planner_input(db, ctx, adapter, Objective(allow_unplace=True))
    result = plan_day(inp)
    if not result.feasible:
        reason = result.blocked.reason if result.blocked else "No plan keeps every fixed time."
        raise ApiError(409, f"{reason}. Move it to another day or change it.", code="NO_FEASIBLE_PLAN")
    text = explain.created(len(inp.tasks), result.approximate)
    unplaced = [m for m in result.moved if m.kind == "unplaced"]
    if unplaced:
        text += " " + " ".join(f"{m.reason}." for m in unplaced)
    previous = ctx.active
    plan, legs = plan_store.new_plan_row(
        trip, ctx.day, inp, result, status="proposed", trigger=trigger, explanation=text, done_legs=ctx.done_legs, checkin_id=checkin_id
    )
    plan_store.close_open_options(db, trip.trip_id)
    plan_store.add_plan(db, plan, legs)
    plan_store.activate(db, plan)
    if trigger != "created":
        _log(
            db,
            trip,
            now,
            trigger,
            "Re-planned after an edit" if trigger == "edited" else "Re-planned after a skip",
            False,
            plan,
            previous,
            list(plan.reason_codes),
        )
    db.commit()
    events.publish(trip.trip_id, "plan_updated", _plan_event(plan, notify=False))
    return plan


def _replan_input(ctx: DayContext, inp, automatic: bool) -> ReplanInput:
    legs = ctx.remaining_legs
    return ReplanInput(
        planner=inp,
        active_order=tuple((leg.get("taskId"), leg["optionId"]) for leg in legs),
        active_leave_times=tuple(minutes_of_day(datetime.fromisoformat(leg["leaveBy"]), ctx.day, ctx.tz) for leg in legs),
        behind_min=ctx.behind_min,
        automatic=automatic,
        today_task_count=len(ctx.today_tasks),
    )


def run(
    db: Session,
    trip: Trip,
    adapter: TravelTimeAdapter,
    now: datetime,
    *,
    delay_min: int = 0,
    automatic: bool = False,
    checkin_id: str | None = None,
    done_at: datetime | None = None,
) -> LoopOutcome:
    ctx = sense(db, trip, now, delay_min=delay_min, done_at=done_at)
    if ctx.active is None:
        return LoopOutcome(result="on_time", reason_codes=["ON_TIME"], explanation="There's no plan for today yet.")
    if not ctx.remaining_legs and ctx.current is None:
        return LoopOutcome(result="on_time", reason_codes=["ON_TIME"], explanation=explain.on_time(), plan=ctx.active)

    inp = planner_input(db, ctx, adapter)
    decision: ReplanResult = replan(_replan_input(ctx, inp, automatic))
    codes = [c.value for c in decision.reason_codes]

    if decision.result == "on_time":
        return LoopOutcome(result="on_time", reason_codes=codes, explanation=decision.explanation, plan=ctx.active)

    if decision.result == "shifted":
        previous = ctx.active
        plan_codes = codes + [c.value for c in decision.plan.reason_codes if c.value not in codes]  # type: ignore[union-attr]
        plan, legs = plan_store.new_plan_row(
            trip,
            ctx.day,
            inp,
            decision.plan,
            status="proposed",
            trigger="late",
            explanation=decision.explanation,  # type: ignore[arg-type]
            done_legs=ctx.done_legs,
            checkin_id=checkin_id,
            reason_codes=plan_codes,
        )
        plan_store.close_open_options(db, trip.trip_id)
        plan_store.add_plan(db, plan, legs)
        plan_store.activate(db, plan)
        shifted_by = ctx.behind_min
        moved_stops = len(decision.plan.legs)  # type: ignore[union-attr]
        _log(db, trip, now, "shift", f"Shifted {moved_stops} stops by {shifted_by} min", automatic, plan, previous, codes)
        db.commit()
        events.publish(trip.trip_id, "plan_updated", _plan_event(plan, notify=(not automatic) or events.may_alert(trip.trip_id)))
        return LoopOutcome(result="shifted", reason_codes=codes, explanation=decision.explanation, plan=plan)

    if decision.result == "options":
        plan_store.close_open_options(db, trip.trip_id)
        set_id = new_id("opts")
        rows: list[Plan] = []
        for option in decision.options:
            option_meta = {
                "optionId": option.option_id,
                "kind": option.kind,
                "label": option.label,
                "consequence": option.consequence,
                "explanation": option.explanation,
                "timeSavedMin": option.time_saved_min,
                "extraFareInr": option.extra_fare_inr,
                "movedTasks": list(option.moved_tasks),
                "skippedTasks": list(option.skipped_tasks),
                "reasonCodes": [c.value for c in option.reason_codes],
                "setReasonCodes": codes,
                "setExplanation": decision.explanation,
                "delayMin": delay_min,
            }
            trigger = "skipped" if option.kind == "skip_task" else "late"
            plan, legs = plan_store.new_plan_row(
                trip,
                ctx.day,
                inp,
                option.plan,
                status="proposed",
                trigger=trigger,
                explanation=option.explanation,
                done_legs=ctx.done_legs,
                checkin_id=checkin_id,
                option_set_id=set_id,
                option_id=option.option_id,
                option=option_meta,
            )
            plan_store.add_plan(db, plan, legs)
            rows.append(plan)
        db.commit()
        events.publish(trip.trip_id, "options_ready", {"optionSetId": set_id, "reasonCodes": codes, "explanation": decision.explanation, "count": len(rows)})
        return LoopOutcome(result="options", reason_codes=codes, explanation=decision.explanation, options=rows, option_set_id=set_id)

    blocked = decision.blocked.model_dump(mode="json") if decision.blocked else None
    if blocked:
        blocked = {"taskId": blocked["task_id"], "title": blocked["title"], "reason": blocked["reason"]}
    return LoopOutcome(result="no_feasible_plan", reason_codes=codes, explanation=decision.explanation, blocked=blocked)


def open_options(db: Session, trip_id: str) -> list[Plan]:
    return list(db.scalars(select(Plan).where(Plan.trip_id == trip_id, Plan.status == "proposed", Plan.option_set_id.is_not(None)).order_by(Plan.option_id)))


def accept(db: Session, trip: Trip, option_id: str, now: datetime) -> Plan:
    """The traveller chose an option: it becomes the next active version."""
    options = open_options(db, trip.trip_id)
    chosen = next((p for p in options if p.option_id == option_id), None)
    if chosen is None:
        raise ApiError(409, "That option is no longer open. Check your timeline for the latest plan.", code="OPTION_CLOSED")
    previous = plan_store.active_plan(db, trip.trip_id)
    for p in options:
        if p.plan_id != chosen.plan_id:
            p.status = "superseded"
    plan_store.activate(db, chosen)
    meta = chosen.option or {}
    if meta.get("kind") == "faster_mode":
        text = (
            f"{meta.get('label', 'Changed the plan')}, +{rupees(meta.get('extraFareInr', 0))}"
            if meta.get("extraFareInr")
            else meta.get("label", "Changed the plan")
        )
    elif meta.get("kind") == "move_task":
        text = meta.get("consequence", "Moved a task to tomorrow").replace("The ", "Moved the ", 1).replace(" moves to", " to", 1)
    else:
        text = meta.get("consequence", "Skipped a task")
    _log(db, trip, now, "option", text, False, chosen, previous, list(chosen.reason_codes))
    db.commit()
    events.publish(trip.trip_id, "plan_updated", _plan_event(chosen, notify=False))
    return chosen


def undo_to(db: Session, trip: Trip, version: int, now: datetime) -> Plan:
    """Make an earlier version active again; the current one becomes superseded."""
    target = plan_store.get_version(db, trip.trip_id, version)
    current = plan_store.active_plan(db, trip.trip_id)
    if current is not None and current.plan_id == target.plan_id:
        return target
    if target.status != "superseded":
        raise ApiError(409, "Only an earlier version can be made active again.")
    if current is not None and current.day != target.day:
        raise ApiError(409, "That version belongs to another day.")
    plan_store.close_open_options(db, trip.trip_id)
    plan_store.activate(db, target)
    entry = db.scalar(
        select(RerouteLog).where(
            RerouteLog.trip_id == trip.trip_id, RerouteLog.plan_id == (current.plan_id if current else None), RerouteLog.undone_at.is_(None)
        )
    )
    if entry is not None:
        entry.undone_at = now
    _log(db, trip, now, "undo", f"Undid the change. Version {target.version} is back", False, target, current, [])
    db.commit()
    events.publish(trip.trip_id, "plan_updated", _plan_event(target, notify=False))
    return target
