"""Fixtures for tests through the real API and database (PostgreSQL with PostGIS: TEST_DATABASE_URL).

Jobs run inline; Raasta answers from a fixed table.
"""

from __future__ import annotations

import uuid

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
            text(
                "TRUNCATE users, places, trips, tasks, plans, plan_legs, checkins, share_links, reroute_log, refresh_tokens, bookings, cities"
                " RESTART IDENTITY CASCADE"
            )
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
