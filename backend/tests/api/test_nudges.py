"""Rico checks in: the usual-traffic model (typical traffic by city, hour and weekday, never live data), and the
nudges the 5-minute check sends from it, or when the traveller looks behind."""

from __future__ import annotations

import json
from datetime import UTC, datetime

import pytest

from app.adapters import fcm
from app.config import get_settings
from app.services import push, traffic

from .conftest import key
from .test_push import ACCOUNT, PHONE, Recorder, register

WED, SAT, SUN = "2026-10-14", "2026-10-17", "2026-10-18"  # the demo day is a Wednesday


def at(when: str) -> datetime:
    """A local time in Bengaluru: "2026-10-14 09:30"."""
    return datetime.fromisoformat(f"{when.replace(' ', 'T')}:00+05:30")


# ---------- usual traffic ----------


def test_weekday_mornings_and_evenings_are_the_peaks():
    for hhmm in ("08:30", "09:45", "10:59", "17:30", "19:00", "20:59"):
        assert traffic.busyness(at(f"{WED} {hhmm}")) == 1.0, hhmm
    # Around them the roads fill up and empty, all day they're slow, and at night they're clear.
    for hhmm in ("07:45", "08:29", "11:00", "14:00", "17:29", "21:00"):
        assert 0 < traffic.busyness(at(f"{WED} {hhmm}")) < 1, hhmm
    for hhmm in ("00:30", "05:00", "07:29", "22:30", "23:45"):
        assert traffic.busyness(at(f"{WED} {hhmm}")) == 0, hhmm


def test_weekends_are_lighter():
    weekday, saturday, sunday = (traffic.busyness(at(f"{day} 18:30")) for day in (WED, SAT, SUN))
    assert weekday > saturday > sunday > 0
    assert traffic.busyness(at(f"{SAT} 03:00")) == 0


def test_only_rides_on_the_roads_slow_down():
    peak = at(f"{WED} 09:30")
    for mode in ("cab", "auto", "shared_auto", "e_rickshaw", "tempo", "bus", "bike"):
        assert traffic.factor("bengaluru", mode, peak) == 1.5, mode
    assert traffic.factor("bengaluru", "metro", peak) == traffic.factor("bengaluru", "walk", peak) == 1.0
    assert traffic.usual_delay_min("bengaluru", "metro", peak, 45) == 0
    # Never quicker than planned: a clear road isn't promised.
    assert traffic.factor("bengaluru", "cab", at(f"{WED} 03:00")) == 1.0


def test_each_metro_has_its_own_figure_and_other_towns_the_default():
    peak = at(f"{WED} 18:30")
    elsewhere = traffic.usual_delay_min("kochi", "cab", peak, 60)
    assert elsewhere == 12  # a fifth
    for city in ("bengaluru", "mumbai", "delhi", "chennai", "hyderabad", "kolkata", "pune", "ahmedabad"):
        assert traffic.usual_delay_min(city, "cab", peak, 60) > elsewhere, city
    assert traffic.usual_delay_min("bengaluru", "cab", peak, 60) == 30
    # A town that runs into a big city moves like it.
    assert traffic.factor("gurugram", "cab", peak) == traffic.factor("delhi", "cab", peak)


def test_the_time_is_read_in_india():
    local = at(f"{WED} 09:30")
    assert traffic.busyness(local.astimezone(UTC)) == traffic.busyness(local) == 1.0  # 04:00 UTC
    assert traffic.busyness(local.replace(tzinfo=None)) == 1.0  # no offset: local already


def test_only_a_delay_that_matters_is_worth_a_word():
    assert traffic.meaningful(8, 90) and not traffic.meaningful(7, 90)
    # A quarter of a short ride counts too, from 5 minutes.
    assert traffic.meaningful(5, 20) and not traffic.meaningful(4, 12)
    assert traffic.is_busy("bengaluru", "cab", at(f"{WED} 18:30"), 30)  # 15 minutes more
    assert not traffic.is_busy("bengaluru", "cab", at(f"{WED} 14:00"), 30)  # 5 minutes more
    assert not traffic.is_busy("bengaluru", "metro", at(f"{WED} 18:30"), 30)
    assert not traffic.is_busy("kochi", "cab", at(f"{WED} 18:30"), 20)  # 4 minutes more


