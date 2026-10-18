"""Trips, tasks, plans, check-ins, options, Undo, the summary and calendar import.

Handlers validate, save and enqueue. Planning always runs in the worker (section 6); a check-in
waits briefly for the worker's answer so the phone gets options in one round trip.
"""

from __future__ import annotations

import base64
import time
from datetime import date, datetime
from datetime import time as dtime
from typing import Annotated

from fastapi import APIRouter, Query, Response
from rq.job import Job
from sqlalchemy import and_, or_, select
from sqlalchemy.exc import IntegrityError

from app import events
from app.adapters.google import calendar_events
from app.clock import now_for, set_demo_now, tz_for
from app.config import get_settings
from app.deps import CurrentUser, Db, OwnedTrip
from app.errors import ApiError
from app.models import Checkin, Place, Plan, Task, Trip
from app.schemas import (
    AcceptIn,
    ActivateIn,
    Api,
    BlockedOut,
    CalendarImportIn,
    CheckinIn,
    CheckinOut,
    DemoClockIn,
    JobAccepted,
    JobOut,
    Page,
    PlanOut,
    PlanRequest,
    PostBody,
    SummaryOut,
    TaskDraftOut,
    TaskIn,
    TaskOut,
    TaskPatch,
    TripIn,
    TripOut,
    TripSummaryOut,
)
from app.services import loop, plan_store
from app.services.day import trip_day
from app.services.views import options_out, summary_out, task_out, trip_out, trip_summary_out
from app.workers import jobs
from app.workers.queue import get_queue

router = APIRouter(prefix="/v1", tags=["trips"])


class TaskEditOut(Api):
    task: TaskOut
    job_id: str | None = None


# ---------- helpers ----------


def _place(db, place_id: str, city_slug: str) -> Place:
    place = db.get(Place, place_id)
    if place is None or place.city_slug != city_slug:
        raise ApiError(422, "Choose a place from the search results.", code="VALIDATION_ERROR")
    return place


def _wait(job: Job, seconds: float) -> dict | None:
    deadline = time.monotonic() + seconds
    while True:
        status = job.get_status(refresh=True)
        if status == "finished":
            return job.return_value()
        if status == "failed" or time.monotonic() > deadline:
            return None
        time.sleep(0.05)


def _owned_job(job_id: str, user, db) -> Job:
    try:
        job = Job.fetch(job_id, connection=get_queue().connection)
    except Exception as exc:
        raise ApiError(404, "Job not found.") from exc
    trip = db.get(Trip, job.args[0]) if job.args else None
    if trip is None or (trip.user_id != user.user_id and user.role != "admin"):
        raise ApiError(404, "Job not found.")
    return job


def _checkin_out(db, trip: Trip, checkin: Checkin, outcome: dict | None, job_id: str | None) -> CheckinOut:
    active = plan_store.active_plan(db, trip.trip_id)
    if outcome is None:
        return CheckinOut(checkin_id=checkin.checkin_id, plan_id=active.plan_id if active else None, result="pending", job_id=job_id)
    if "error" in outcome:
        raise ApiError(409, outcome["error"], code=outcome.get("code", "CONFLICT"))
    result = outcome.get("result", "recorded")
    plan = db.get(Plan, outcome["planId"]) if outcome.get("planId") else None
    options = options_out(loop.open_options(db, trip.trip_id)) if result == "options" else None
    blocked = BlockedOut.model_validate(outcome["blocked"]) if outcome.get("blocked") else None
    return CheckinOut(
        checkin_id=checkin.checkin_id,
        plan_id=(plan.plan_id if plan and result == "shifted" else active.plan_id if active else None),
        result=result,
        reason_codes=outcome.get("reasonCodes", []),
        explanation=outcome.get("explanation", ""),
        plan=plan_store.plan_out(plan) if plan is not None and result in ("shifted", "recorded") else None,
        options=options.options if options else [],
        blocked=blocked,
        job_id=job_id,
    )


# ---------- trips ----------


@router.post("/trips", response_model=TripOut, response_model_by_alias=True, status_code=201)
def create_trip(body: TripIn, user: CurrentUser, db: Db) -> TripOut:
    place = _place(db, body.stay_place_id, body.city_slug)
    trip = Trip(
        user_id=user.user_id,
        city_slug=body.city_slug,
        city_name=body.city_name,
        start_date=body.start_date,
        end_date=body.end_date,
        stay_place_id=place.place_id,
        stay_label=body.stay_label,
    )
    db.add(trip)
    db.commit()
    return trip_out(db, trip, now_for(trip.trip_id))


