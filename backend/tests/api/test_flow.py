"""The demo day through the real API and database (definition of done, section 18).

Needs PostgreSQL with PostGIS: TEST_DATABASE_URL. Jobs run inline; Raasta answers from a fixed table.
"""

from __future__ import annotations

from datetime import date

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import text

from app.db import engine, session_scope
from app.main import app
from app.workers import jobs

from .conftest import key

pytestmark = pytest.mark.db


def clock(c, hhmm: str, day: str = "2026-10-14"):
    res = c.post("/v1/trips/trip-001/demo/clock", json={"now": f"{day}T{hhmm}:00+05:30", "idempotencyKey": key()})
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


def checkin(c, task_id: str, kind: str):
    res = c.post("/v1/trips/trip-001/checkins", json={"taskId": task_id, "kind": kind, "idempotencyKey": key()})
    assert res.status_code == 200, res.text


def test_skipping_the_next_task_keeps_it_skipped_and_plans_from_the_hotel(client):
    plan_v1(client)
    checkin(client, "task-meet", "skipped")
    trip = client.get("/v1/trips/trip-001").json()
    assert {t["taskId"]: t["state"] for t in trip["tasks"]}["task-meet"] == "skipped"
    plan = trip["activePlan"]
    assert "task-meet" not in [leg["taskId"] for leg in plan["doneLegs"] + plan["legs"]]
    assert plan["legs"][0]["fromPlaceId"] == "hotel-majestic"


def test_skipping_after_check_ins_plans_from_the_last_place_reached(client):
    plan_v1(client)
    clock(client, "11:00")
    checkin(client, "task-meet", "done")
    clock(client, "13:00")
    checkin(client, "task-bank", "done")
    checkin(client, "task-office", "skipped")
    trip = client.get("/v1/trips/trip-001").json()
    assert {t["taskId"]: t["state"] for t in trip["tasks"]}["task-office"] == "skipped"
    plan = trip["activePlan"]
    assert [leg["taskId"] for leg in plan["doneLegs"]] == ["task-meet", "task-bank"]
    home = plan["legs"][0]
    assert home["taskId"] is None and home["fromPlaceId"] == "koramangala-bank"
    assert hm(home["leaveBy"]) >= "13:00"


def add(c, title: str, replan: bool = True) -> dict:
    url = "/v1/trips/trip-001/tasks" + ("" if replan else "?replan=false")
    res = c.post(url, json={"title": title, "placeId": "jayanagar-office", "durationMin": 15, "priority": 3, "idempotencyKey": key()})
    assert res.status_code == 201, res.text
    return res.json()


def test_adding_a_task_to_a_planned_day_replans_it(client):
    plan_v1(client)
    task = add(client, "Pick up documents")
    assert task["jobId"]
    plan = client.get("/v1/trips/trip-001").json()["activePlan"]
    assert plan["version"] == 2 and plan["trigger"] == "edited"
    assert task["taskId"] in [leg["taskId"] for leg in plan["legs"]] + [m["taskId"] for m in plan["moved"]]


def test_demo_reset_removes_trips_started_in_the_demo(client):
    body = {
        "citySlug": "bengaluru",
        "cityName": "Bengaluru",
        "startDate": "2030-01-15",
        "endDate": "2030-01-15",
        "stayPlaceId": "hotel-majestic",
        "stayLabel": "Hotel near Majestic",
        "idempotencyKey": key(),
    }
    new = client.post("/v1/trips", json=body)
    assert new.status_code == 201, new.text
    task = {"title": "Meeting", "placeId": "whitefield-office", "durationMin": 60, "idempotencyKey": key()}
    assert client.post(f"/v1/trips/{new.json()['tripId']}/tasks", json=task).status_code == 201
    assert len(client.get("/v1/trips").json()["items"]) == 2
    assert client.post("/v1/trips/trip-001/demo/reset", json={"idempotencyKey": key()}).status_code == 200
    assert [t["tripId"] for t in client.get("/v1/trips").json()["items"]] == ["trip-001"]


def test_a_task_moves_to_tomorrow_and_today_replans(client):
    plan_v1(client)
    res = client.patch("/v1/trips/trip-001/tasks/task-bank", json={"day": "2026-10-15"})
    assert res.status_code == 200, res.text
    assert res.json()["task"]["day"] == "2026-10-15" and res.json()["jobId"]
    plan = client.get("/v1/trips/trip-001").json()["activePlan"]
    assert plan["version"] == 2 and "task-bank" not in [leg["taskId"] for leg in plan["legs"]]
    # A fixed task keeps its clock time on the new day; outside the trip it's refused.
    meet = client.patch("/v1/trips/trip-001/tasks/task-meet", json={"day": "2026-10-15"}).json()["task"]
    assert meet["fixedStart"] == "2026-10-15T04:30:00Z"  # 10:00 in Bengaluru
    assert client.patch("/v1/trips/trip-001/tasks/task-office", json={"day": "2026-10-20"}).status_code == 422
    # The edit form sends the new day and a fixed time on it together.
    both = {"day": "2026-10-14", "timing": "fixed", "fixedStart": "2026-10-14T09:30:00+05:30"}
    assert client.patch("/v1/trips/trip-001/tasks/task-meet", json=both).json()["task"]["fixedStart"] == "2026-10-14T04:00:00Z"


