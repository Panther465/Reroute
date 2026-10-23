"""Each leg along real roads, metro lines and recorded paths, for the map and the directions."""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from app.adapters.metro import metro_lines
from app.adapters.road_path import Route, Step, Unavailable
from app.adapters.transit import RouteShape
from app.config import get_settings
from app.main import app
from app.services import leg_paths

from .conftest import key

LINES = metro_lines(get_settings().examples_dir / "bengaluru" / "metro.json")
PLACES = {
    "hotel-majestic": (77.5713, 12.9767),
    "whitefield-office": (77.7318, 12.9855),
    "koramangala-bank": (77.6195, 12.9352),
    "jayanagar-office": (77.5838, 12.9255),
}
STANDS = [
    ("Koramangala 5th Block stand", 77.6185, 12.934),
    ("Forum Mall", 77.6112, 12.9346),
    ("Dairy Circle", 77.6013, 12.9375),
    ("Jayanagar 4th Block stand", 77.583, 12.929),
]
TO_WHITEFIELD = {
    "seq": 1,
    "mode": "metro",
    "segments": [{"mode": "metro", "minutes": 45}, {"mode": "shared_auto", "minutes": 15}],
    "fromPlaceId": "hotel-majestic",
    "toPlaceId": "whitefield-office",
    "transitRef": {"kind": "metro", "refId": "purple-line"},
    "travelMin": 60,
}
BANK_TO_OFFICE = {
    "seq": 3,
    "mode": "shared_auto",
    "segments": [{"mode": "walk", "minutes": 3}, {"mode": "shared_auto", "minutes": 25}, {"mode": "walk", "minutes": 4}],
    "fromPlaceId": "koramangala-bank",
    "toPlaceId": "jayanagar-office",
    "transitRef": {"kind": "raasta", "refId": "sample-kor-jay"},
    "travelMin": 32,
}


class FakeRouter:
    """Roads without the network: a route through the points asked for, with a turn on the way."""

    def __init__(self, on: bool = True, down: bool = False):
        self.calls = 0
        self.asked: list[tuple[str, list]] = []
        self._on, self._down = on, down

    def on(self, profile):
        return self._on

    def route(self, points, profile):
        self.calls += 1
        self.asked.append((profile, points))
        if self._down:
            raise Unavailable("down")
        coords = [points[0], ((points[0][0] + points[-1][0]) / 2, (points[0][1] + points[-1][1]) / 2 + 0.0005), *points[1:]]
        steps = [
            Step("depart", "", "MG Road", None, 400, 90, 0),
            Step("turn", "left", "Brigade Road", None, 600, 120, 1),
            Step("arrive", "", "", None, 0, 0, len(coords) - 1),
        ]
        return Route(coords=coords, distance_m=1000, duration_s=210, steps=steps)


def _drawing(router=None, shapes=None):
    return leg_paths.Drawing(router=router or FakeRouter(), lines=LINES, shape=lambda route_id: (shapes or {}).get(route_id))


def test_a_metro_ride_passes_every_station_between_boarding_and_getting_off():
    out = leg_paths.draw_leg(_drawing(), TO_WHITEFIELD, PLACES)
    walk, rail, auto = out["segments"]
    assert out["complete"] and (walk["mode"], rail["mode"], auto["mode"]) == ("walk", "metro", "shared_auto")
    assert (walk["source"], rail["source"], auto["source"]) == ("road", "rail", "road")
    purple = [s.name for s in LINES["purple-line"].stations]
    names = [s["name"] for s in rail["stops"]]
    first, last = purple.index(names[0]), purple.index(names[-1])
    # Majestic towards Whitefield: every station on the way, in order, none skipped.
    assert names[0] == "Nadaprabhu Kempegowda Station, Majestic"
    assert names == purple[first : last + 1] or names == purple[last : first + 1][::-1]
    board, alight = rail["steps"]
    assert (board["kind"], board["line"], board["towards"], board["stops"]) == ("board", "Purple Line", "Whitefield (Kadugodi)", len(names) - 1)
    assert (alight["kind"], alight["name"], alight["at"]) == ("alight", names[-1], len(rail["coords"]) - 1)
    assert rail["line"] == {"name": "Purple Line", "colour": "#8e2a8f"} and rail["durationS"] == 45 * 60
    # The walk joins the station, and the shared auto leaves from it.
    assert walk["coords"][-1] == rail["coords"][0] and auto["coords"][0] == rail["coords"][-1]


