"""Travel-time and transit adapters: OSRM with Raasta legs, caching, and falling back when a service is down."""

from __future__ import annotations

import json
from datetime import date

import httpx

from app.adapters.transit import RaastaHttpAdapter, RaastaLeg, RouteInfo, StaticTransitAdapter
from app.adapters.travel_times import OsrmSnapshotAdapter, PlacePoint
from app.services.planner import Mode

DAY = date(2026, 10, 14)
KOR = PlacePoint("koramangala-bank", 77.6195, 12.9352)
JAY = PlacePoint("jayanagar-office", 77.5838, 12.9255)


def _osrm(calls: list[str]) -> httpx.Client:
    def handler(request: httpx.Request) -> httpx.Response:
        calls.append(request.url.host)
        # 2 places: 12 min / 6 km by car, 70 min by foot.
        return httpx.Response(200, json={"durations": [[0, 720], [720, 0]], "distances": [[0, 6000], [6000, 0]]})

    return httpx.Client(transport=httpx.MockTransport(handler))


def _leg(status: str = "verified") -> RaastaLeg:
    return RaastaLeg(
        route_id="sample-kor-jay",
        vehicle_type="shared_auto",
        status=status,
        fare_inr=30,
        first_trip="07:00",
        last_trip="21:30",
        walk_from_min=3,
        walk_to_min=4,
        wait_min=5,
        ride_min=28,
    )


def test_osrm_snapshot_includes_cabs_and_raasta_legs(fake_redis):
    transit = StaticTransitAdapter({}, {(KOR.place_id, JAY.place_id): [_leg()]})
    calls: list[str] = []
    snap = OsrmSnapshotAdapter(transit, fake_redis, client=_osrm(calls)).snapshot("bengaluru", [KOR, JAY], DAY)
    there = next(p for p in snap.pairs if p.from_place == KOR.place_id)
    modes = {o.mode for o in there.options}
    assert Mode.CAB in modes and Mode.SHARED_AUTO in modes
    auto = next(o for o in there.options if o.mode is Mode.SHARED_AUTO)
    assert auto.travel_min == 3 + 5 + 28 + 4
    assert auto.fare_inr == 30
    assert (auto.service_first, auto.service_last) == (7 * 60, 21 * 60 + 30)
    assert auto.transit_ref is not None and auto.transit_ref.status == "verified"
    cab = next(o for o in there.options if o.mode is Mode.CAB)
    assert cab.travel_min == 12 + 5  # drive plus pickup


def test_osrm_tables_are_cached(fake_redis):
    calls: list[str] = []
    adapter = OsrmSnapshotAdapter(StaticTransitAdapter({}), fake_redis, client=_osrm(calls))
    adapter.snapshot("bengaluru", [KOR, JAY], DAY)
    adapter.snapshot("bengaluru", [KOR, JAY], DAY)
    assert len(calls) == 2  # car and foot once, then from the cache


def test_osrm_outage_falls_back_to_the_sample_snapshot(fake_redis):
    def down(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("refused")

    adapter = OsrmSnapshotAdapter(StaticTransitAdapter({}), fake_redis, client=httpx.Client(transport=httpx.MockTransport(down)))
    snap = adapter.snapshot("bengaluru", [KOR, JAY], DAY)
    assert snap.snapshot_id.startswith("blr-sample")
    assert any(p.from_place == KOR.place_id and p.to_place == JAY.place_id for p in snap.pairs)


def test_raasta_answers_are_cached(fake_redis):
    hits: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        hits.append(request.url.path)
        return httpx.Response(200, json={"status": "verified", "firstTrip": "07:00", "lastTrip": "21:30", "fareInr": 30, "frequencyMin": 10})

    adapter = RaastaHttpAdapter("http://raasta", client=httpx.Client(transport=httpx.MockTransport(handler)), redis_client=fake_redis)
    first = adapter.routes(["sample-kor-jay"])
    second = adapter.routes(["sample-kor-jay"])
    assert first == second == {"sample-kor-jay": RouteInfo("sample-kor-jay", "verified", "07:00", "21:30", 30, 10)}
    assert len(hits) == 1


def test_raasta_leg_options_estimate_the_ride(fake_redis):
    def handler(request: httpx.Request) -> httpx.Response:
        assert request.url.params["at"].startswith("2026-10-14T00:05")
        item = {
            "routeId": "sample-kor-jay",
            "vehicleType": "shared_auto",
            "status": "verified",
            "fareInr": 30,
            "firstTrip": "07:00",
            "lastTrip": "21:30",
            "walkFromMin": 3,
            "walkToMin": 4,
            "expectedWaitMin": 5,
            "rideDistanceM": 5000,
        }
        return httpx.Response(200, json={"items": [item], "extras": [], "lastTripPassed": []})

    adapter = RaastaHttpAdapter("http://raasta", client=httpx.Client(transport=httpx.MockTransport(handler)), redis_client=fake_redis)
    legs = adapter.leg_options(KOR, JAY, DAY, "+05:30")
    assert [(x.route_id, x.ride_min, x.travel_min) for x in legs] == [("sample-kor-jay", 20, 3 + 5 + 20 + 4)]
    cached = [json.loads(fake_redis.get(k)) for k in fake_redis.scan_iter("raasta:legs:*")]
    assert cached and cached[0][0]["route_id"] == "sample-kor-jay"


def test_raasta_unreachable_means_no_raasta_legs(fake_redis):
    def down(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("refused")

    adapter = RaastaHttpAdapter("http://raasta", client=httpx.Client(transport=httpx.MockTransport(down)), redis_client=fake_redis)
    assert adapter.leg_options(KOR, JAY, DAY, "+05:30") == []
    assert adapter.routes(["sample-kor-jay"]) == {}