def test_a_window_task_blocked_by_fixed_times_says_so(client):
    plan_v1(client)
    # A second fixed meeting at 13:30 leaves the bank (2 h 30 min, open 10:00 to 16:00) no gap.
    body = {"title": "Client call", "placeId": "jayanagar-office", "durationMin": 60, "fixedStart": "2026-10-14T13:30:00+05:30", "idempotencyKey": key()}
    assert client.post("/v1/trips/trip-001/tasks", json=body).status_code == 201
    moved = client.get("/v1/trips/trip-001").json()["activePlan"]["moved"]
    bank = next(m for m in moved if m["taskId"] == "task-bank")
    assert bank["reason"] == "The bank needs 2 h 30 min between 10:00 and 16:00, and your fixed times at 10:00 and 13:30 leave no gap that long with the travel"


def test_book_a_train_ticket_for_the_train_task(client):
    trains = client.get("/v1/trips/trip-001/train-options", params={"taskId": "task-train", "to": "Chennai"}).json()
    assert len(trains) == 4 and all(t["sample"] for t in trains)
    assert trains == client.get("/v1/trips/trip-001/train-options", params={"taskId": "task-train", "to": "Chennai"}).json()  # always the same
    # Trains leave around the task's time (21:00).
    assert any("20:00" <= t["departs"] <= "22:00" for t in trains)
    train = trains[0]
    cls = train["classes"][0]
    body = {
        "kind": "train",
        "taskId": "task-train",
        "destination": "Chennai",
        "trainNo": train["trainNo"],
        "travelClass": cls["code"],
        "passengers": [{"name": "Arjun Mehta", "age": 34}, {"name": "Priya Mehta", "age": 31}],
        "idempotencyKey": key(),
    }
    res = client.post("/v1/trips/trip-001/bookings", json=body)
    assert res.status_code == 201, res.text
    ticket = res.json()
    assert ticket["demo"] and ticket["status"] == "confirmed" and len(ticket["reference"]) == 10
    assert ticket["fareInr"] == cls["fareInr"] * 2
    assert [p["name"] for p in ticket["details"]["passengers"]] == ["Arjun Mehta", "Priya Mehta"]
    # The fare comes from the server's own options: a made-up train is refused.
    assert client.post("/v1/trips/trip-001/bookings", json={**body, "trainNo": "99999", "idempotencyKey": key()}).status_code == 422
    cancelled = client.post(f"/v1/trips/trip-001/bookings/{ticket['bookingId']}/cancel", json={"idempotencyKey": key()}).json()
    assert cancelled["status"] == "cancelled" and cancelled["details"]["refundInr"] == ticket["fareInr"] - 120
    assert [b["bookingId"] for b in client.get("/v1/trips/trip-001/bookings").json()] == [ticket["bookingId"]]


def test_book_a_cab_for_a_leg(client):
    plan_v1(client)
    options = client.get("/v1/trips/trip-001/cab-options", params={"toId": "task-bank"}).json()
    assert {o["provider"] for o in options} == {"uber", "ola", "rapido"}
    assert options == sorted(options, key=lambda o: o["fareInr"])
    choice = next(o for o in options if o["vehicle"] == "sedan")
    res = client.post("/v1/trips/trip-001/bookings", json={"kind": "cab", "toId": "task-bank", "optionId": choice["optionId"], "idempotencyKey": key()})
    assert res.status_code == 201, res.text
    ride = res.json()
    assert ride["fareInr"] == choice["fareInr"] and ride["toId"] == "task-bank"
    assert len(ride["details"]["otp"]) == 4 and ride["details"]["plate"].startswith("KA ")
    assert client.get("/v1/trips/trip-001/cab-options", params={"toId": "task-nowhere"}).status_code == 404
    # A demo reset clears bookings with the rest of the day.
    client.post("/v1/trips/trip-001/demo/reset", json={"idempotencyKey": key()})
    assert client.get("/v1/trips/trip-001/bookings").json() == []