@router.get("/trips", response_model=Page[TripSummaryOut], response_model_by_alias=True)
def list_trips(user: CurrentUser, db: Db, cursor: str | None = None, limit: Annotated[int, Query(ge=1, le=100)] = 20) -> Page[TripSummaryOut]:
    stmt = select(Trip).where(Trip.user_id == user.user_id)
    if cursor:
        try:
            start_date, trip_id = base64.urlsafe_b64decode(cursor.encode()).decode().split("|", 1)
        except Exception as exc:
            raise ApiError(400, "That cursor isn't valid.") from exc
        stmt = stmt.where(or_(Trip.start_date < start_date, and_(Trip.start_date == start_date, Trip.trip_id < trip_id)))
    rows = list(db.scalars(stmt.order_by(Trip.start_date.desc(), Trip.trip_id.desc()).limit(limit + 1)))
    next_cursor = None
    if len(rows) > limit:
        last = rows[limit - 1]
        next_cursor = base64.urlsafe_b64encode(f"{last.start_date.isoformat()}|{last.trip_id}".encode()).decode()
        rows = rows[:limit]
    return Page[TripSummaryOut](items=[trip_summary_out(t) for t in rows], next_cursor=next_cursor)


@router.get("/trips/{trip_id}", response_model=TripOut, response_model_by_alias=True)
def get_trip(trip: OwnedTrip, db: Db) -> TripOut:
    return trip_out(db, trip, now_for(trip.trip_id))


# ---------- tasks ----------


@router.post("/trips/{trip_id}/tasks", response_model=TaskOut, response_model_by_alias=True, status_code=201)
def add_task(body: TaskIn, trip: OwnedTrip, db: Db) -> TaskOut:
    _place(db, body.place_id, trip.city_slug)
    tz = tz_for(trip.utc_offset)
    day = body.day or (body.fixed_start.astimezone(tz).date() if body.fixed_start else trip.start_date)
    if not trip.start_date <= day <= trip.end_date:
        raise ApiError(422, "The task must fall within the trip's dates.", code="VALIDATION_ERROR")
    if body.fixed_start and body.fixed_start.astimezone(tz).date() != day:
        raise ApiError(422, "fixedStart must be on the task's day.", code="VALIDATION_ERROR")
    task = Task(
        trip_id=trip.trip_id,
        title=body.title,
        place_id=body.place_id,
        duration_min=body.duration_min,
        fixed_start=body.fixed_start,
        opens_at=body.window.opens_at if body.window else None,
        closes_at=body.window.closes_at if body.window else None,
        day=day,
        planned_day=day,
        priority=body.priority,
        hours_unknown=body.hours_unknown,
    )
    db.add(task)
    db.commit()
    db.refresh(task)
    return task_out(task)


@router.patch("/trips/{trip_id}/tasks/{task_id}", response_model=TaskEditOut, response_model_by_alias=True)
def edit_task(task_id: str, body: TaskPatch, trip: OwnedTrip, db: Db) -> TaskEditOut:
    task = db.get(Task, task_id)
    if task is None or task.trip_id != trip.trip_id:
        raise ApiError(404, "Task not found.")
    if task.state == "done":
        raise ApiError(409, "This task is already done.")
    data = body.model_dump(exclude_unset=True)
    if "place_id" in data and data["place_id"]:
        _place(db, data["place_id"], trip.city_slug)
        task.place_id = data["place_id"]
    for field in ("title", "duration_min", "priority", "hours_unknown"):
        if data.get(field) is not None:
            setattr(task, field, data[field])
    timing = data.get("timing")
    if timing == "fixed" or (timing is None and data.get("fixed_start")):
        if not body.fixed_start or body.fixed_start.tzinfo is None:
            raise ApiError(422, "Enter the start time with its UTC offset.", code="VALIDATION_ERROR")
        task.fixed_start, task.opens_at, task.closes_at = body.fixed_start, None, None
    elif timing == "window" or (timing is None and body.window is not None):
        if body.window is None:
            raise ApiError(422, "Enter when it opens and closes.", code="VALIDATION_ERROR")
        task.fixed_start, task.opens_at, task.closes_at = None, body.window.opens_at, body.window.closes_at
    elif timing == "anytime":
        task.fixed_start, task.opens_at, task.closes_at = None, None, None
    db.commit()
    job_id = None
    active = plan_store.active_plan(db, trip.trip_id)
    if active is not None and active.day == task.day:
        job = get_queue().enqueue(jobs.plan_trip, trip.trip_id, "edited")
        job_id = job.id
    db.refresh(task)
    return TaskEditOut(task=task_out(task), job_id=job_id)