def test_a_shared_auto_rides_its_recorded_path_or_the_roads_through_its_stands():
    path = [(77.6185, 12.934), (77.615, 12.9342), (77.6112, 12.9346), (77.606, 12.936), (77.6013, 12.9375), (77.59, 12.932), (77.583, 12.929)]
    recorded = leg_paths.draw_leg(_drawing(shapes={"sample-kor-jay": RouteShape("shared_auto", STANDS, path)}), BANK_TO_OFFICE, PLACES)
    walk_in, ride, walk_out = recorded["segments"]
    assert [s["mode"] for s in recorded["segments"]] == ["walk", "shared_auto", "walk"]
    assert ride["source"] == "recorded" and [tuple(c) for c in ride["coords"]] == path
    assert [s["name"] for s in ride["stops"]] == [n for n, _lng, _lat in STANDS]
    assert ride["steps"][0]["name"] == "Koramangala 5th Block stand" and ride["steps"][-1]["name"] == "Jayanagar 4th Block stand"
    assert ride["durationS"] == 25 * 60 and walk_in["source"] == walk_out["source"] == "road"

    router = FakeRouter()
    roads = leg_paths.draw_leg(_drawing(router, {"sample-kor-jay": RouteShape("shared_auto", STANDS, [])}), BANK_TO_OFFICE, PLACES)
    assert roads["segments"][1]["source"] == "road"
    # Through every stand, in order.
    assert ("car", [(lng, lat) for _n, lng, lat in STANDS]) in router.asked


def test_what_nothing_can_place_is_drawn_straight_and_marked_approximate():
    # The purple line passes nowhere near the bank: the last stretch from the station is too far to walk, and
    # the leg doesn't say how, so it's straight and marked approximate rather than a made-up road.
    to_bank = {**TO_WHITEFIELD, "toPlaceId": "koramangala-bank", "segments": [{"mode": "metro", "minutes": 35}]}
    out = leg_paths.draw_leg(_drawing(), to_bank, PLACES)
    assert out["segments"][-1]["source"] == "approximate" and out["segments"][-1]["mode"] == "walk"
    # With routing off, a cab is a straight line too; it's done (not waiting for a busy server).
    cab = {"seq": 2, "mode": "cab", "segments": [{"mode": "cab", "minutes": 40}], "fromPlaceId": "hotel-majestic", "toPlaceId": "koramangala-bank"}
    off = leg_paths.draw_leg(_drawing(FakeRouter(on=False)), cab, PLACES)
    assert [s["source"] for s in off["segments"]] == ["approximate"] and off["complete"]
    busy = leg_paths.draw_leg(_drawing(FakeRouter(down=True)), cab, PLACES)
    assert busy["segments"][0]["source"] == "approximate" and not busy["complete"]


# ---------- through the API ----------


@pytest.mark.db
def test_the_days_legs_are_drawn_after_planning_and_only_for_its_traveller(client):
    assert client.post("/v1/trips/trip-001/plans", json={"idempotencyKey": key()}).status_code == 202
    trip = client.get("/v1/trips/trip-001").json()
    plan = trip["activePlan"]
    res = client.get(f"/v1/trips/trip-001/plans/{plan['version']}/paths")
    assert res.status_code == 200, res.text
    drawn = res.json()
    # Routing is off in tests: roads are straight and marked so, but the metro still runs station to station.
    assert drawn["complete"] and [leg["seq"] for leg in drawn["legs"]] == sorted(leg["seq"] for leg in plan["legs"])
    first = next(leg for leg in drawn["legs"] if leg["seq"] == plan["legs"][0]["seq"])
    rail = next(s for s in first["segments"] if s["source"] == "rail")
    assert rail["stops"][0]["name"] == "Nadaprabhu Kempegowda Station, Majestic" and len(rail["stops"]) > 5
    assert all(s["source"] in ("rail", "approximate") for leg in drawn["legs"] for s in leg["segments"])

    other = TestClient(app, base_url="https://testserver")
    token = other.post("/v1/auth/signup", json={"name": "Meera", "email": "meera.paths@example.com", "password": "a-long-password"}).json()["accessToken"]
    other.headers["Authorization"] = f"Bearer {token}"
    assert other.get(f"/v1/trips/trip-001/plans/{plan['version']}/paths").status_code == 404
    assert client.get("/v1/trips/trip-001/plans/99/paths").status_code == 404