def test_speech_reads_an_alert_and_caches_it(client, monkeypatch):
    calls: list[tuple[str, str, str]] = []

    class FakeCommunicate:
        def __init__(self, text, voice, rate):
            calls.append((text, voice, rate))

        async def stream(self):
            yield {"type": "WordBoundary"}
            yield {"type": "audio", "data": b"ID3fake-mp3"}

    import edge_tts

    monkeypatch.setattr(edge_tts, "Communicate", FakeCommunicate)
    params = {"text": "Time to leave for the bank.", "voice": "en-IN-PrabhatNeural", "rate": "fast"}
    first = client.get("/v1/speech", params=params)
    assert first.status_code == 200, first.text
    assert first.headers["content-type"] == "audio/mpeg" and first.content == b"ID3fake-mp3"
    assert client.get("/v1/speech", params=params).content == b"ID3fake-mp3"
    assert calls == [("Time to leave for the bank.", "en-IN-PrabhatNeural", "+15%")]  # the second came from the cache
    assert client.get("/v1/speech", params={**params, "voice": "xx-Robot"}).status_code == 422
    assert [v["voiceId"] for v in client.get("/v1/speech/voices").json()][0] == "en-IN-NeerjaNeural"


def test_speech_outage_is_a_502_the_app_can_fall_back_from(client, monkeypatch):
    class Down:
        def __init__(self, *a, **k):
            pass

        async def stream(self):
            raise ConnectionError("no route")
            yield  # pragma: no cover

    import edge_tts

    monkeypatch.setattr(edge_tts, "Communicate", Down)
    assert client.get("/v1/speech", params={"text": "Hello"}).status_code == 502


def test_road_path_is_for_covered_cities_only(client, monkeypatch):
    from app.adapters import road_path

    monkeypatch.setattr(road_path.RoadPaths, "get", lambda self, a, b, profile: road_path.straight(a, b))
    ok = client.get("/v1/road-path", params={"from": "77.5713,12.9767", "to": "77.7318,12.9855"})
    assert ok.status_code == 200, ok.text
    assert ok.json()["source"] == "line" and len(ok.json()["coords"]) == 2
    far = client.get("/v1/road-path", params={"from": "72.8777,19.0760", "to": "77.7318,12.9855"})  # Mumbai
    assert far.status_code == 422


class FakeNominatim:
    """OpenStreetMap search without the network: it knows the Koramangala neighbourhood."""

    def __init__(self, *_):
        pass

    def search(self, query, where):
        from app.adapters.places import FoundPlace

        if "koramangala" not in query.lower():
            return []
        return [FoundPlace("osm-n429918282", "Koramangala", "Koramangala", 77.6245, 12.9352, "n429918282")]


def test_place_search_puts_the_exact_name_first(client, monkeypatch):
    monkeypatch.setattr("app.services.places.NominatimSearch", FakeNominatim)
    names = [p["name"] for p in client.get("/v1/places", params={"q": "Koramangala"}).json()]
    # The neighbourhood itself, then the sample bank that's in it.
    assert names[0] == "Koramangala" and "Bank, 80 Feet Road" in names


def test_described_tasks_match_any_place_and_say_which(client, monkeypatch):
    from app.config import get_settings

    async def fake_llm(text, city, day):
        return [
            {"title": "Lunch", "placeText": "Koramangala", "durationMin": 60, "fixedStart": "13:00", "priority": 2},
            {"title": "Bank work", "placeText": "", "durationMin": 45, "fixedStart": None, "priority": 2},
        ]

    monkeypatch.setattr(get_settings(), "ai_helper_enabled", True)
    monkeypatch.setattr("app.adapters.llm.extract_tasks_llm", fake_llm)
    monkeypatch.setattr("app.services.places.NominatimSearch", FakeNominatim)
    res = client.post("/v1/trips/trip-001/task-drafts", json={"text": "Lunch at 1pm in Koramangala, then bank work", "idempotencyKey": key()})
    assert res.status_code == 200, res.text
    lunch, bank = res.json()
    assert lunch["placeId"] == "osm-n429918282" and lunch["place"]["name"] == "Koramangala"
    assert lunch["fixedStart"].startswith("2026-10-14T13:00")
    # No place said: the traveller chooses one.
    assert bank["placeId"] is None and bank["place"] is None


def test_a_second_replan_during_a_task_keeps_the_traveller_there(client):
    plan_v1(client)
    clock(client, "10:30")  # at the 10:00 meeting, not marked done yet
    add(client, "Pick up documents")
    # The first re-plan keeps the meeting's leg with the done legs. The second one used to miss it, put the
    # traveller back at the hotel and try to fit the 10:00 meeting again: "the earliest arrival is 11:55".
    add(client, "Drop a form")
    plan = client.get("/v1/trips/trip-001").json()["activePlan"]
    assert plan["version"] == 3
    assert "task-meet" not in [leg["taskId"] for leg in plan["legs"]]
    assert [leg["taskId"] for leg in plan["doneLegs"]] == ["task-meet"]
    assert hm(plan["legs"][0]["leaveBy"]) >= "11:00"  # leaves from the meeting once it ends


