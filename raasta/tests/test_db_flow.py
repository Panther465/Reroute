"""End-to-end flows against PostgreSQL + PostGIS. Run with TEST_DATABASE_URL set; skipped otherwise."""

from __future__ import annotations

import io
import json
import os
import zipfile
from datetime import UTC, datetime, timedelta
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, text
from sqlalchemy.orm import Session

from app.adapters.osrm import get_router
from app.adapters.rides import RideStoreUnavailable, get_ride_store
from app.db import Base, get_session
from app.main import create_app
from app.routes.deps import utc_now
from app.seed import seed
from app.services.community import mark_stale

from .conftest import make_token

pytestmark = pytest.mark.db

EXAMPLES = Path(__file__).resolve().parents[2] / "examples" / "bengaluru"
NOW = datetime(2026, 10, 14, 5, 25, tzinfo=UTC)  # 10:55 in Bengaluru
BANK = "77.6195,12.9352"
OFFICE = "77.5838,12.9255"


class NoRouting:
    def route(self, stops):  # noqa: ANN001
        return None

    def match(self, points):  # noqa: ANN001
        return None


class MemoryRides:
    """A fake ride store. Set `down` to make every call fail like an unreachable MongoDB."""

    def __init__(self) -> None:
        self.saved: dict[str, list] = {}
        self.saves = 0
        self.down = False

    def _check(self) -> None:
        if self.down:
            raise RideStoreUnavailable("mongo is down")

    def save(self, contribution_id, user_id, city_slug, points, at):  # noqa: ANN001
        self._check()
        self.saves += 1
        self.saved[contribution_id] = list(points)

    def delete(self, contribution_id):  # noqa: ANN001
        self._check()
        self.saved.pop(contribution_id, None)

    def delete_for_user(self, user_id):  # noqa: ANN001
        self._check()
        return 0


@pytest.fixture
def engine():
    eng = create_engine(os.environ["TEST_DATABASE_URL"])
    with eng.begin() as conn:
        conn.execute(text("CREATE EXTENSION IF NOT EXISTS postgis"))
        conn.execute(text("DROP SCHEMA IF EXISTS raasta CASCADE"))
        conn.execute(text("CREATE SCHEMA raasta"))
    from app import models  # noqa: F401

    Base.metadata.create_all(eng)
    with Session(eng) as s:
        seed(s, json.loads((EXAMPLES / "raasta-routes.json").read_text(encoding="utf-8")), NOW)
    yield eng
    eng.dispose()


@pytest.fixture
def client(engine, redis):
    app = create_app()
    rides = MemoryRides()

    def session_override():
        with Session(engine, expire_on_commit=False) as s:
            yield s

    app.dependency_overrides[get_session] = session_override
    app.dependency_overrides[utc_now] = lambda: NOW
    app.dependency_overrides[get_router] = lambda: NoRouting()
    app.dependency_overrides[get_ride_store] = lambda: rides
    c = TestClient(app)
    c.rides = rides  # type: ignore[attr-defined]
    return c


def auth(sub: str = "rider-1", role: str = "traveller") -> dict[str, str]:
    return {"Authorization": f"Bearer {make_token(sub, role)}"}


def test_leg_options_for_the_demo_bank_to_office(client):
    r = client.get("/v1/raasta/routes", params={"from": BANK, "to": OFFICE, "at": "2026-10-14T15:00:00+05:30"})
    assert r.status_code == 200
    body = r.json()
    assert [o["routeId"] for o in body["items"]] == ["sample-kor-jay"]
    leg = body["items"][0]
    assert (leg["board"]["standId"], leg["alight"]["standId"]) == ("std-kor5", "std-jay4")
    assert leg["fareInr"] == 30 and leg["frequencyMin"] == 10 and leg["sample"] is True


def test_no_shared_auto_after_the_last_trip(client):
    r = client.get("/v1/raasta/routes", params={"from": BANK, "to": OFFICE, "at": "2026-10-14T21:45:00+05:30"})
    assert r.json()["items"] == []
    assert r.json()["lastTripPassed"] == ["sample-kor-jay"]


def test_route_detail_and_stands_near(client):
    route = client.get("/v1/raasta/routes/sample-kor-jay").json()
    assert [s["standId"] for s in route["stands"]] == ["std-kor5", "std-forum", "std-dairy", "std-jay4"]
    assert route["confirmationsCount"] == 4 and route["status"] == "verified"
    near = client.get("/v1/raasta/stands", params={"near": BANK, "radius": 300}).json()
    assert near["items"][0]["standId"] == "std-kor5"
    assert client.get("/v1/raasta/routes/nope").status_code == 404