# ---------- plans and jobs ----------


@router.post("/trips/{trip_id}/plans", response_model=JobAccepted, response_model_by_alias=True, status_code=202)
def start_planning(body: PlanRequest, trip: OwnedTrip, db: Db) -> JobAccepted:
    if not db.scalar(select(Task.task_id).where(Task.trip_id == trip.trip_id, Task.state.notin_(("done", "skipped"))).limit(1)):
        raise ApiError(422, "Add at least one task before planning.", code="VALIDATION_ERROR")
    job = get_queue().enqueue(jobs.plan_trip, trip.trip_id, "created")
    return JobAccepted(job_id=job.id)


@router.get("/jobs/{job_id}", response_model=JobOut, response_model_by_alias=True)
def job_status(job_id: str, user: CurrentUser, db: Db) -> JobOut:
    job = _owned_job(job_id, user, db)
    status = job.get_status(refresh=True)
    mapped = {"finished": "finished", "failed": "failed", "started": "started"}.get(str(status.value if hasattr(status, "value") else status), "queued")
    result = job.return_value() if mapped == "finished" else None
    error = (result or {}).get("error") if isinstance(result, dict) else None
    if mapped == "failed":
        error = "Planning failed. Try again."
    return JobOut(
        job_id=job.id, status="failed" if error else mapped, plan_version=(result or {}).get("planVersion") if isinstance(result, dict) else None, error=error
    )  # type: ignore[arg-type]


@router.get("/trips/{trip_id}/plans/{version}", response_model=PlanOut, response_model_by_alias=True)
def get_plan(version: int, trip: OwnedTrip, db: Db) -> PlanOut:
    return plan_store.plan_out(plan_store.get_version(db, trip.trip_id, version))


@router.post(
    "/trips/{trip_id}/plans/{version}/activate", response_model=PlanOut, response_model_by_alias=True, summary="Undo: make an earlier version active again"
)
def activate_version(version: int, body: ActivateIn, trip: OwnedTrip, db: Db) -> PlanOut:
    return plan_store.plan_out(loop.undo_to(db, trip, version, now_for(trip.trip_id)))


@router.post("/trips/{trip_id}/options/{option_id}/accept", response_model=PlanOut, response_model_by_alias=True)
def accept_option(option_id: str, body: AcceptIn, trip: OwnedTrip, db: Db) -> PlanOut:
    return plan_store.plan_out(loop.accept(db, trip, option_id, now_for(trip.trip_id)))


# ---------- check-ins ----------


@router.post("/trips/{trip_id}/checkins", response_model=CheckinOut, response_model_by_alias=True)
def checkin(body: CheckinIn, trip: OwnedTrip, db: Db, response: Response) -> CheckinOut:
    task = db.get(Task, body.task_id)
    if task is None or task.trip_id != trip.trip_id:
        raise ApiError(404, "Task not found.")
    existing = db.scalar(select(Checkin).where(Checkin.trip_id == trip.trip_id, Checkin.idempotency_key == body.idempotency_key))
    if existing is not None:
        # Same key again (for example an offline retry after the cache expired): no second re-plan.
        return _checkin_out(db, trip, existing, existing.result, None)
    now = now_for(trip.trip_id)
    row = Checkin(trip_id=trip.trip_id, task_id=task.task_id, kind=body.kind, delay_min=body.delay_min, at=now, idempotency_key=body.idempotency_key)
    db.add(row)
    if body.kind == "done":
        if task.state == "done":
            raise ApiError(409, "This task is already checked in.")
        task.state = "done"
    elif body.kind == "skipped":
        # The traveller may skip any task, even a fixed one; the planner never does that on its own.
        task.state = "skipped"
    try:
        db.commit()
    except IntegrityError:
        db.rollback()
        existing = db.scalar(select(Checkin).where(Checkin.trip_id == trip.trip_id, Checkin.idempotency_key == body.idempotency_key))
        return _checkin_out(db, trip, existing, existing.result if existing else None, None)  # type: ignore[arg-type]
    events.publish(trip.trip_id, "checkin_recorded", {"checkinId": row.checkin_id, "taskId": task.task_id, "kind": body.kind, "at": now.isoformat()})

    if plan_store.active_plan(db, trip.trip_id) is None:
        out = CheckinOut(checkin_id=row.checkin_id, plan_id=None, result="recorded")
    else:
        if body.kind == "skipped":
            job = get_queue().enqueue(jobs.plan_trip, trip.trip_id, "skipped", row.checkin_id)
            outcome = _wait(job, get_settings().checkin_wait_seconds)
            if outcome is not None and "error" not in outcome:
                outcome = {
                    "result": "recorded",
                    "planId": outcome.get("planId"),
                    "reasonCodes": ["TASK_SKIPPED"],
                    "explanation": "Skipped. Your later stops moved up.",
                }
        else:
            job = get_queue().enqueue(
                jobs.replan_trip, trip.trip_id, body.delay_min or 0, False, row.checkin_id, now.isoformat() if body.kind == "done" else None
            )
            outcome = _wait(job, get_settings().checkin_wait_seconds)
        out = _checkin_out(db, trip, row, outcome, job.id)
        if out.result == "pending":
            response.status_code = 202
    row.result = out.model_dump(mode="json", by_alias=True, exclude={"plan", "options"}) | {"planId": out.plan_id}
    db.commit()
    return out