def test_a_task_at_a_searched_place_is_planned_with_rough_times(client):
    from geoalchemy2.elements import WKTElement

    from app.models import Place

    cafe = Place(place_id="osm-test-cafe", city_slug="bengaluru", name="Corner cafe", area="Koramangala", lng=77.6150, lat=12.9340)
    cafe.location = WKTElement("POINT(77.6150 12.9340)", srid=4326)
    with session_scope() as db:
        db.add(cafe)
    plan_v1(client)
    body = {"title": "Coffee", "placeId": "osm-test-cafe", "durationMin": 30, "priority": 2, "idempotencyKey": key()}
    res = client.post("/v1/trips/trip-001/tasks", json=body)
    assert res.status_code == 201, res.text
    plan = client.get("/v1/trips/trip-001").json()["activePlan"]
    legs = {leg["taskId"]: leg for leg in plan["legs"]}
    assert "task-meet" in legs and not legs["task-meet"]["rough"]
    assert res.json()["taskId"] in legs, plan["moved"]
    # The legs to and from the cafe are worked out from distance, and say so.
    to_cafe = legs[res.json()["taskId"]]
    after = plan["legs"][plan["legs"].index(to_cafe) + 1]
    assert to_cafe["rough"] and after["rough"]


def test_a_batch_of_tasks_replans_once_on_its_last_task(client):
    plan_v1(client)
    assert add(client, "Pick up documents", replan=False)["jobId"] is None
    assert client.get("/v1/trips/trip-001").json()["activePlan"]["version"] == 1
    assert add(client, "Drop a form")["jobId"]
    assert client.get("/v1/trips/trip-001").json()["activePlan"]["version"] == 2


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


def test_a_task_can_be_removed_until_it_has_check_ins(client):
    plan_v1(client)
    assert client.delete("/v1/trips/trip-001/tasks/task-office").status_code == 204
    tasks = {t["taskId"] for t in client.get("/v1/trips/trip-001").json()["tasks"]}
    assert "task-office" not in tasks
    clock(client, "11:00")
    client.post("/v1/trips/trip-001/checkins", json={"taskId": "task-meet", "kind": "done", "idempotencyKey": key()})
    assert client.delete("/v1/trips/trip-001/tasks/task-meet").status_code == 409


# ---------- audit regressions: the re-plan loop under real conditions ----------


def delay(c, minutes: int, key_: str | None = None):
    return c.post("/v1/trips/trip-001/checkins", json={"taskId": "task-meet", "kind": "delay", "delayMin": minutes, "idempotencyKey": key_ or key()})


def check(c):
    return c.post("/v1/trips/trip-001/demo/check", json={"idempotencyKey": key()}).json()


def versions() -> int:
    with engine().connect() as conn:
        return conn.execute(text("SELECT count(*) FROM plans WHERE trip_id = 'trip-001' AND version IS NOT NULL")).scalar()


def test_a_reported_delay_survives_the_next_automatic_check(client):
    plan_v1(client)
    clock(client, "10:55")
    options = delay(client, 40).json()
    assert options["result"] == "options"
    set_id = client.get("/v1/trips/trip-001").json()["openOptions"]["optionSetId"]
    clock(client, "11:15")
    after = check(client)
    # Not shifted underneath the waiting options, and the traveller's choice still applies.
    assert after["result"] == "options"
    assert versions() == 1
    open_now = client.get("/v1/trips/trip-001").json()["openOptions"]
    accepted = client.post("/v1/trips/trip-001/options/opt-1/accept", json={"idempotencyKey": key(), "optionSetId": open_now["optionSetId"]})
    assert accepted.status_code == 200, accepted.text
    assert set_id  # the original set existed


def test_accepting_from_a_replaced_option_set_is_refused(client):
    plan_v1(client)
    clock(client, "10:55")
    delay(client, 40)
    res = client.post("/v1/trips/trip-001/options/opt-1/accept", json={"idempotencyKey": key(), "optionSetId": "opts-not-the-current-one"})
    assert res.status_code == 409
    assert res.json()["error"]["code"] == "OPTIONS_CHANGED"
    assert versions() == 1


def test_an_expired_option_is_refused(client):
    plan_v1(client)
    clock(client, "10:55")
    delay(client, 40)
    clock(client, "12:30")  # opt-1 needed a 11:45 departure
    res = client.post("/v1/trips/trip-001/options/opt-1/accept", json={"idempotencyKey": key()})
    assert res.status_code == 409
    assert res.json()["error"]["code"] == "OPTION_EXPIRED"


def test_the_automatic_check_changes_nothing_when_on_time(client):
    plan_v1(client)
    clock(client, "11:03")  # meeting ended at 11:00, leave-by 11:05: not behind
    assert check(client)["result"] == "on_time"
    assert versions() == 1


def test_a_finished_day_is_not_replanned_again_and_again(client):
    plan_v1(client)
    for hhmm_, task in (("11:00", "task-meet"), ("14:55", "task-bank"), ("16:25", "task-office")):
        clock(client, hhmm_)
        client.post("/v1/trips/trip-001/checkins", json={"taskId": task, "kind": "done", "idempotencyKey": key()})
    before = versions()
    for hhmm_ in ("17:30", "17:35", "22:00"):
        clock(client, hhmm_)
        assert check(client)["result"] == "on_time"
    assert versions() == before