def _tapped(key: str, stands: list[dict]) -> dict:
    return {
        "idempotencyKey": key,
        "kind": "stands_tapped",
        "vehicleType": "shared_auto",
        "fareInr": 25,
        "frequencyMin": 15,
        "firstTrip": "08:00",
        "lastTrip": "20:00",
        "stands": stands,
    }


def test_two_contributors_submitting_the_same_route_verify_it(client):
    stands = [{"name": "HSR 27th Main", "location": {"lat": 12.9116, "lng": 77.6474}}, {"name": "Silk Board", "location": {"lat": 12.9177, "lng": 77.6233}}]
    first = client.post("/v1/raasta/contributions", json=_tapped("con-aaaaaaaa", stands), headers=auth("rider-1"))
    assert first.status_code == 201 and first.json()["status"] == "waiting"
    route_id = first.json()["routeId"]
    assert client.get(f"/v1/raasta/routes/{route_id}").json()["status"] == "unverified"

    # The same rider again doesn't verify their own route.
    again = client.post("/v1/raasta/contributions", json=_tapped("con-bbbbbbbb", stands), headers=auth("rider-1"))
    assert again.json()["status"] == "waiting"

    nearby = [{"name": "HSR", "location": {"lat": 12.9120, "lng": 77.6470}}, {"name": "Silk Board junction", "location": {"lat": 12.9180, "lng": 77.6236}}]
    second = client.post("/v1/raasta/contributions", json=_tapped("con-cccccccc", nearby), headers=auth("rider-2"))
    assert second.json()["status"] == "merged"
    assert client.get(f"/v1/raasta/routes/{second.json()['routeId']}").json()["status"] == "verified"


def test_copied_stand_ids_or_a_repeat_contributor_do_not_verify_a_new_route(client):
    tapped = [{"name": "HSR 27th Main", "location": {"lat": 12.9116, "lng": 77.6474}}, {"name": "Silk Board", "location": {"lat": 12.9177, "lng": 77.6233}}]
    first = client.post("/v1/raasta/contributions", json=_tapped("con-new00001", tapped), headers=auth("rider-1")).json()
    route_id = first["routeId"]

    def status() -> str:
        return client.get(f"/v1/raasta/routes/{route_id}").json()["status"]

    copied = [{"standId": s["standId"]} for s in first["route"]["stands"]]
    r = client.post("/v1/raasta/contributions", json=_tapped("con-new00002", copied), headers=auth("rider-2")).json()
    assert (r["status"], r["routeId"], status()) == ("merged", route_id, "unverified")
    r = client.post("/v1/raasta/contributions", json=_tapped("con-new00003", tapped), headers=auth("rider-2")).json()
    assert (r["status"], status()) == ("merged", "unverified")
    r = client.post("/v1/raasta/contributions", json=_tapped("con-new00004", tapped), headers=auth("rider-3")).json()
    assert (r["status"], status()) == ("merged", "verified")


def test_one_submission_does_not_revive_a_stale_route(client, engine):
    with Session(engine) as s:
        mark_stale(s, NOW, days=0)
    stands = [{"standId": i} for i in ("std-kor5", "std-forum", "std-dairy", "std-jay4")]
    r = client.post("/v1/raasta/contributions", json=_tapped("con-stale001", stands), headers=auth("rider-5")).json()
    assert (r["status"], r["routeId"]) == ("merged", "sample-kor-jay")
    assert client.get("/v1/raasta/routes/sample-kor-jay").json()["status"] == "stale"
    # The same person confirming as well is still one rider.
    same = client.post("/v1/raasta/routes/sample-kor-jay/confirmations", json={"idempotencyKey": "conf-stale001"}, headers=auth("rider-5"))
    assert same.json()["status"] == "stale"
    other = client.post("/v1/raasta/routes/sample-kor-jay/confirmations", json={"idempotencyKey": "conf-stale002"}, headers=auth("rider-6"))
    assert other.json()["status"] == "verified"
    queue = client.get("/v1/raasta/contributions", params={"status": "waiting"}, headers=auth("mod", "moderator")).json()
    assert "sample-kor-jay" not in [c["routeId"] for c in queue["items"]]


def test_the_sample_stale_route_needs_two_new_riders(client):
    url = "/v1/raasta/routes/sample-maj-mall/confirmations"
    assert client.post(url, json={"idempotencyKey": "conf-maj00001"}, headers=auth("r1")).json()["status"] == "stale"
    assert client.post(url, json={"idempotencyKey": "conf-maj00002"}, headers=auth("r2")).json()["status"] == "verified"


