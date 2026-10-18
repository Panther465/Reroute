"""The demo day through the real API and database (definition of done, section 18).

Needs PostgreSQL with PostGIS: TEST_DATABASE_URL. Jobs run inline; Raasta answers from a fixed table.
"""

from __future__ import annotations

import uuid
from datetime import date

import pytest
from alembic import command
from alembic.config import Config
from fastapi.testclient import TestClient
from sqlalchemy import text

from app.adapters.transit import RouteInfo, StaticTransitAdapter
from app.adapters.travel_times import SampleSnapshotAdapter
from app.db import engine, session_scope
from app.main import app
from app.seed import seed
from app.workers import jobs

pytestmark = pytest.mark.db

RAASTA = {
    rid: RouteInfo(route_id=rid, status="verified", first_trip="07:00", last_trip="21:30", fare_inr=30, frequency_min=10)
    for rid in ("sample-kor-jay", "sample-jay-kor")
}


@pytest.fixture(scope="module")
def database():
    cfg = Config("alembic.ini")
    with engine().begin() as conn:
        conn.execute(text("DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public; CREATE EXTENSION IF NOT EXISTS postgis;"))
    command.upgrade(cfg, "head")
    yield


@pytest.fixture
def client(database, monkeypatch):
    with engine().begin() as conn:
        conn.execute(
            text("TRUNCATE users, places, trips, tasks, plans, plan_legs, checkins, share_links, reroute_log, refresh_tokens RESTART IDENTITY CASCADE")
        )
    with session_scope() as db:
        seed(db)
    monkeypatch.setattr(jobs, "adapter_factory", lambda: SampleSnapshotAdapter(StaticTransitAdapter(RAASTA)))
    c = TestClient(app, base_url="https://testserver")
    token = c.post("/v1/auth/demo", json={"as": "traveller"}).json()["accessToken"]
    c.headers["Authorization"] = f"Bearer {token}"
    return c


def key() -> str:
    return "test-" + uuid.uuid4().hex


def clock(c, hhmm: str):
    res = c.post("/v1/trips/trip-001/demo/clock", json={"now": f"2026-10-14T{hhmm}:00+05:30", "idempotencyKey": key()})
    assert res.status_code == 200, res.text


def plan_v1(c):
    res = c.post("/v1/trips/trip-001/plans", json={"idempotencyKey": key()})
    assert res.status_code == 202
    job = c.get(f"/v1/jobs/{res.json()['jobId']}").json()
    assert job["status"] == "finished" and job["planVersion"] == 1, job
    return c.get("/v1/trips/trip-001/plans/1").json()


def hm(iso: str) -> str:
    return iso[11:16]


def test_plan_version_1_matches_the_golden_test(client):
    plan = plan_v1(client)
    assert [(leg["taskId"], hm(leg["leaveBy"]), hm(leg["taskStart"])) for leg in plan["legs"]] == [
        ("task-meet", "08:50", "10:00"),
        ("task-bank", "11:05", "12:25"),
        ("task-office", "15:00", "15:40"),
        (None, "16:30", "16:50"),
    ]
    assert plan["status"] == "active" and plan["trigger"] == "created" and plan["ruleVersion"] == "1.0"
    assert len(plan["inputsHash"]) == 64
    assert plan["legs"][0]["leaveBy"] == "2026-10-14T08:50:00+05:30"


def test_15_minute_delay_shifts_without_asking(client):
    plan_v1(client)
    clock(client, "10:55")
    res = client.post("/v1/trips/trip-001/checkins", json={"taskId": "task-meet", "kind": "delay", "delayMin": 15, "idempotencyKey": key()})
    body = res.json()
    assert res.status_code == 200 and body["result"] == "shifted", body
    assert body["reasonCodes"] == ["BEHIND_SCHEDULE", "SHIFT_ONLY"]
    assert [hm(leg["taskStart"]) for leg in body["plan"]["legs"]] == ["12:40", "15:55", "17:05"]
    assert body["plan"]["version"] == 2
    assert [hm(leg["leaveBy"]) for leg in body["plan"]["doneLegs"]] == ["08:50"]


def test_40_minute_delay_offers_options_then_accept_and_undo(client):
    plan_v1(client)
    clock(client, "10:55")
    res = client.post("/v1/trips/trip-001/checkins", json={"taskId": "task-meet", "kind": "delay", "delayMin": 40, "idempotencyKey": "chk-001"})
    body = res.json()
    assert body["result"] == "options", body
    assert body["reasonCodes"] == ["BEHIND_SCHEDULE", "WINDOW_CLOSES_SOON"]
    assert [(o["optionId"], o["label"], o["extraFareInr"]) for o in body["options"]] == [
        ("opt-1", "Take a cab to the bank", 350),
        ("opt-2", "Keep it cheap", 0),
    ]
    assert body["options"][1]["movedTasks"] == ["task-office"]
    # Nothing changes until the traveller chooses.
    assert client.get("/v1/trips/trip-001").json()["activePlan"]["version"] == 1

    accepted = client.post("/v1/trips/trip-001/options/opt-1/accept", json={"idempotencyKey": "acc-001"}).json()
    assert accepted["version"] == 2 and accepted["status"] == "active" and accepted["trigger"] == "late"
    assert accepted["explanation"] == "A cab keeps all three tasks today for ₹350 more."
    assert accepted["legs"][0]["mode"] == "cab" and hm(accepted["legs"][0]["leaveBy"]) == "11:45"

    summary = client.get("/v1/trips/trip-001/summary").json()
    assert [leg["fareInr"] for leg in summary["legs"]] == [70, 430, 30, 30]
    assert summary["totals"]["fareInr"] == 560 and summary["totals"]["travelMin"] == 170
    assert "Rerouted once, at 10:55." in summary["headline"]

    undone = client.post("/v1/trips/trip-001/plans/1/activate", json={"idempotencyKey": key()}).json()
    assert undone["version"] == 1 and undone["status"] == "active"
    v2 = client.get("/v1/trips/trip-001/plans/2").json()
    assert v2["status"] == "superseded"


