"""The re-plan loop (section 10): sense, detect, decide, act, explain.

It runs in the worker after every check-in, every 5 minutes during an active trip, and when the
traveller taps Running late. It decides with the deterministic planner and acts only within limits:
- on its own it may only shift times;
- a dearer mode, a moved task or a skipped task always waits for the traveller's choice;
- a trip has at most one open set of options; a new run replaces it;
- every action is logged and can be undone.
"""

from __future__ import annotations

import hashlib
from dataclasses import dataclass, field
from datetime import date, datetime, timedelta

from sqlalchemy import func, select
from sqlalchemy.exc import OperationalError
from sqlalchemy.orm import Session

from app import events
from app.adapters.travel_times import TravelTimeAdapter
from app.clock import minutes_of_day
from app.errors import ApiError
from app.models import Plan, RerouteLog, Trip, new_id
from app.redis_client import get_redis
from app.services import morning, plan_store
from app.services.day import RULE, DayContext, build_input, fetch_snapshot, needed_places, sense
from app.services.planner import Objective, ReplanInput, ReplanOption, ReplanResult, TravelSnapshot, explain, plan_day, replan
from app.services.planner.hashing import canonical_json
from app.services.planner.util import rupees

#: How long a run waits for another run on the same trip before answering 409 BUSY.
LOCK_TIMEOUT = "5s"
_LOCK_NOT_AVAILABLE = "55P03"
_REPLANNED = {"edited": "Re-planned after an edit", "skipped": "Re-planned after a skip", "morning": "Planned today's stops in the morning"}


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


def lock_trip(db: Session, trip_id: str) -> None:
    """Serialise changes to one trip's plans across API copies and workers (row lock until commit).

    FOR NO KEY UPDATE, not FOR UPDATE: a check-in or a task saved meanwhile only needs a key-share
    lock on the trip for its foreign key, so it doesn't queue behind a running re-plan. A run that
    can't get the lock within LOCK_TIMEOUT answers 409 BUSY instead of hanging.
    """
    try:
        if db.get_bind().dialect.name == "postgresql":
            db.execute(select(func.set_config("lock_timeout", LOCK_TIMEOUT, True)))
        db.execute(select(Trip.trip_id).where(Trip.trip_id == trip_id).with_for_update(key_share=True))
    except OperationalError as exc:
        db.rollback()
        if getattr(exc.orig, "sqlstate", None) == _LOCK_NOT_AVAILABLE:
            raise ApiError(409, "Reroute is still updating this trip. Try again in a moment.", code="BUSY") from exc
        raise


def _locked(
    db: Session, trip: Trip, now: datetime, first: DayContext, gathered: tuple[frozenset[str], TravelSnapshot] | None, **sense_kw
) -> tuple[DayContext, tuple[frozenset[str], TravelSnapshot] | None]:
    """Lock the trip, then sense again: a check-in or edit may have landed while travel times were fetched.

    Travel times are fetched before the lock (Raasta and OSRM are network calls) and again under it
    only if the day or the places changed meanwhile.
    """
    lock_trip(db, trip.trip_id)
    db.expire_all()
    ctx = sense(db, trip, now, **sense_kw)
    if gathered is not None and ctx.day != first.day:
        gathered = None
    return ctx, gathered


def _snapshot(
    db: Session, ctx: DayContext, adapter: TravelTimeAdapter, gathered: tuple[frozenset[str], TravelSnapshot] | None, include_unplaced: bool = False
) -> TravelSnapshot:
    places = needed_places(ctx, include_unplaced)
    if gathered is not None and gathered[0] == places:
        return gathered[1]
    return fetch_snapshot(db, ctx, adapter, places)


def _gather(db: Session, ctx: DayContext, adapter: TravelTimeAdapter, include_unplaced: bool = False) -> tuple[frozenset[str], TravelSnapshot]:
    places = needed_places(ctx, include_unplaced)
    return places, fetch_snapshot(db, ctx, adapter, places)