def test_a_moderator_cannot_approve_their_own_contribution(client):
    body = _tapped("con-own00001", [{"standId": "std-ind100"}, {"standId": "std-mg"}])
    cid = client.post("/v1/raasta/contributions", json=body, headers=auth("mod-a", "moderator")).json()["contributionId"]
    own = client.patch(f"/v1/raasta/contributions/{cid}", json={"action": "approve"}, headers=auth("mod-a", "moderator"))
    assert own.status_code == 403 and own.json()["error"]["code"] == "FORBIDDEN"
    other = client.patch(f"/v1/raasta/contributions/{cid}", json={"action": "approve"}, headers=auth("mod-b", "moderator"))
    assert other.status_code == 200 and other.json()["route"]["status"] == "verified"


def test_one_confirmation_per_rider_per_day(client, engine):
    url = "/v1/raasta/routes/sample-kor-jay/confirmations"
    first = client.post(url, json={"idempotencyKey": "conf-day00001"}, headers=auth("r1"))
    assert first.status_code == 201 and first.json()["confirmationsCount"] == 5
    rows = _count(engine, "confirmations")
    again = client.post(url, json={"idempotencyKey": "conf-day00002"}, headers=auth("r1"))
    assert again.status_code == 201 and again.json() == first.json()
    assert _count(engine, "confirmations") == rows

    client.app.dependency_overrides[utc_now] = lambda: NOW + timedelta(days=1)
    next_day = client.post(url, json={"idempotencyKey": "conf-day00003"}, headers=auth("r1")).json()
    assert _count(engine, "confirmations") == rows + 1
    assert next_day["confirmationsCount"] == 5  # still five different riders
    assert next_day["lastConfirmedAt"] > first.json()["lastConfirmedAt"]


def test_repeated_contribution_creates_one_route(client):
    stands = [{"standId": "std-ind100"}, {"standId": "std-mg"}]
    body = _tapped("con-dddddddd", stands)
    a = client.post("/v1/raasta/contributions", json=body, headers=auth("rider-9"))
    b = client.post("/v1/raasta/contributions", json=body, headers=auth("rider-9"))
    assert a.json() == b.json() and b.headers["idempotent-replayed"] == "true"


RIDE_STANDS = [
    {"name": "Ride start stand", "location": {"lat": 12.9025, "lng": 77.60}},
    {"name": "Ride end stand", "location": {"lat": 12.9095, "lng": 77.60}},
]


def _ride(key: str, stands: list[dict] | None = None) -> dict:
    t0 = datetime(2026, 10, 14, 4, 0, tzinfo=UTC)
    points = [{"lat": 12.90 + i * 0.0002, "lng": 77.60, "t": (t0 + timedelta(seconds=10 * i)).isoformat()} for i in range(60)]
    return {
        "idempotencyKey": key,
        "kind": "gps_ride",
        "vehicleType": "e_rickshaw",
        "fareInr": 20,
        "frequencyMin": 8,
        "firstTrip": "07:00",
        "lastTrip": "22:00",
        "points": points,
        "stands": RIDE_STANDS if stands is None else stands,
    }


def _count(engine, table: str) -> int:  # noqa: ANN001
    with engine.connect() as conn:
        return conn.execute(text(f"SELECT count(*) FROM raasta.{table}")).scalar_one()


def test_recorded_ride_is_trimmed_and_needs_stands(client):
    r = client.post("/v1/raasta/contributions", json=_ride("con-ride0001"), headers=auth("rider-3"))
    assert r.status_code == 201, r.text
    saved = client.rides.saved[r.json()["contributionId"]]
    assert 0 < len(saved) < 60
    assert r.json()["payload"]["pointsTrimmed"] > 0


def test_a_refused_ride_is_never_stored(client):
    missing = client.post("/v1/raasta/contributions", json=_ride("con-ride0002", [{"standId": "std-nope"}, {"standId": "std-kor5"}]), headers=auth("rider-3"))
    twice = client.post("/v1/raasta/contributions", json=_ride("con-ride0003", [{"standId": "std-kor5"}, {"standId": "std-kor5"}]), headers=auth("rider-3"))
    assert missing.status_code == twice.status_code == 422
    assert client.rides.saves == 0 and client.rides.saved == {}


def test_ride_store_down_is_503_and_adds_nothing(client, engine):
    routes, contributions = _count(engine, "routes"), _count(engine, "contributions")
    client.rides.down = True
    r = client.post("/v1/raasta/contributions", json=_ride("con-ride0004"), headers=auth("rider-3"))
    assert r.status_code == 503 and r.json()["error"]["code"] == "UNAVAILABLE"
    assert (_count(engine, "routes"), _count(engine, "contributions")) == (routes, contributions)
    client.rides.down = False
    assert client.post("/v1/raasta/contributions", json=_ride("con-ride0004"), headers=auth("rider-3")).status_code == 201