def test_accepting_the_cheap_option_moves_the_office_and_undo_brings_it_back(client):
    plan_v1(client)
    clock(client, "10:55")
    client.post("/v1/trips/trip-001/checkins", json={"taskId": "task-meet", "kind": "delay", "delayMin": 40, "idempotencyKey": key()})
    client.post("/v1/trips/trip-001/options/opt-2/accept", json={"idempotencyKey": key()})
    tasks = {t["taskId"]: t for t in client.get("/v1/trips/trip-001").json()["tasks"]}
    assert tasks["task-office"]["state"] == "moved" and tasks["task-office"]["day"] == "2026-10-15"
    client.post("/v1/trips/trip-001/plans/1/activate", json={"idempotencyKey": key()})
    tasks = {t["taskId"]: t for t in client.get("/v1/trips/trip-001").json()["tasks"]}
    assert tasks["task-office"]["state"] == "planned" and tasks["task-office"]["day"] == "2026-10-14"


def test_the_same_checkin_twice_replans_once(client):
    plan_v1(client)
    clock(client, "10:55")
    body = {"taskId": "task-meet", "kind": "delay", "delayMin": 15, "idempotencyKey": "chk-same-001"}
    first = client.post("/v1/trips/trip-001/checkins", json=body)
    second = client.post("/v1/trips/trip-001/checkins", json=body)
    assert first.json() == second.json()
    assert second.headers.get("Idempotent-Replayed") == "true"
    with engine().connect() as conn:
        versions = conn.execute(text("SELECT count(*) FROM plans WHERE trip_id = 'trip-001' AND version IS NOT NULL")).scalar()
        checkins = conn.execute(text("SELECT count(*) FROM checkins WHERE trip_id = 'trip-001'")).scalar()
    assert versions == 2 and checkins == 1


def test_plans_are_immutable_in_the_database(client):
    plan_v1(client)
    with pytest.raises(Exception, match="immutable"), engine().begin() as conn:
        conn.execute(text("UPDATE plans SET fare_inr = 1 WHERE trip_id = 'trip-001'"))


def test_share_link_is_read_only_and_stops_working_once_revoked(client):
    plan_v1(client)
    link = client.post("/v1/trips/trip-001/share-links", json={"idempotencyKey": key()}).json()
    family = TestClient(app, base_url="https://testserver")
    view = family.get(f"/v1/shared/{link['token']}")
    assert view.status_code == 200
    assert view.json()["travellerFirstName"] == "Arjun"
    assert "lng" not in view.text and "lat" not in view.text
    assert family.post("/v1/trips/trip-001/checkins", json={"taskId": "task-meet", "kind": "done", "idempotencyKey": key()}).status_code == 401
    client.delete(f"/v1/share-links/{link['shareId']}")
    assert family.get(f"/v1/shared/{link['token']}").status_code == 410


def test_other_travellers_cannot_see_the_trip(client):
    other = TestClient(app, base_url="https://testserver")
    token = other.post("/v1/auth/demo", json={"as": "moderator"}).json()["accessToken"]
    res = other.get("/v1/trips/trip-001", headers={"Authorization": f"Bearer {token}"})
    assert res.status_code == 404


def test_check_in_done_moves_now_to_the_next_leg(client):
    plan_v1(client)
    clock(client, "11:00")
    res = client.post("/v1/trips/trip-001/checkins", json={"taskId": "task-meet", "kind": "done", "idempotencyKey": key()})
    assert res.json()["result"] in ("on_time", "shifted")
    trip = client.get("/v1/trips/trip-001").json()
    assert {t["taskId"]: t["state"] for t in trip["tasks"]}["task-meet"] == "done"
    assert trip["day"] == date(2026, 10, 14).isoformat()


def test_automatic_check_shifts_when_behind(client):
    plan_v1(client)
    clock(client, "11:25")  # leave-by was 11:05 and the meeting isn't checked in: 20 min behind
    res = client.post("/v1/trips/trip-001/demo/check", json={"idempotencyKey": key()}).json()
    assert res["result"] == "shifted", res
    log = client.get("/v1/trips/trip-001").json()["log"]
    assert log[0]["automatic"] is True and log[0]["canUndo"] is True and log[0]["previousVersion"] == 1


def test_refresh_rotates_and_needs_csrf(client):
    c = TestClient(app, base_url="https://testserver")
    c.post("/v1/auth/demo", json={"as": "traveller"})
    assert c.post("/v1/auth/refresh").status_code == 403
    csrf = c.cookies.get("rr_csrf")
    ok = c.post("/v1/auth/refresh", headers={"X-CSRF-Token": csrf})
    assert ok.status_code == 200 and ok.json()["accessToken"]
