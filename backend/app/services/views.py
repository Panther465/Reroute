"""Read models: the trip screen, open options, the Reroute log, the day summary and the family view."""

from __future__ import annotations

from datetime import date, datetime

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.clock import tz_for
from app.models import Place, Plan, RerouteLog, Task, Trip
from app.schemas import (
    LogEntryOut,
    OptionOut,
    OptionSetOut,
    PlaceOut,
    SegmentOut,
    SharedLegOut,
    SharedStopOut,
    SharedTripOut,
    SummaryLegOut,
    SummaryOut,
    SummaryTaskOut,
    TaskOut,
    TotalsOut,
    TripOut,
    TripSummaryOut,
    WindowOut,
)
from app.services import plan_store
from app.services.day import trip_day
from app.services.loop import open_options
from app.services.planner.util import count_word, rupees


def place_out(place: Place) -> PlaceOut:
    return PlaceOut(place_id=place.place_id, name=place.name, area=place.area, lng=place.lng, lat=place.lat, sample=place.sample)


def task_out(task: Task) -> TaskOut:
    window = WindowOut(opens_at=task.opens_at, closes_at=task.closes_at) if task.opens_at and task.closes_at else None
    return TaskOut(
        task_id=task.task_id,
        trip_id=task.trip_id,
        title=task.title,
        place_id=task.place_id,
        place=place_out(task.place),
        duration_min=task.duration_min,
        fixed_start=task.fixed_start,
        window=window,
        priority=task.priority,
        state=task.state,  # type: ignore[arg-type]
        hours_unknown=task.hours_unknown,
        day=task.day,
    )


def trip_summary_out(trip: Trip) -> TripSummaryOut:
    return TripSummaryOut(
        trip_id=trip.trip_id,
        city_slug=trip.city_slug,
        city_name=trip.city_name,
        start_date=trip.start_date,
        end_date=trip.end_date,
        stay_label=trip.stay_label,
        sample=trip.sample,
    )


def options_out(plans: list[Plan]) -> OptionSetOut | None:
    if not plans:
        return None
    first = plans[0].option or {}
    options = []
    for p in plans:
        meta = p.option or {}
        options.append(
            OptionOut(
                option_id=meta["optionId"],
                kind=meta["kind"],
                label=meta["label"],
                consequence=meta["consequence"],
                explanation=meta["explanation"],
                time_saved_min=meta["timeSavedMin"],
                extra_fare_inr=meta["extraFareInr"],
                moved_tasks=meta["movedTasks"],
                skipped_tasks=meta["skippedTasks"],
                reason_codes=meta["reasonCodes"],
                plan=plan_store.plan_out(p),
            )
        )
    return OptionSetOut(
        option_set_id=plans[0].option_set_id or "", reason_codes=first.get("setReasonCodes", []), explanation=first.get("setExplanation", ""), options=options
    )


def log_out(db: Session, trip_id: str) -> list[LogEntryOut]:
    entries = list(db.scalars(select(RerouteLog).where(RerouteLog.trip_id == trip_id).order_by(RerouteLog.at.desc(), RerouteLog.log_id.desc()).limit(50)))
    active = plan_store.active_plan(db, trip_id)
    previous_ids = {e.previous_plan_id for e in entries if e.previous_plan_id}
    versions = {p.plan_id: p.version for p in db.scalars(select(Plan).where(Plan.plan_id.in_(previous_ids)))} if previous_ids else {}
    out = []
    for e in entries:
        can_undo = e.undone_at is None and e.kind != "undo" and active is not None and e.plan_id == active.plan_id and e.previous_plan_id is not None
        out.append(
            LogEntryOut(
                log_id=e.log_id,
                at=e.at,
                kind=e.kind,
                text=e.text,
                automatic=e.automatic,
                plan_id=e.plan_id,
                previous_plan_id=e.previous_plan_id,
                previous_version=versions.get(e.previous_plan_id or ""),
                reason_codes=list(e.reason_codes or []),
                undone=e.undone_at is not None,
                can_undo=can_undo,
            )
        )
    return out


def trip_out(db: Session, trip: Trip, now: datetime) -> TripOut:
    day = trip_day(trip, now)
    plan = plan_store.active_plan(db, trip.trip_id)
    tasks = list(db.scalars(select(Task).where(Task.trip_id == trip.trip_id).order_by(Task.day, Task.created_at)))
    stay = db.get(Place, trip.stay_place_id)
    return TripOut(
        **trip_summary_out(trip).model_dump(),
        utc_offset=trip.utc_offset,
        stay_place=place_out(stay),  # type: ignore[arg-type]
        tasks=[task_out(t) for t in tasks],
        active_plan=plan_store.plan_out(plan) if plan else None,
        open_options=options_out(open_options(db, trip.trip_id)),
        log=log_out(db, trip.trip_id),
        now=now.astimezone(tz_for(trip.utc_offset)),
        day=day,
        day_index=(day - trip.start_date).days + 1,
        day_count=(trip.end_date - trip.start_date).days + 1,
    )


def _place_names(db: Session, ids: set[str]) -> dict[str, Place]:
    return {p.place_id: p for p in db.scalars(select(Place).where(Place.place_id.in_(ids)))} if ids else {}