def create_plan(db: Session, trip: Trip, adapter: TravelTimeAdapter, now: datetime, trigger: str = "created", checkin_id: str | None = None) -> Plan:
    """Plan the rest of the day from scratch (a new trip, an edit, a skip or the morning) and make it active.

    Tasks the previous version couldn't fit ("unplaced") are tried again. The morning run plans only a
    day that is still due (checked again under the lock) and starts from the place of stay.
    """
    first = sense(db, trip, now)
    ctx, gathered = _locked(db, trip, now, first, _gather(db, first, adapter, include_unplaced=True))
    if trigger == "morning" and (ctx.active is not None or morning.due_day(db, trip, now) != ctx.day):
        raise ApiError(409, "This day doesn't need a morning plan any more.", code="NOT_DUE")
    inp = build_input(ctx, _snapshot(db, ctx, adapter, gathered, include_unplaced=True), Objective(allow_unplace=True), include_unplaced=True)
    result = plan_day(inp)
    if not result.feasible:
        reason = result.blocked.reason if result.blocked else "No plan keeps every fixed time"
        blocked = {"taskId": result.blocked.task_id, "title": result.blocked.title, "reason": result.blocked.reason} if result.blocked else None
        raise ApiError(409, f"{reason}. Move it to another day or change it.", code="NO_FEASIBLE_PLAN", extra={"blocked": blocked})
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
    if trigger in _REPLANNED:
        _log(db, trip, now, trigger, _REPLANNED[trigger], trigger == "morning", plan, previous, list(plan.reason_codes))
    db.commit()
    # The morning plan is news: the traveller didn't ask for it, so the phone may say so.
    events.publish(trip.trip_id, "plan_updated", _plan_event(plan, notify=trigger == "morning"))
    return plan


def _day_done(ctx: DayContext) -> bool:
    return ctx.day_finished or (not ctx.remaining_legs and ctx.current is None)


def _will_decide(ctx: DayContext, automatic: bool) -> bool:
    """Whether this run will need travel times (fetched before the lock, so a quiet check fetches none)."""
    return ctx.active is not None and not _day_done(ctx) and not (automatic and ctx.behind_min <= 0)


def _shift_text(stops: int, minutes: int) -> str:
    what = f"{stops} {'stop' if stops == 1 else 'stops'}"
    if minutes > 0:
        return f"Shifted {what} by {minutes} min"
    if minutes < 0:
        return f"Moved {what} {-minutes} min earlier"
    return f"Re-timed {what}"