def test_how_much_earlier_is_said_in_fives():
    assert [traffic.leave_earlier_min(m) for m in (2, 7, 8, 12, 13, 19)] == [5, 5, 10, 10, 15, 20]


def at_the_evening_peak(*segments: tuple[str, int]) -> dict:
    """A planned leg leaving at 18:30 on a Wednesday, as the plan stores it."""
    return {"leaveBy": f"{WED}T18:30:00+05:30", "segments": [{"mode": mode, "minutes": minutes} for mode, minutes in segments]}


def test_a_legs_walks_and_metro_rides_keep_their_time(monkeypatch):
    auto = at_the_evening_peak(("walk", 5), ("shared_auto", 20), ("walk", 3))
    assert traffic.leg_delay_min("bengaluru", auto) == 10
    assert traffic.leg_delay_min("bengaluru", at_the_evening_peak(("metro", 45), ("shared_auto", 15))) == 8  # the auto at the end
    # TRAFFIC_SOURCE=off: no word about traffic at all.
    monkeypatch.setattr(get_settings(), "traffic_source", "off")
    assert traffic.leg_delay_min("bengaluru", auto) == 0


# ---------- the nudges ----------


@pytest.fixture
def firebase_on(monkeypatch):
    recorder = Recorder()
    monkeypatch.setattr(fcm, "configured_account", lambda: ACCOUNT)
    monkeypatch.setattr(push, "sender_factory", recorder)
    return recorder


@pytest.fixture
def stream(fake_redis):
    """The trip's live stream, as the app would hear it."""
    pubsub = fake_redis.pubsub()
    pubsub.subscribe("trip:trip-001")
    return pubsub


def nudges(stream) -> list[dict]:
    """The nudges published since the last look."""
    found = []
    while (message := stream.get_message()) is not None:
        if message["type"] == "message" and (event := json.loads(message["data"]))["event"] == "nudge":
            found.append(event["data"])
    return found


def clock(c, when: str):
    assert c.post("/v1/trips/trip-001/demo/clock", json={"now": at(when).isoformat(), "idempotencyKey": key()}).status_code == 200


def check(c) -> dict:
    res = c.post("/v1/trips/trip-001/demo/check", json={"idempotencyKey": key()})
    assert res.status_code == 200, res.text
    return res.json()


def plan(c) -> list[dict]:
    res = c.post("/v1/trips/trip-001/plans", json={"idempotencyKey": key()})
    assert res.status_code == 202 and c.get(f"/v1/jobs/{res.json()['jobId']}").json()["status"] == "finished"
    return c.get("/v1/trips/trip-001").json()["activePlan"]["legs"]


def dinner_then_the_train(c) -> list[dict]:
    """Day 2, a Thursday: dinner in Koramangala at 19:00, by metro, then a cab across town to the 21:00 train."""
    body = {"title": "Dinner", "placeId": "koramangala-bank", "durationMin": 30, "fixedStart": "2026-10-15T19:00:00+05:30", "idempotencyKey": key()}
    assert c.post("/v1/trips/trip-001/tasks", json=body).status_code == 201
    clock(c, "2026-10-15 07:30")
    return plan(c)


@pytest.mark.db
def test_rico_checks_in_once_before_a_ride_on_busy_roads(client, firebase_on, stream):
    register(client)
    to_train = dinner_then_the_train(client)[1]
    assert (to_train["taskId"], to_train["mode"], to_train["leaveBy"]) == ("task-train", "cab", "2026-10-15T20:13:00+05:30")
    # 37 minutes by cab is usually half as long again at the evening peak.
    assert traffic.leg_delay_min("bengaluru", to_train) == 19
    clock(client, "2026-10-15 19:28")  # 45 minutes before: too early to be about now
    check(client)
    assert nudges(stream) == [] and firebase_on.sent == []

    clock(client, "2026-10-15 19:38")
    check(client)
    seq = to_train["seq"]
    said = {
        "seq": seq,
        "taskId": "task-train",
        "leaveBy": "2026-10-15T20:13:00+05:30",
        "label": "Cab",
        "reason": "busy",
        "suggestLeaveBy": "2026-10-15T19:53:00+05:30",
        "extraMin": 20,
    }
    assert nudges(stream) == [said]
    # On the phone, a hello from Rico until the leave-by time, carrying what the app needs to say why.
    [(token, data, ttl)] = firebase_on.sent
    assert token == PHONE and 35 * 60 - 5 <= ttl <= 35 * 60
    assert data == {
        **{k: str(v) for k, v in said.items()},
        "kind": "nudge",
        "title": "Rico",
        "body": "Hi, are you there? 👋",
        "tag": f"nudge-{seq}",
        "tripId": "trip-001",
    }
    # Once for this leg of this plan.
    clock(client, "2026-10-15 19:43")
    check(client)
    assert nudges(stream) == [] and len(firebase_on.sent) == 1


