"""Morning planning: the scheduler plans each trip day on its own once the local morning starts."""

from __future__ import annotations

import json
from datetime import UTC, date, datetime

import pytest
from sqlalchemy import text

from app.clock import now_for
from app.db import engine, session_scope
from app.errors import ApiError
from app.models import Trip
from app.services import loop, morning
from app.workers import jobs
from app.workers.scheduler import queue_morning_plans, tick

from .conftest import key

DAY1, DAY2 = date(2026, 10, 14), date(2026, 10, 15)
#: The scheduler's own clock for the trip-window filter: the night before day 2 in UTC.
UTC_DAY2 = datetime(2026, 10, 15, 0, 30, tzinfo=UTC)


# ---------- the rule on plain values ----------


def _due(local: str, **flags) -> bool:
    values = {"open_tasks": True, "planned_today": False, "planned_before": True} | flags
    return morning.is_due(DAY1, DAY2, datetime.fromisoformat(local), 6 * 60, **values)


def test_the_morning_rule():
    assert _due("2026-10-15T06:00:00+05:30")
    assert not _due("2026-10-15T05:59:00+05:30")  # before 06:00
    assert not _due("2026-10-16T07:00:00+05:30")  # after the trip
    assert not _due("2026-10-13T07:00:00+05:30")  # before it
    assert not _due("2026-10-15T07:00:00+05:30", open_tasks=False)
    assert not _due("2026-10-15T07:00:00+05:30", planned_today=True)
    assert not _due("2026-10-15T07:00:00+05:30", planned_before=False)  # a trip nobody planned


# ---------- through the scheduler, the worker and the database ----------


def clock(c, when: str):
    assert c.post("/v1/trips/trip-001/demo/clock", json={"now": when, "idempotencyKey": key()}).status_code == 200


def plan_day1(c):
    job = c.post("/v1/trips/trip-001/plans", json={"idempotencyKey": key()}).json()["jobId"]
    assert c.get(f"/v1/jobs/{job}").json()["planVersion"] == 1


def plans() -> list[tuple[str, str, int | None]]:
    with engine().connect() as conn:
        rows = conn.execute(text("SELECT day, trigger, version FROM plans WHERE trip_id = 'trip-001' ORDER BY created_at")).all()
    return [(str(d), t, v) for d, t, v in rows]


@pytest.mark.db
def test_the_morning_plans_day_2_from_the_hotel(client, fake_redis):
    plan_day1(client)
    clock(client, "2026-10-15T06:30:00+05:30")
    events = fake_redis.pubsub()
    events.subscribe("trip:trip-001")
    assert tick(UTC_DAY2) == 1
    trip = client.get("/v1/trips/trip-001").json()
    plan = trip["activePlan"]
    assert (plan["day"], plan["trigger"], plan["version"]) == ("2026-10-15", "morning", 2)
    assert plan["legs"][0]["fromPlaceId"] == "hotel-majestic"
    assert "task-train" in [leg["taskId"] for leg in plan["legs"]]
    assert trip["log"][0]["kind"] == "morning" and trip["log"][0]["automatic"] is True and trip["log"][0]["canUndo"] is False
    published = []
    while (message := events.get_message()) is not None:
        if message["type"] == "message":
            published.append(json.loads(message["data"]))
    updated = [e["data"] for e in published if e["event"] == "plan_updated"]
    assert updated and updated[-1]["trigger"] == "morning" and updated[-1]["notify"] is True


@pytest.mark.db
def test_a_second_tick_plans_nothing_more(client, fake_redis):
    plan_day1(client)
    clock(client, "2026-10-15T06:30:00+05:30")
    assert tick(UTC_DAY2) == 1
    tick(UTC_DAY2)  # now only the new plan's 5-minute check
    assert queue_morning_plans(UTC_DAY2) == 0
    # Even with the once-a-day key gone, the day already has its plan.
    fake_redis.delete(morning.lock_key("trip-001", DAY2))
    assert queue_morning_plans(UTC_DAY2) == 0
    assert [p for p in plans() if p[1] == "morning"] == [("2026-10-15", "morning", 2)]


@pytest.mark.db
def test_nothing_is_planned_before_six(client):
    plan_day1(client)
    clock(client, "2026-10-15T05:59:00+05:30")
    assert tick(UTC_DAY2) == 0
    assert [p[0] for p in plans()] == ["2026-10-14"]
    clock(client, "2026-10-15T06:00:00+05:30")
    assert tick(UTC_DAY2) == 1


@pytest.mark.db
def test_the_demo_clock_decides_the_local_time(client):
    plan_day1(client)
    # By the scheduler's own clock it's 08:30 in Bengaluru on day 2, but the trip's demo clock says 05:00.
    clock(client, "2026-10-15T05:00:00+05:30")
    assert tick(datetime(2026, 10, 15, 3, 0, tzinfo=UTC)) == 0
    assert [p[0] for p in plans()] == ["2026-10-14"]


@pytest.mark.db
def test_a_trip_nobody_planned_is_left_alone(client):
    clock(client, "2026-10-15T07:00:00+05:30")
    assert tick(UTC_DAY2) == 0
    assert plans() == []


@pytest.mark.db
def test_the_job_checks_again_and_skips_a_day_planned_meanwhile(client):
    plan_day1(client)
    clock(client, "2026-10-15T06:30:00+05:30")
    job = client.post("/v1/trips/trip-001/plans", json={"idempotencyKey": key()}).json()["jobId"]
    assert client.get(f"/v1/jobs/{job}").json()["planVersion"] == 2
    assert jobs.morning_plan("trip-001", "2026-10-15") == {"result": "not_due"}
    # The same check runs again under the trip's lock, inside the planning itself.
    with session_scope() as db, pytest.raises(ApiError) as refused:
        loop.create_plan(db, db.get(Trip, "trip-001"), jobs.adapter_factory(), now_for("trip-001"), trigger="morning")
    assert refused.value.code == "NOT_DUE"
    assert [p[1] for p in plans()] == ["created", "created"]


@pytest.mark.db
def test_a_failed_morning_plan_is_retried_after_30_minutes(client, fake_redis):
    plan_day1(client)
    clock(client, "2026-10-15T06:30:00+05:30")
    # A fixed 06:40 visit on day 2 can't be reached: no plan keeps it.
    body = {"title": "Early call", "placeId": "whitefield-office", "durationMin": 30, "fixedStart": "2026-10-15T06:40:00+05:30", "idempotencyKey": key()}
    assert client.post("/v1/trips/trip-001/tasks", json=body).status_code == 201
    assert tick(UTC_DAY2) == 1
    assert [p[1] for p in plans()] == ["created"]
    assert 0 < fake_redis.ttl(morning.lock_key("trip-001", DAY2)) <= morning.RETRY_SECONDS