def test_a_delay_on_the_way_to_a_fixed_task_says_it_is_at_risk(client):
    plan_v1(client)
    clock(client, "09:30")  # on the metro to the 10:00 meeting
    body = delay(client, 40).json()
    assert "FIXED_TASK_AT_RISK" in body["reasonCodes"], body
    assert "after its 10:00 start" in body["explanation"]


def test_a_task_moved_to_tomorrow_is_planned_tomorrow(client):
    from app.models import Trip as TripModel
    from app.services.day import sense

    plan_v1(client)
    clock(client, "10:55")
    delay(client, 40)
    client.post("/v1/trips/trip-001/options/opt-2/accept", json={"idempotencyKey": key()})
    with session_scope() as db:
        trip = db.get(TripModel, "trip-001")
        from datetime import datetime as dt
        from datetime import timedelta

        ctx = sense(db, trip, dt.fromisoformat("2026-10-15T07:30:00+05:30"))
        assert "task-office" in {t.task_id for t in ctx.planner_tasks()}

    # Planning the next day takes the office in, and there it's an ordinary planned task.
    clock(client, "07:30", day="2026-10-15")
    job = client.post("/v1/trips/trip-001/plans", json={"idempotencyKey": key()}).json()["jobId"]
    assert client.get(f"/v1/jobs/{job}").json()["status"] == "finished"
    trip_view = client.get("/v1/trips/trip-001").json()
    plan = trip_view["activePlan"]
    assert plan["day"] == "2026-10-15" and "task-office" in [leg["taskId"] for leg in plan["legs"]]
    office = {t["taskId"]: t for t in trip_view["tasks"]}["task-office"]
    assert (office["state"], office["day"]) == ("planned", "2026-10-15")
    # The first day's summary still says it moved.
    first_day = client.get("/v1/trips/trip-001/summary", params={"day": "2026-10-14"}).json()
    assert {t["taskId"]: t["state"] for t in first_day["tasks"]}["task-office"] == "moved"

    # On the way there, the office is the current task, not one already passed: also for a row still
    # marked "moved" from before plans set it back to planned.
    leg = next(x for x in plan["legs"] if x["taskId"] == "task-office")
    on_the_way = dt.fromisoformat(leg["leaveBy"]) + timedelta(minutes=5)
    with engine().begin() as conn:
        conn.execute(text("UPDATE tasks SET state = 'moved' WHERE task_id = 'task-office'"))
    with session_scope() as db:
        ctx = sense(db, db.get(TripModel, "trip-001"), on_the_way)
        assert ctx.current is not None and ctx.current.task_id == "task-office"
    link = client.post("/v1/trips/trip-001/share-links", json={"idempotencyKey": key()}).json()
    clock(client, on_the_way.strftime("%H:%M"), day="2026-10-15")
    stops = TestClient(app, base_url="https://testserver").get(f"/v1/shared/{link['token']}").json()["stops"]
    assert next(s for s in stops if s["title"] == "University office")["status"] == "now"


def test_the_summary_of_an_earlier_day_keeps_its_legs(client):
    plan_v1(client)
    summary = client.get("/v1/trips/trip-001/summary?day=2026-10-14").json()
    assert summary["totals"]["fareInr"] == 210
    clock(client, "23:30")
    assert client.get("/v1/trips/trip-001/summary?day=2026-10-14").json()["totals"]["fareInr"] == 210


def test_refresh_without_a_session_is_401_not_a_csrf_error(database):
    fresh = TestClient(app, base_url="https://testserver")
    res = fresh.post("/v1/auth/refresh")
    assert res.status_code == 401
    assert res.json()["error"]["code"] == "UNAUTHENTICATED"


def test_a_lost_refresh_response_does_not_sign_the_traveller_out(client):
    """A reload mid-refresh: the browser sends the just-rotated token again within the grace period."""
    c = TestClient(app, base_url="https://testserver")
    c.post("/v1/auth/demo", json={"as": "traveller"})
    old_refresh, csrf = c.cookies.get("rr_refresh"), c.cookies.get("rr_csrf")
    assert c.post("/v1/auth/refresh", headers={"X-CSRF-Token": csrf}).status_code == 200
    # The browser lost that response, so it still holds both old cookies.
    c.cookies.clear()
    c.cookies.set("rr_refresh", old_refresh, path="/v1/auth")
    c.cookies.set("rr_csrf", csrf, path="/")
    again = c.post("/v1/auth/refresh", headers={"X-CSRF-Token": csrf})
    assert again.status_code == 200