@pytest.mark.db
def test_no_check_in_before_the_metro_or_a_walk(client, stream):
    # The demo day's metro to the 10:00 meeting, at the morning peak: the shared auto at its end usually loses
    # 8 minutes, worth a word on a road leg, but the train sets a metro leg's time.
    metro = plan(client)[0]
    assert (metro["mode"], metro["leaveBy"]) == ("metro", "2026-10-14T08:50:00+05:30")
    assert traffic.leg_delay_min("bengaluru", metro) == 8
    clock(client, "2026-10-14 08:15")
    check(client)
    assert nudges(stream) == []
    # Day 2: a walk from the hotel to the 21:00 train, in the evening peak.
    clock(client, "2026-10-15 07:30")
    walk = plan(client)[0]
    assert (walk["mode"], walk["leaveBy"]) == ("walk", "2026-10-15T20:45:00+05:30")
    clock(client, "2026-10-15 20:10")
    check(client)
    assert nudges(stream) == []


@pytest.mark.db
def test_no_check_in_when_the_roads_are_usually_fine(client, stream):
    # The demo day's shared auto at 15:00 on a Wednesday: the working day slows it only a little.
    office = plan(client)[2]
    assert (office["mode"], office["leaveBy"]) == ("shared_auto", "2026-10-14T15:00:00+05:30")
    assert traffic.leg_delay_min("bengaluru", office) == 6  # of 40 minutes
    clock(client, "2026-10-14 11:00")
    assert client.post("/v1/trips/trip-001/checkins", json={"taskId": "task-meet", "kind": "done", "idempotencyKey": key()}).status_code == 200
    clock(client, "2026-10-14 14:25")  # at the bank, 35 minutes before the auto
    check(client)
    assert nudges(stream) == []


def late_at_the_meeting(c):
    """40 minutes late at the meeting: the options wait for the traveller, so the 5-minute checks don't shift the day."""
    plan(c)
    clock(c, "2026-10-14 10:55")
    res = c.post("/v1/trips/trip-001/checkins", json={"taskId": "task-meet", "kind": "delay", "delayMin": 40, "idempotencyKey": key()})
    assert res.json()["result"] == "options"


@pytest.mark.db
def test_rico_checks_in_once_when_the_traveller_looks_behind(client, firebase_on, stream):
    register(client)
    late_at_the_meeting(client)
    # The bank leg's 11:05 went by with no check to say "Leave now".
    clock(client, "2026-10-14 11:15")
    assert check(client)["result"] == "options"
    said = {"seq": 2, "taskId": "task-bank", "leaveBy": "2026-10-14T11:05:00+05:30", "label": "Metro, then shared auto", "reason": "behind", "behindMin": 40}
    assert nudges(stream) == [said]
    [(_, data, ttl)] = firebase_on.sent
    assert (data["kind"], data["title"], data["body"], data["tag"], data["reason"]) == ("nudge", "Rico", push.NUDGE_TEXT, "nudge-2", "behind")
    assert 15 * 60 - 5 <= ttl <= 15 * 60
    clock(client, "2026-10-14 11:20")
    check(client)
    assert nudges(stream) == [] and len(firebase_on.sent) == 1


@pytest.mark.db
def test_the_leave_now_alert_covers_a_traveller_who_looks_behind(client, firebase_on, stream):
    register(client)
    late_at_the_meeting(client)
    clock(client, "2026-10-14 11:06")
    check(client)
    clock(client, "2026-10-14 11:15")
    check(client)
    # "Leave now" already told them it was time: Rico doesn't ask again.
    assert [data["kind"] for _, data, _ in firebase_on.sent] == ["leave_now"]
    assert nudges(stream) == []