def summary_out(db: Session, trip: Trip, day: date) -> SummaryOut:
    plan = plan_store.active_plan(db, trip.trip_id)
    legs = (list(plan.done_legs or []) + list(plan.legs)) if plan and plan.day == day else []
    places = _place_names(db, {x["fromPlaceId"] for x in legs} | {x["toPlaceId"] for x in legs})

    def name(pid: str) -> str:
        if pid == trip.stay_place_id:
            return "Hotel"
        p = places.get(pid)
        return p.area if p else pid

    tasks = list(db.scalars(select(Task).where(Task.trip_id == trip.trip_id, Task.planned_day == day).order_by(Task.created_at)))
    times = {x["taskId"]: (x["taskStart"], x["taskEnd"]) for x in legs if x.get("taskId")}
    moved_to = {m["taskId"]: m.get("toDayStart") for m in (plan.moved if plan else [])}
    summary_tasks = [
        SummaryTaskOut(
            task_id=t.task_id,
            title=t.title,
            area=t.place.area,
            state=t.state,
            start=times.get(t.task_id, (None, None))[0],
            end=times.get(t.task_id, (None, None))[1],
            moved_to=moved_to.get(t.task_id),
        )
        for t in tasks
    ]
    summary_legs = [
        SummaryLegOut(
            from_name=name(x["fromPlaceId"]),
            to_name=name(x["toPlaceId"]),
            label=x["label"],
            mode=x["mode"],
            segments=[SegmentOut.model_validate(s) for s in x["segments"]],
            travel_min=x["travelMin"],
            fare_inr=x["fareInr"],
        )
        for x in legs
    ]
    reroutes = [
        e.at
        for e in db.scalars(
            select(RerouteLog)
            .where(RerouteLog.trip_id == trip.trip_id, RerouteLog.undone_at.is_(None), RerouteLog.kind.in_(("shift", "option")))
            .order_by(RerouteLog.at)
        )
    ]
    travel = sum(x.travel_min for x in summary_legs)
    fare = sum(x.fare_inr for x in summary_legs)
    wait = sum(x.get("waitMin", 0) for x in legs)
    done = [t for t in tasks if t.state == "done"]
    tz = tz_for(trip.utc_offset)
    when = ", ".join(r.astimezone(tz).strftime("%H:%M") for r in reroutes)
    headline = (f"All {count_word(len(tasks))} tasks done." if tasks and len(done) == len(tasks) else f"{len(done)} of {len(tasks)} tasks done.") + (
        " No reroutes." if not reroutes else f" Rerouted once, at {when}." if len(reroutes) == 1 else f" Rerouted {len(reroutes)} times, at {when}."
    )
    hours, minutes = divmod(travel, 60)
    travelling = f"{hours} h {minutes} min" if hours and minutes else f"{hours} h" if hours else f"{minutes} min"
    lines = [f"Travel expenses, {trip.city_name}, {day.strftime('%A %d %B %Y')}", "Estimates, not receipts.", ""]
    lines += [f"{(x.from_name + ' to ' + x.to_name):<34} {x.label:<26} {rupees(x.fare_inr):>7}" for x in summary_legs]
    lines += ["-" * 69, f"{'Total, ' + travelling + ' travelling':<61} {rupees(fare):>7}"]
    return SummaryOut(
        trip_id=trip.trip_id,
        day=day,
        city_name=trip.city_name,
        tasks=summary_tasks,
        legs=summary_legs,
        totals=TotalsOut(travel_min=travel, fare_inr=fare, wait_min=wait),
        reroutes=reroutes,
        headline=headline,
        slip_text="\n".join(lines),
    )


def shared_out(db: Session, trip: Trip, traveller_name: str, now: datetime, updated: datetime | None) -> SharedTripOut:
    """What family sees: stops and progress. No coordinates, no exact location."""
    day = trip_day(trip, now)
    plan = plan_store.active_plan(db, trip.trip_id)
    legs = (list(plan.done_legs or []) + list(plan.legs)) if plan else []
    tasks = {t.task_id: t for t in db.scalars(select(Task).where(Task.trip_id == trip.trip_id))}
    stay = db.get(Place, trip.stay_place_id)
    stops: list[SharedStopOut] = []
    shared_legs: list[SharedLegOut] = []
    if legs:
        stops.append(
            SharedStopOut(title="Hotel", area=stay.area if stay else "", time=datetime.fromisoformat(legs[0]["leaveBy"]), end=None, status="done", fixed=False)
        )
    now_set = False
    for leg in legs:
        task = tasks.get(leg.get("taskId") or "")
        state = task.state if task else None
        arrive = datetime.fromisoformat(leg["arriveAt"])
        if state == "done":
            status = "done"
        elif not now_set and (task is None or state not in ("skipped", "moved")):
            status, now_set = ("now" if datetime.fromisoformat(leg["leaveBy"]) <= now else "upcoming"), True
        else:
            status = "upcoming"
        leg_status = "done" if state == "done" else ("active" if status == "now" else "upcoming")
        shared_legs.append(
            SharedLegOut(
                label=leg["label"],
                mode=leg["mode"],
                segments=[SegmentOut.model_validate(s) for s in leg["segments"]],
                leave_by=datetime.fromisoformat(leg["leaveBy"]),
                arrive_at=arrive,
                travel_min=leg["travelMin"],
                status=leg_status,
            )
        )
        if task is not None:
            stops.append(
                SharedStopOut(
                    title=task.title,
                    area=task.place.area,
                    time=datetime.fromisoformat(leg["taskStart"]),
                    end=datetime.fromisoformat(leg["taskEnd"]),
                    status=status,
                    fixed=task.fixed_start is not None,
                )
            )  # type: ignore[arg-type]
        else:
            stops.append(SharedStopOut(title="Hotel", area=stay.area if stay else "", time=arrive, end=None, status=status, fixed=False))  # type: ignore[arg-type]
    return SharedTripOut(
        traveller_first_name=traveller_name.split(" ")[0] if traveller_name else "Traveller",
        city_name=trip.city_name,
        day=day,
        updated_at=updated or (plan.activated_at if plan and plan.activated_at else now),
        now=now,
        stops=stops,
        legs=shared_legs,
    )