def option_set_hash(day: date, options: tuple[ReplanOption, ...] | list[ReplanOption]) -> str:
    """What makes two option sets the same choice: kinds, task order, leave-by times, moved and skipped
    tasks, extra fare, time saved and each option's reason codes. Free text is left out, and so are the
    set's own codes: a delay reported on the way to a fixed task adds FIXED_TASK_AT_RISK to the check-in's
    run but not to the 5-minute check's, though the choices are the same."""
    canonical = {
        "day": day.isoformat(),
        "options": [
            {
                "id": o.option_id,
                "kind": o.kind,
                "order": [[task_id, option_id] for task_id, option_id in o.plan.order()],
                "leaveBy": [leg.leave_by for leg in o.plan.legs],
                "moved": list(o.moved_tasks),
                "skipped": list(o.skipped_tasks),
                "extraFareInr": o.extra_fare_inr,
                "timeSavedMin": o.time_saved_min,
                "reasonCodes": [c.value for c in o.reason_codes],
            }
            for o in options
        ],
    }
    return hashlib.sha256(canonical_json(canonical).encode("utf-8")).hexdigest()


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
    sense_kw = {"delay_min": delay_min, "done_at": done_at}
    first = sense(db, trip, now, **sense_kw)
    gathered = _gather(db, first, adapter) if _will_decide(first, automatic) else None
    ctx, gathered = _locked(db, trip, now, first, gathered, **sense_kw)
    if ctx.active is None:
        return LoopOutcome(result="on_time", reason_codes=["ON_TIME"], explanation="There's no plan for today yet.")
    waiting = open_options(db, trip.trip_id)
    if _day_done(ctx):
        # Every task is done, skipped or moved: the way home isn't re-timed again and again.
        _close_options(db, trip.trip_id, waiting)
        db.commit()
        return LoopOutcome(result="on_time", reason_codes=["ON_TIME"], explanation="Your tasks for today are done.", plan=ctx.active)
    if automatic and ctx.behind_min <= 0:
        # Detect first: the automatic check changes nothing unless the traveller is behind.
        return LoopOutcome(result="on_time", reason_codes=["ON_TIME"], explanation=explain.on_time(), plan=ctx.active)

    inp = build_input(ctx, _snapshot(db, ctx, adapter, gathered))
    decision: ReplanResult = replan(_replan_input(ctx, inp, automatic))
    codes = [c.value for c in decision.reason_codes]
    explanation = decision.explanation
    if ctx.fixed_at_risk is not None:
        task, arrival = ctx.fixed_at_risk
        if "FIXED_TASK_AT_RISK" not in codes:
            codes.append("FIXED_TASK_AT_RISK")
        starts = minutes_of_day(task.fixed_start, ctx.day, ctx.tz)  # type: ignore[arg-type]
        explanation = f"{explain.fixed_at_risk(task.title, arrival, starts, RULE.fixed_buffer_min)} {explanation}"
    # Tasks the active version couldn't fit stay named in every re-planned version.
    carried = ctx.carried_unplaced()

    if decision.result == "on_time":
        _close_options(db, trip.trip_id, waiting)
        db.commit()
        return LoopOutcome(result="on_time", reason_codes=codes, explanation=explanation, plan=ctx.active)

    if decision.result == "shifted" and automatic and waiting:
        # Options are waiting for the traveller: the automatic check never shifts underneath them.
        return LoopOutcome(result="options", reason_codes=codes, explanation=explanation, options=waiting, option_set_id=waiting[0].option_set_id)

    if decision.result == "shifted":
        previous = ctx.active
        plan_codes = codes + [c.value for c in decision.plan.reason_codes if c.value not in codes]  # type: ignore[union-attr]
        plan, legs = plan_store.new_plan_row(
            trip,
            ctx.day,
            inp,
            decision.plan,  # type: ignore[arg-type]
            status="proposed",
            trigger="late",
            explanation=explanation,
            done_legs=ctx.done_legs,
            checkin_id=checkin_id,
            reason_codes=plan_codes,
            carried_moved=carried,
        )
        _close_options(db, trip.trip_id, waiting)
        plan_store.add_plan(db, plan, legs)
        plan_store.activate(db, plan)
        old_leave = minutes_of_day(datetime.fromisoformat(ctx.remaining_legs[0]["leaveBy"]), ctx.day, ctx.tz) if ctx.remaining_legs else None
        new_leave = decision.plan.legs[0].leave_by  # type: ignore[union-attr]
        stops = len(decision.plan.legs)  # type: ignore[union-attr]
        _log(db, trip, now, "shift", _shift_text(stops, new_leave - old_leave if old_leave is not None else ctx.behind_min), automatic, plan, previous, codes)
        db.commit()
        events.publish(trip.trip_id, "plan_updated", _plan_event(plan, notify=(not automatic) or events.may_alert(trip.trip_id)))
        return LoopOutcome(result="shifted", reason_codes=codes, explanation=explanation, plan=plan)

    if decision.result == "options":
        set_hash = option_set_hash(ctx.day, decision.options)
        if waiting and all((p.option or {}).get("setHash") == set_hash for p in waiting):
            # The same choices are already waiting: keep that set and its ID, so the traveller's choice
            # from it still applies (a new set every 5 minutes made accepting fail with OPTIONS_CHANGED).
            meta = waiting[0].option or {}
            return LoopOutcome(
                result="options",
                reason_codes=meta.get("setReasonCodes", codes),
                explanation=meta.get("setExplanation", explanation),
                options=waiting,
                option_set_id=waiting[0].option_set_id,
            )
        # One open set per trip: a fresh run replaces it, so options that stopped being feasible drop out.
        _close_options(db, trip.trip_id, waiting)
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
                "setExplanation": explanation,
                "setHash": set_hash,
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
                carried_moved=carried,
            )
            plan_store.add_plan(db, plan, legs)
            rows.append(plan)
        db.commit()
        events.publish(trip.trip_id, "options_ready", {"optionSetId": set_id, "reasonCodes": codes, "explanation": explanation, "count": len(rows)})
        return LoopOutcome(result="options", reason_codes=codes, explanation=explanation, options=rows, option_set_id=set_id)

    # Nothing keeps every fixed time: options that can no longer be met are dropped.
    _close_options(db, trip.trip_id, waiting)
    db.commit()
    blocked = decision.blocked.model_dump(mode="json") if decision.blocked else None
    if blocked:
        blocked = {"taskId": blocked["task_id"], "title": blocked["title"], "reason": blocked["reason"]}
    return LoopOutcome(result="no_feasible_plan", reason_codes=codes, explanation=explanation, blocked=blocked)