def test_a_failed_commit_removes_the_saved_ride(client, engine):
    class CommitFails(Session):
        def commit(self) -> None:
            raise RuntimeError("the database went away")

    def failing_session():
        with CommitFails(engine, expire_on_commit=False) as s:
            yield s

    client.app.dependency_overrides[get_session] = failing_session
    r = TestClient(client.app, raise_server_exceptions=False).post("/v1/raasta/contributions", json=_ride("con-ride0005"), headers=auth("rider-3"))
    assert r.status_code == 500
    assert client.rides.saves == 1 and client.rides.saved == {}


def test_rejecting_a_ride_deletes_it(client):
    created = client.post("/v1/raasta/contributions", json=_ride("con-ride0006"), headers=auth("rider-3")).json()
    cid = created["contributionId"]
    assert cid in client.rides.saved
    reject = {"action": "reject", "reason": "not a real route"}
    client.rides.down = True
    down = client.patch(f"/v1/raasta/contributions/{cid}", json=reject, headers=auth("mod", "moderator"))
    assert down.status_code == 503 and cid in client.rides.saved
    client.rides.down = False
    r = client.patch(f"/v1/raasta/contributions/{cid}", json=reject, headers=auth("mod", "moderator"))
    assert r.status_code == 200 and r.json()["status"] == "rejected"
    assert cid not in client.rides.saved


def test_moderator_approves_edits_and_rejects(client):
    stands = [{"standId": "std-maj"}, {"standId": "std-mall8"}]
    created = client.post("/v1/raasta/contributions", json={**_tapped("con-eeeeeeee", stands), "vehicleType": "e_rickshaw"}, headers=auth("rider-4")).json()
    queue = client.get("/v1/raasta/contributions", params={"status": "waiting"}, headers=auth("mod", "moderator")).json()
    assert created["contributionId"] in [c["contributionId"] for c in queue["items"]]
    cid = created["contributionId"]
    edited = client.patch(f"/v1/raasta/contributions/{cid}", json={"action": "edit", "fareInr": 22}, headers=auth("mod", "moderator"))
    assert edited.json()["route"]["fareInr"] == 22
    approved = client.patch(f"/v1/raasta/contributions/{cid}", json={"action": "approve"}, headers=auth("mod", "moderator"))
    assert approved.json()["status"] == "verified" and approved.json()["route"]["status"] == "verified"
    assert (
        client.patch(f"/v1/raasta/contributions/{cid}", json={"action": "reject", "reason": "duplicate"}, headers=auth("mod", "moderator")).status_code == 409
    )


def test_fare_reports_change_the_shown_fare_after_review(client):
    for i, key in enumerate(["fr-key-001", "fr-key-002"]):
        rep = client.post("/v1/raasta/routes/sample-kor-jay/fare-reports", json={"idempotencyKey": key, "fareInr": 35}, headers=auth(f"payer-{i}")).json()
        client.patch(f"/v1/raasta/fare-reports/{rep['fareReportId']}", json={"action": "accept"}, headers=auth("mod", "moderator"))
    assert client.get("/v1/raasta/routes/sample-kor-jay").json()["fareInr"] == 35


def test_stale_route_comes_back_with_two_riders(client, engine):
    # Go stale on the API's clock (NOW): only confirmations made after the route went stale
    # count towards verifying it again, and the requests below run at NOW.
    with Session(engine) as s:
        changed = mark_stale(s, NOW, days=0)
    assert "sample-kor-jay" in changed
    assert client.get("/v1/raasta/routes/sample-kor-jay").json()["status"] == "stale"
    client.post("/v1/raasta/routes/sample-kor-jay/confirmations", json={"idempotencyKey": "conf-aaaaaaaa"}, headers=auth("r1"))
    assert client.get("/v1/raasta/routes/sample-kor-jay").json()["status"] == "stale"
    r = client.post("/v1/raasta/routes/sample-kor-jay/confirmations", json={"idempotencyKey": "conf-bbbbbbbb"}, headers=auth("r2"))
    assert r.json()["status"] == "verified"


def test_gtfs_has_only_verified_routes(client):
    r = client.get("/v1/raasta/cities/bengaluru/gtfs.zip")
    assert r.status_code == 200 and r.headers["content-type"] == "application/zip"
    with zipfile.ZipFile(io.BytesIO(r.content)) as zf:
        routes = zf.read("routes.txt").decode()
    assert "sample-kor-jay" in routes and "sample-jay-btm" not in routes and "sample-maj-mall" not in routes