def test_a_signed_out_session_cannot_be_refreshed(client):
    c = TestClient(app, base_url="https://testserver")
    c.post("/v1/auth/demo", json={"as": "traveller"})
    old_refresh, csrf = c.cookies.get("rr_refresh"), c.cookies.get("rr_csrf")
    assert c.post("/v1/auth/logout", headers={"X-CSRF-Token": csrf}).status_code == 204
    c.cookies.clear()
    c.cookies.set("rr_refresh", old_refresh, path="/v1/auth")
    c.cookies.set("rr_csrf", csrf, path="/")
    assert c.post("/v1/auth/refresh", headers={"X-CSRF-Token": csrf}).status_code == 401


# ---------- review fixes: same-place stops, unplaced and moved tasks, the loop's state and lock ----------


def test_skipping_the_last_task_at_the_hotel_is_not_a_conflict(client):
    plan_v1(client)  # 07:30, still at the hotel
    for task in ("task-meet", "task-bank", "task-office"):
        res = client.post("/v1/trips/trip-001/checkins", json={"taskId": task, "kind": "skipped", "idempotencyKey": key()})
        assert res.status_code == 200 and res.json()["result"] == "recorded", res.text
    plan = client.get("/v1/trips/trip-001").json()["activePlan"]
    assert [(leg["taskId"], leg["fromPlaceId"], leg["toPlaceId"], leg["label"]) for leg in plan["legs"]] == [
        (None, "hotel-majestic", "hotel-majestic", "Already there")
    ]
    assert plan["legs"][0]["travelMin"] == 0 and plan["legs"][0]["fareInr"] == 0


def test_a_skip_that_leaves_no_feasible_day_is_saved_not_a_conflict(client):
    plan_v1(client)
    # A fixed 08:00 visit in Whitefield can't be reached from the hotel any more (added without re-planning).
    body = {"title": "Site visit", "placeId": "whitefield-office", "durationMin": 30, "fixedStart": "2026-10-14T08:00:00+05:30", "idempotencyKey": key()}
    visit = client.post("/v1/trips/trip-001/tasks?replan=false", json=body).json()
    res = client.post("/v1/trips/trip-001/checkins", json={"taskId": "task-office", "kind": "skipped", "idempotencyKey": key()})
    assert res.status_code == 200, res.text
    out = res.json()
    assert out["result"] == "no_feasible_plan"
    assert out["reasonCodes"] == ["TASK_SKIPPED", "NO_FEASIBLE_PLAN"]
    assert out["blocked"]["taskId"] == visit["taskId"] and out["explanation"].startswith("Skipped. The site visit starts at 08:00")
    trip = client.get("/v1/trips/trip-001").json()
    assert {t["taskId"]: t["state"] for t in trip["tasks"]}["task-office"] == "skipped"
    assert trip["activePlan"]["version"] == 1


def test_deleting_the_last_task_replaces_the_plan(client):
    plan_v1(client)
    for task in ("task-meet", "task-bank", "task-office"):
        assert client.delete(f"/v1/trips/trip-001/tasks/{task}").status_code == 204
    plan = client.get("/v1/trips/trip-001").json()["activePlan"]
    assert plan["version"] == 4
    assert [leg["taskId"] for leg in plan["legs"]] == [None]


def test_a_task_at_the_place_of_stay_is_planned(client):
    body = {"title": "Hotel checkout", "placeId": "hotel-majestic", "durationMin": 15, "fixedStart": "2026-10-14T08:00:00+05:30", "idempotencyKey": key()}
    checkout = client.post("/v1/trips/trip-001/tasks", json=body).json()
    plan = plan_v1(client)
    first = plan["legs"][0]
    assert first["taskId"] == checkout["taskId"] and first["label"] == "Already there"
    assert (hm(first["leaveBy"]), hm(first["taskStart"])) == ("07:50", "08:00")
    assert plan["moved"] == []


def _plan_with_the_bank_unplaced(c) -> str:
    plan_v1(c)
    # A fixed call at 13:30 leaves the bank (2 h 30 min, open 10:00 to 16:00) no gap: it's unplaced.
    body = {"title": "Client call", "placeId": "jayanagar-office", "durationMin": 60, "fixedStart": "2026-10-14T13:30:00+05:30", "idempotencyKey": key()}
    res = c.post("/v1/trips/trip-001/tasks", json=body)
    assert res.status_code == 201
    moved = c.get("/v1/trips/trip-001").json()["activePlan"]["moved"]
    assert [(m["taskId"], m["kind"]) for m in moved] == [("task-bank", "unplaced")]
    return res.json()["taskId"]


