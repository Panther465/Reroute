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
from fastapi.concurrency import run_in_threadpool
from rq.job import Job
from sqlalchemy import and_, delete, or_, select
from sqlalchemy.exc import IntegrityError

from app import events
from app.adapters.google import calendar_events
from app.adapters.llm import HHMM
from app.cities import city as supported_city
from app.clock import at_minutes, now_for, set_demo_now, tz_for
from app.config import get_settings
from app.deps import CurrentUser, Db, OwnedTrip, demo_only
from app.errors import ApiError
from app.models import Checkin, Place, Plan, Task, Trip
from app.schemas import (
    AcceptIn,
    ActivateIn,
    AiHelperIn,
    Api,
    BlockedOut,
    CalendarImportIn,
    CheckinIn,
    CheckinOut,
    DemoClockIn,
    JobAccepted,
    JobOut,
    Page,
    PlanInsightOut,
    PlanOut,
    PlanRequest,
    PostBody,
    RooIn,
    RooOut,
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
from app.services.places import best_place
from app.services.views import options_out, place_out, summary_out, task_out, trip_out, trip_summary_out
from app.workers import jobs
from app.workers.queue import get_queue

router = APIRouter(prefix="/v1", tags=["trips"])


class TaskEditOut(Api):
    task: TaskOut
    job_id: str | None = None


class TaskAddOut(TaskOut):
    #: The re-plan this task started, when it joined a day that already has a plan.
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
        option_set_id=options.option_set_id if options else outcome.get("optionSetId"),
        blocked=blocked,
        job_id=job_id,
    )


# ---------- trips ----------