# ---------- summary ----------


@router.get("/trips/{trip_id}/summary", response_model=SummaryOut, response_model_by_alias=True)
def summary(trip: OwnedTrip, db: Db, day: str | None = None) -> SummaryOut:
    which = date.fromisoformat(day) if day else trip_day(trip, now_for(trip.trip_id))
    return summary_out(db, trip, which)


# ---------- Google Calendar ----------


@router.post(
    "/trips/{trip_id}/calendar-import",
    response_model=list[TaskDraftOut],
    response_model_by_alias=True,
    summary="Read appointments as draft tasks; saves nothing",
)
def calendar_import(body: CalendarImportIn, trip: OwnedTrip, db: Db) -> list[TaskDraftOut]:
    tz = tz_for(trip.utc_offset)
    start = datetime.combine(trip.start_date, dtime(0), tz)
    end = datetime.combine(trip.end_date, dtime(23, 59), tz)
    drafts = []
    for ev in calendar_events(body.code, start, end):
        match = None
        if ev.location:
            words = ev.location.split(",")[0].strip()
            match = db.scalar(
                select(Place).where(Place.city_slug == trip.city_slug, or_(Place.name.ilike(f"%{words}%"), Place.area.ilike(f"%{words}%"))).limit(1)
            )
        minutes = max(5, min(720, int((ev.end - ev.start).total_seconds() // 60)))
        drafts.append(
            TaskDraftOut(
                title=ev.title[:120],
                place_text=ev.location,
                place_id=match.place_id if match else None,
                duration_min=minutes,
                fixed_start=ev.start.astimezone(tz),
                source="calendar",
            )
        )
    return drafts


# ---------- demo clock (DEMO_LOGIN only) ----------


def _demo_only() -> None:
    if not get_settings().demo_login:
        raise ApiError(404, "Not found.")


@router.post("/trips/{trip_id}/demo/clock", response_model=TripOut, response_model_by_alias=True, summary="Demo: set the simulated time (DEMO_LOGIN only)")
def demo_clock(body: DemoClockIn, trip: OwnedTrip, db: Db) -> TripOut:
    _demo_only()
    set_demo_now(trip.trip_id, body.now)
    return trip_out(db, trip, body.now)


@router.post(
    "/trips/{trip_id}/demo/check", response_model=CheckinOut, response_model_by_alias=True, summary="Demo: run the 5-minute check now (DEMO_LOGIN only)"
)
def demo_check(body: PostBody, trip: OwnedTrip, db: Db) -> CheckinOut:
    _demo_only()
    job = get_queue().enqueue(jobs.five_minute_check, trip.trip_id)
    outcome = _wait(job, get_settings().checkin_wait_seconds)
    marker = Checkin(checkin_id="auto", trip_id=trip.trip_id, task_id="", kind="check", at=now_for(trip.trip_id), idempotency_key="auto")
    return _checkin_out(db, trip, marker, outcome, job.id)


@router.post("/trips/{trip_id}/demo/reset", response_model=TripOut, response_model_by_alias=True, summary="Demo: restore the sample day (DEMO_LOGIN only)")
def demo_reset(body: PostBody, trip: OwnedTrip, db: Db) -> TripOut:
    _demo_only()
    if not trip.sample:
        raise ApiError(409, "Only the sample trip can be reset.")
    from app.routes.auth import DEMO_CLOCK_START
    from app.seed import reset_demo_trip

    reset_demo_trip(db, trip)
    set_demo_now(trip.trip_id, datetime.fromisoformat(DEMO_CLOCK_START))
    db.commit()
    return trip_out(db, trip, now_for(trip.trip_id))