def test_an_unplaced_task_does_not_break_the_next_shift(client):
    call = _plan_with_the_bank_unplaced(client)
    # The call's leg leaves at its fixed latest time, so a short delay at the meeting changes nothing.
    # (With the unplaced bank counted as a task to plan, "shift only" always failed here.)
    clock(client, "10:55")
    assert delay(client, 15).json()["result"] == "on_time"
    clock(client, "11:00")
    checkin(client, "task-meet", "done")
    clock(client, "14:20")
    res = client.post("/v1/trips/trip-001/checkins", json={"taskId": call, "kind": "delay", "delayMin": 20, "idempotencyKey": key()})
    body = res.json()
    assert body["result"] == "shifted", body
    # Still named, with the same reason, in the shifted version.
    moved = body["plan"]["moved"]
    assert [(m["taskId"], m["kind"]) for m in moved] == [("task-bank", "unplaced")]
    assert moved[0]["reason"].startswith("The bank needs 2 h 30 min")


def test_an_unplaced_task_does_not_keep_the_day_open(client):
    _plan_with_the_bank_unplaced(client)
    plan = client.get("/v1/trips/trip-001").json()["activePlan"]
    for leg in plan["legs"][:-1]:
        clock(client, hm(leg["taskEnd"]))
        checkin(client, leg["taskId"], "done")
    before = versions()
    clock(client, "20:00")
    result = check(client)
    assert (result["result"], result["explanation"]) == ("on_time", "Your tasks for today are done.")
    assert versions() == before


def test_the_trip_ends_even_with_an_unplaced_task(client, fake_redis):
    clock(client, "07:30", day="2026-10-15")
    # On the last day, a 2-hour visit to Whitefield that must be over by 08:30 can't fit.
    body = {"title": "Early visit", "placeId": "whitefield-office", "durationMin": 120, "day": "2026-10-15", "idempotencyKey": key()}
    body["window"] = {"opensAt": "06:00", "closesAt": "08:30"}
    assert client.post("/v1/trips/trip-001/tasks", json=body).status_code == 201
    job = client.post("/v1/trips/trip-001/plans", json={"idempotencyKey": key()}).json()["jobId"]
    assert client.get(f"/v1/jobs/{job}").json()["status"] == "finished"
    plan = client.get("/v1/trips/trip-001").json()["activePlan"]
    assert plan["day"] == "2026-10-15" and [m["kind"] for m in plan["moved"]] == ["unplaced"]
    clock(client, "21:30", day="2026-10-15")
    checkin(client, "task-train", "done")
    clock(client, "23:00", day="2026-10-15")
    jobs.send_leave_now_alerts("trip-001")
    assert fake_redis.get("trip_ended:trip-001") == "1"


def test_demo_reset_forgets_what_redis_remembers(client, fake_redis):
    plan_v1(client)
    remembered = [
        "reported_ready:trip-001:task-meet",
        "trip_ended:trip-001",
        "alert_throttle:trip-001",
        "check_lock:trip-001",
        "morning_plan:trip-001:2026-10-15",
    ]
    for name in [*remembered, "trip_ended:trip-other"]:
        fake_redis.set(name, "1")
    assert client.post("/v1/trips/trip-001/demo/reset", json={"idempotencyKey": key()}).status_code == 200
    assert [name for name in remembered if fake_redis.exists(name)] == []
    assert fake_redis.exists("trip_ended:trip-other")


def test_the_automatic_check_keeps_an_unchanged_option_set(client):
    plan_v1(client)
    clock(client, "10:55")
    first = delay(client, 40).json()
    assert first["result"] == "options" and first["optionSetId"].startswith("opts-")
    with engine().connect() as conn:
        rows = conn.execute(text("SELECT count(*) FROM plans WHERE trip_id = 'trip-001'")).scalar()
    clock(client, "11:15")
    again = check(client)
    assert again["result"] == "options" and again["optionSetId"] == first["optionSetId"]
    assert [o["optionId"] for o in again["options"]] == ["opt-1", "opt-2"]
    with engine().connect() as conn:
        assert conn.execute(text("SELECT count(*) FROM plans WHERE trip_id = 'trip-001'")).scalar() == rows
    accepted = client.post("/v1/trips/trip-001/options/opt-1/accept", json={"idempotencyKey": key(), "optionSetId": first["optionSetId"]})
    assert accepted.status_code == 200, accepted.text


class _LockProbe:
    """Wraps the travel-time adapter: while the snapshot is fetched, another connection tries to lock the trip."""

    def __init__(self, inner):
        self.inner = inner
        self.locked_meanwhile: list[bool] = []

    def snapshot(self, city_slug, places, day):
        from sqlalchemy.exc import OperationalError

        with engine().connect() as other:
            try:
                other.execute(text("SELECT trip_id FROM trips WHERE trip_id = 'trip-001' FOR UPDATE NOWAIT"))
                self.locked_meanwhile.append(False)
            except OperationalError:
                self.locked_meanwhile.append(True)
            other.rollback()
        return self.inner.snapshot(city_slug, places, day)