def _close_options(db: Session, trip_id: str, waiting: list[Plan]) -> None:
    if waiting:
        plan_store.close_open_options(db, trip_id)
        db.flush()


def open_options(db: Session, trip_id: str) -> list[Plan]:
    return list(db.scalars(select(Plan).where(Plan.trip_id == trip_id, Plan.status == "proposed", Plan.option_set_id.is_not(None)).order_by(Plan.option_id)))


def accept(db: Session, trip: Trip, option_id: str, now: datetime, option_set_id: str | None = None) -> Plan:
    """The traveller chose an option: it becomes the next active version.

    The client names the option set it showed. If the 5-minute check has replaced the set since,
    "opt-1" may now mean something else, so the choice is refused rather than applied.
    """
    lock_trip(db, trip.trip_id)
    options = open_options(db, trip.trip_id)
    chosen = next((p for p in options if p.option_id == option_id), None)
    if chosen is None:
        raise ApiError(409, "That option is no longer open. Check your timeline for the latest plan.", code="OPTION_CLOSED")
    if option_set_id is not None and chosen.option_set_id != option_set_id:
        raise ApiError(409, "Your options changed. Check them again before choosing.", code="OPTIONS_CHANGED")
    first = chosen.legs[0] if chosen.legs else None
    if first is not None and datetime.fromisoformat(first["leaveBy"]) < now - timedelta(minutes=10):
        raise ApiError(409, "That option needed you to leave earlier. Report the delay again for fresh options.", code="OPTION_EXPIRED")
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
    lock_trip(db, trip.trip_id)
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
    # Undo means "not that change": forget the delay it was based on, or the next check re-applies it.
    forget_reported_delays(trip.trip_id)
    events.publish(trip.trip_id, "plan_updated", _plan_event(target, notify=False))
    return target


def forget_reported_delays(trip_id: str) -> None:
    """What Undo forgets: the delays the undone change was based on."""
    r = get_redis()
    for key in r.scan_iter(match=f"reported_ready:{trip_id}:*"):
        r.delete(key)


def forget_trip_state(trip_id: str) -> None:
    """Everything Redis remembers about a trip's days: reported delays, the alert throttle, the trip-ended
    flag, the 5-minute check's lock and morning plans. A demo reset starts the day again with none of it."""
    forget_reported_delays(trip_id)
    r = get_redis()
    for key in r.scan_iter(match=f"morning_plan:{trip_id}:*"):
        r.delete(key)
    r.delete(f"trip_ended:{trip_id}", f"alert_throttle:{trip_id}", f"check_lock:{trip_id}")