@router.post("/trips", response_model=TripOut, response_model_by_alias=True, status_code=201)
def create_trip(body: TripIn, user: CurrentUser, db: Db) -> TripOut:
    where = supported_city(body.city_slug)
    if where is None:
        raise ApiError(422, "Reroute doesn't cover that city yet.", code="VALIDATION_ERROR")
    place = _place(db, body.stay_place_id, body.city_slug)
    trip = Trip(
        user_id=user.user_id,
        city_slug=body.city_slug,
        city_name=where.name,
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
            raw_date, trip_id = base64.urlsafe_b64decode(cursor.encode()).decode().split("|", 1)
            start_date = date.fromisoformat(raw_date)
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


@router.post("/trips/{trip_id}/tasks", response_model=TaskAddOut, response_model_by_alias=True, status_code=201)
def add_task(
    body: TaskIn,
    trip: OwnedTrip,
    db: Db,
    replan: Annotated[bool, Query(description="Re-plan the task's day if it already has a plan. Pass false for all but the last task of a batch.")] = True,
) -> TaskAddOut:
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
    # A task added to a planned day joins the plan, the same as an edit: no "plan again" step.
    job_id = None
    active = plan_store.active_plan(db, trip.trip_id)
    if replan and active is not None and active.day == task.day:
        job_id = get_queue().enqueue(jobs.plan_trip, trip.trip_id, "edited").id
    db.refresh(task)
    return TaskAddOut.model_validate({**task_out(task).model_dump(), "job_id": job_id})


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
        if body.fixed_start.astimezone(tz_for(trip.utc_offset)).date() != (data.get("day") or task.day):
            raise ApiError(422, "fixedStart must be on the task's day.", code="VALIDATION_ERROR")
        task.fixed_start, task.opens_at, task.closes_at = body.fixed_start, None, None
    elif timing == "window" or (timing is None and body.window is not None):
        if body.window is None:
            raise ApiError(422, "Enter when it opens and closes.", code="VALIDATION_ERROR")
        task.fixed_start, task.opens_at, task.closes_at = None, body.window.opens_at, body.window.closes_at
    elif timing == "anytime":
        task.fixed_start, task.opens_at, task.closes_at = None, None, None
    old_day = task.day
    new_day = data.get("day")
    if new_day and new_day != task.day:
        if not trip.start_date <= new_day <= trip.end_date:
            raise ApiError(422, "The task must fall within the trip's dates.", code="VALIDATION_ERROR")
        # A fixed time given with the move is already on the new day; otherwise it keeps its clock time.
        if task.fixed_start is not None and task.fixed_start.astimezone(tz_for(trip.utc_offset)).date() != new_day:
            tz = tz_for(trip.utc_offset)
            task.fixed_start = datetime.combine(new_day, task.fixed_start.astimezone(tz).timetz())
        # A task the planner moved or skipped comes back as planned on its new day.
        task.day, task.planned_day, task.state = new_day, new_day, "planned" if task.state in ("moved", "skipped") else task.state
    db.commit()
    job_id = None
    active = plan_store.active_plan(db, trip.trip_id)
    if active is not None and active.day in (task.day, old_day):
        job = get_queue().enqueue(jobs.plan_trip, trip.trip_id, "edited")
        job_id = job.id
    db.refresh(task)
    return TaskEditOut(task=task_out(task), job_id=job_id)


@router.delete("/trips/{trip_id}/tasks/{task_id}", status_code=204, summary="Remove a task that hasn't been planned or done")
def delete_task(task_id: str, trip: OwnedTrip, db: Db) -> Response:
    task = db.get(Task, task_id)
    if task is None or task.trip_id != trip.trip_id:
        raise ApiError(404, "Task not found.")
    if task.state == "done" or db.scalar(select(Checkin.checkin_id).where(Checkin.task_id == task_id).limit(1)):
        raise ApiError(409, "This task is already in your day's record, so it can't be removed. Skip it instead if you won't do it.")
    active = plan_store.active_plan(db, trip.trip_id)
    in_plan = active is not None and any(leg.get("taskId") == task_id for leg in [*active.legs, *(active.done_legs or [])])
    db.delete(task)
    db.commit()
    if in_plan:
        get_queue().enqueue(jobs.plan_trip, trip.trip_id, "edited")
    return Response(status_code=204)


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


@router.get(
    "/trips/{trip_id}/plans/{version}/insight",
    response_model=PlanInsightOut,
    response_model_by_alias=True,
    summary="Why this plan: the leg choices and the other days the planner weighed",
)
def get_plan_insight(version: int, trip: OwnedTrip, db: Db) -> PlanInsightOut:
    """Read as saved with the plan: the worker worked it out when it made the plan, so nothing is planned here."""
    plan = plan_store.get_version(db, trip.trip_id, version)
    if not plan.insight:
        raise ApiError(404, "This plan was made before Reroute kept its reasons. Plan the day again to see them.")
    tz = tz_for(trip.utc_offset)
    days = [{**d, "ends_at": at_minutes(plan.day, d["ends_at"], tz) if d.get("ends_at") is not None else None} for d in plan.insight["days"]]
    return PlanInsightOut.model_validate({**plan.insight, "days": days, "plan_id": plan.plan_id, "version": plan.version})


@router.post(
    "/trips/{trip_id}/plans/{version}/activate", response_model=PlanOut, response_model_by_alias=True, summary="Undo: make an earlier version active again"
)
def activate_version(version: int, body: ActivateIn, trip: OwnedTrip, db: Db) -> PlanOut:
    return plan_store.plan_out(loop.undo_to(db, trip, version, now_for(trip.trip_id)))


@router.post("/trips/{trip_id}/options/{option_id}/accept", response_model=PlanOut, response_model_by_alias=True)
def accept_option(option_id: str, body: AcceptIn, trip: OwnedTrip, db: Db) -> PlanOut:
    return plan_store.plan_out(loop.accept(db, trip, option_id, now_for(trip.trip_id), option_set_id=body.option_set_id))


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
            raise ApiError(409, "This task is already marked done.")
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
            elif outcome is not None and outcome.get("code") == "NO_FEASIBLE_PLAN":
                # The skip is saved either way; what's left of the day just doesn't fit any more.
                outcome = {
                    "result": "no_feasible_plan",
                    "reasonCodes": ["TASK_SKIPPED", "NO_FEASIBLE_PLAN"],
                    "explanation": f"Skipped. {outcome['error']}",
                    "blocked": outcome.get("blocked"),
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
def summary(trip: OwnedTrip, db: Db, day: date | None = None) -> SummaryOut:
    if day is not None and not trip.start_date <= day <= trip.end_date:
        raise ApiError(422, "Choose a day within the trip.", code="VALIDATION_ERROR")
    return summary_out(db, trip, day or trip_day(trip, now_for(trip.trip_id)))


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
        match = best_place(db, ev.location, trip.city_slug) if ev.location else None
        minutes = max(5, min(720, int((ev.end - ev.start).total_seconds() // 60)))
        drafts.append(
            TaskDraftOut(
                title=ev.title[:120],
                place_text=ev.location,
                place_id=match.place_id if match else None,
                place=place_out(match) if match else None,
                duration_min=minutes,
                fixed_start=ev.start.astimezone(tz),
                source="calendar",
            )
        )
    return drafts


# ---------- AI helper ----------


@router.post(
    "/trips/{trip_id}/task-drafts",
    response_model=list[TaskDraftOut],
    response_model_by_alias=True,
    summary="Describe your day; get back draft tasks (AI helper)",
)
async def ai_task_drafts(body: AiHelperIn, trip: OwnedTrip, db: Db) -> list[TaskDraftOut]:
    if not get_settings().ai_helper_enabled:
        raise ApiError(404, "The AI helper is not enabled on this server.")
    from app.adapters.llm import extract_tasks_llm

    day = trip_day(trip, now_for(trip.trip_id))
    raw = await extract_tasks_llm(body.text, trip.city_name, str(day))
    # Database and Nominatim calls block (Nominatim allows one request a second), so they run off the event loop.
    matches = await run_in_threadpool(lambda: [best_place(db, t.get("placeText", ""), trip.city_slug) for t in raw])
    drafts: list[TaskDraftOut] = []
    for t, match in zip(raw, matches, strict=True):
        place_text = t.get("placeText", "")
        fixed = None
        # Only a real "HH:MM" becomes a fixed time; anything else is dropped and the traveller sets it.
        if isinstance(t.get("fixedStart"), str) and HHMM.match(t["fixedStart"]):
            h, m = map(int, t["fixedStart"].split(":"))
            fixed = datetime.combine(day, dtime(h, m), tz_for(trip.utc_offset))
        drafts.append(
            TaskDraftOut(
                title=t["title"],
                place_text=place_text,
                place_id=match.place_id if match else None,
                place=place_out(match) if match else None,
                duration_min=t["durationMin"],
                fixed_start=fixed,
                priority=t.get("priority", 2),
                source="ai_helper",
            )
        )
    return drafts


@router.post(
    "/trips/{trip_id}/roo",
    response_model=RooOut,
    response_model_by_alias=True,
    summary="Talk to Rico: one message understood, with at most one change it offers (AI helper)",
)
async def talk_to_roo(body: RooIn, trip: OwnedTrip, db: Db) -> RooOut:
    """Rico answers from the day as it is. It only offers a change: the app asks the traveller before making it."""
    if not get_settings().ai_helper_enabled:
        raise ApiError(404, "The AI helper is not enabled on this server.")
    from app.adapters.llm import roo_chat
    from app.services.roo import clean_answer, day_context

    view = await run_in_threadpool(trip_out, db, trip, now_for(trip.trip_id))
    raw = await roo_chat(body.message, [(t.role, t.text) for t in body.history[-12:]], day_context(view))
    answer = clean_answer(raw, view, body.message) if raw else None
    if answer is None:
        raise ApiError(503, "Rico can't think that through right now. Try saying it another way.", code="UNAVAILABLE")
    return RooOut.model_validate(answer)


# ---------- demo clock (DEMO_LOGIN only) ----------


@router.post("/trips/{trip_id}/demo/clock", response_model=TripOut, response_model_by_alias=True, summary="Demo: set the simulated time (DEMO_LOGIN only)")
def demo_clock(body: DemoClockIn, trip: OwnedTrip, db: Db) -> TripOut:
    demo_only()
    set_demo_now(trip.trip_id, body.now)
    return trip_out(db, trip, body.now)


@router.post(
    "/trips/{trip_id}/demo/check", response_model=CheckinOut, response_model_by_alias=True, summary="Demo: run the 5-minute check now (DEMO_LOGIN only)"
)
def demo_check(body: PostBody, trip: OwnedTrip, db: Db) -> CheckinOut:
    demo_only()
    job = get_queue().enqueue(jobs.five_minute_check, trip.trip_id)
    outcome = _wait(job, get_settings().checkin_wait_seconds)
    marker = Checkin(checkin_id="auto", trip_id=trip.trip_id, task_id="", kind="check", at=now_for(trip.trip_id), idempotency_key="auto")
    return _checkin_out(db, trip, marker, outcome, job.id)


@router.post("/trips/{trip_id}/demo/reset", response_model=TripOut, response_model_by_alias=True, summary="Demo: restore the sample day (DEMO_LOGIN only)")
def demo_reset(body: PostBody, trip: OwnedTrip, db: Db) -> TripOut:
    demo_only()
    if not trip.sample:
        raise ApiError(409, "Only the sample trip can be reset.")
    from app.routes.auth import DEMO_CLOCK_START
    from app.seed import reset_demo_trip

    reset_demo_trip(db, trip)
    # The demo account is shared: trips started while trying it go too, so the next person starts clean.
    db.execute(delete(Trip).where(Trip.user_id == trip.user_id, Trip.trip_id != trip.trip_id, Trip.sample.is_(False)))
    set_demo_now(trip.trip_id, datetime.fromisoformat(DEMO_CLOCK_START))
    db.commit()
    # Again after the commit: a check that ran meanwhile may have remembered something of the old day.
    loop.forget_trip_state(trip.trip_id)
    return trip_out(db, trip, now_for(trip.trip_id))