def test_travel_times_are_fetched_without_holding_the_trip_lock(client, monkeypatch):
    from app.adapters.transit import StaticTransitAdapter
    from app.adapters.travel_times import SampleSnapshotAdapter

    from .conftest import RAASTA

    probe = _LockProbe(SampleSnapshotAdapter(StaticTransitAdapter(RAASTA)))
    monkeypatch.setattr(jobs, "adapter_factory", lambda: probe)
    plan_v1(client)  # create_plan
    clock(client, "10:55")
    assert delay(client, 15).json()["result"] == "shifted"  # run
    assert probe.locked_meanwhile and not any(probe.locked_meanwhile)


def test_a_run_that_cannot_get_the_lock_answers_busy(client, monkeypatch):
    from app.services import loop

    plan_v1(client)
    clock(client, "10:55")
    monkeypatch.setattr(loop, "LOCK_TIMEOUT", "200ms")
    with engine().connect() as other:
        # Another run holds the trip (FOR NO KEY UPDATE, as the loop does): the check-in itself still saves.
        other.execute(text("SELECT trip_id FROM trips WHERE trip_id = 'trip-001' FOR NO KEY UPDATE"))
        res = delay(client, 15)
        other.rollback()
    assert res.status_code == 409 and res.json()["error"]["code"] == "BUSY"
    with engine().connect() as conn:
        assert conn.execute(text("SELECT count(*) FROM checkins WHERE trip_id = 'trip-001'")).scalar() == 1
    assert versions() == 1


def test_a_delay_that_still_arrives_before_a_fixed_start_says_by_how_much(client):
    plan_v1(client)
    clock(client, "09:00")  # on the metro to the 10:00 meeting, arriving 09:50
    body = delay(client, 5).json()
    assert "FIXED_TASK_AT_RISK" in body["reasonCodes"], body
    assert body["explanation"].startswith("You'll reach the meeting at about 09:55, 5 min before its 10:00 start; you need 10.")
    assert "after its" not in body["explanation"]


def test_finishing_a_task_early_moves_the_next_stop_earlier(client):
    plan_v1(client)
    clock(client, "10:40")  # the meeting was planned to end at 11:00
    body = client.post("/v1/trips/trip-001/checkins", json={"taskId": "task-meet", "kind": "done", "idempotencyKey": key()}).json()
    assert body["result"] == "shifted", body
    assert body["explanation"] == "Your day still fits. Your next stop moves 20 min earlier. No extra cost."
    assert client.get("/v1/trips/trip-001").json()["log"][0]["text"] == "Moved 3 stops 20 min earlier"


def test_bad_query_values_are_422_or_400_not_500(client):
    import base64

    assert client.get("/v1/trips/trip-001/summary", params={"day": "not-a-day"}).status_code == 422
    outside = client.get("/v1/trips/trip-001/summary", params={"day": "2026-10-20"})
    assert outside.status_code == 422 and outside.json()["error"]["code"] == "VALIDATION_ERROR"
    cursor = base64.urlsafe_b64encode(b"not-a-date|trip-001").decode()
    assert client.get("/v1/trips", params={"cursor": cursor}).status_code == 400


def test_a_described_task_with_an_impossible_time_has_no_fixed_time(client, monkeypatch):
    from app.config import get_settings

    async def fake_llm(text, city, day):
        return [{"title": "Lunch", "placeText": "", "durationMin": 60, "fixedStart": "25:99", "priority": 2}]

    monkeypatch.setattr(get_settings(), "ai_helper_enabled", True)
    monkeypatch.setattr("app.adapters.llm.extract_tasks_llm", fake_llm)
    res = client.post("/v1/trips/trip-001/task-drafts", json={"text": "Lunch at 25:99", "idempotencyKey": key()})
    assert res.status_code == 200, res.text
    assert res.json()[0]["fixedStart"] is None


def test_bookings_exist_only_with_the_demo_login(client, monkeypatch):
    from app.config import get_settings

    assert client.get("/v1/trips/trip-001/bookings").status_code == 200
    monkeypatch.setattr(get_settings(), "demo_login", False)
    assert client.get("/v1/trips/trip-001/bookings").status_code == 404
    assert client.get("/v1/trips/trip-001/train-options", params={"taskId": "task-train", "to": "Chennai"}).status_code == 404
    body = {"kind": "cab", "toId": "task-bank", "optionId": "x", "idempotencyKey": key()}
    assert client.post("/v1/trips/trip-001/bookings", json=body).status_code == 404


def test_the_user_says_which_features_are_on(client, monkeypatch):
    from app.config import get_settings

    assert client.get("/v1/me").json()["features"] == {"bookings": True, "aiHelper": False, "voices": True}
    monkeypatch.setattr(get_settings(), "ai_helper_enabled", True)
    monkeypatch.setattr(get_settings(), "tts_enabled", False)
    signed_in = TestClient(app, base_url="https://testserver").post("/v1/auth/demo", json={"as": "traveller"}).json()
    assert signed_in["user"]["features"] == {"bookings": True, "aiHelper": True, "voices": False}
