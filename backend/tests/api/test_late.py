"""Late for someone else's meeting. Reroute never moves it: it offers to go anyway, plans the rest of the
day from the real arrival, and keeps that choice in later re-plans."""

from __future__ import annotations

import pytest

from .conftest import key
from .test_flow import clock, delay, hm, plan_v1

pytestmark = pytest.mark.db


def meeting_leg(plan: dict) -> dict:
    return next(leg for leg in plan["legs"] if leg["taskId"] == "task-meet")


def test_late_before_leaving_offers_go_anyway_and_the_meeting_stays(client):
    plan_v1(client)
    clock(client, "08:45")  # still at the hotel; the plan leaves at 08:50 for the 10:00 meeting
    out = delay(client, 30).json()  # ready at 09:15: the hour by metro and auto can't make 09:50
    assert out["result"] == "options", out
    late = out["options"][-1]
    assert late["kind"] == "late" and late["label"].startswith("Go anyway, about"), late
    assert "it starts at 10:00" in late["consequence"] and late["explanation"].startswith("The meeting stays at 10:00: it isn’t yours to move")
    accepted = client.post(f"/v1/trips/trip-001/options/{late['optionId']}/accept", json={"idempotencyKey": key(), "optionSetId": out["optionSetId"]})
    assert accepted.status_code == 200, accepted.text

    trip = client.get("/v1/trips/trip-001").json()
    assert hm(meeting_leg(trip["activePlan"])["taskStart"]) > "10:00"
    meet = {t["taskId"]: t for t in trip["tasks"]}["task-meet"]
    assert meet["fixedStart"] == "2026-10-14T04:30:00Z" and meet["state"] != "moved"  # still 10:00 in Bengaluru: it never moved
    assert trip["log"][0]["text"].startswith("Going anyway: you reach the meeting at about")

    # Later still: the day shifts again, without asking the same question again.
    clock(client, "09:00")
    again = delay(client, 20).json()
    assert again["result"] == "shifted", again
    assert hm(meeting_leg(client.get("/v1/trips/trip-001").json()["activePlan"])["taskStart"]) > hm(meeting_leg(trip["activePlan"])["taskStart"])


def test_planning_the_day_too_late_for_the_meeting_goes_anyway_and_says_so(client):
    clock(client, "09:30")  # the first plan of the day: the 10:00 meeting can't be reached by 09:50
    res = client.post("/v1/trips/trip-001/plans", json={"idempotencyKey": key()})
    job = client.get(f"/v1/jobs/{res.json()['jobId']}").json()
    assert job["status"] == "finished", job
    plan = client.get("/v1/trips/trip-001").json()["activePlan"]
    assert hm(meeting_leg(plan)["taskStart"]) > "10:00"
    assert "min after it starts. Tell them you’re running late." in plan["explanation"], plan["explanation"]
