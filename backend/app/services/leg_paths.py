"""A plan's legs as real paths for the map and the directions, segment by segment, with turn-by-turn steps.

- A metro ride: to the line's station nearest the start (on foot, or the leg's own way there), through every
  station to the one nearest the stop, then on to the stop the same way.
- A Raasta ride (shared autos and the like): walk to the route's stand nearest the start, ride along its
  recorded path (or the roads through its stands) to the stand nearest the stop, and walk on.
- Anything else: the whole leg along the roads, by car or on foot.
A stretch nothing here can place is a straight line marked approximate. This is only for the map and the
directions: a leg's times and fares stay the planner's.

Drawn by a worker job (the `maps` queue, after any planning) a few routing calls at a time, kept in Redis for a
week, and announced with a `paths_ready` live event.
"""

from __future__ import annotations

import json
import logging
from collections.abc import Callable
from dataclasses import dataclass
from typing import Any

from app import events
from app.adapters.metro import MetroLine
from app.adapters.road_path import LngLat, Profile, Route, Router, Unavailable, metres
from app.adapters.transit import RouteShape
from app.redis_client import get_redis
from app.workers.queue import get_maps_queue

log = logging.getLogger("reroute.paths")

#: A first or last stretch longer than this isn't a walk: drawn approximate unless the leg says how.
WALK_M = 1500
#: Ends closer than this need no line.
NEAR_M = 30
#: Routing calls per job run; the job runs again for the rest.
BUDGET = 6
STORE_SECONDS = 7 * 24 * 3600


def _key(plan_id: str) -> str:
    return f"legplan:{plan_id}"


def load(plan_id: str) -> dict[str, Any] | None:
    raw = get_redis().get(_key(plan_id))
    return json.loads(raw) if raw else None


def start(plan_id: str) -> None:
    """Draw a plan's legs, unless that's already under way. Never fails the caller: the map waits instead."""
    try:
        if get_redis().set(f"{_key(plan_id)}:warming", "1", nx=True, ex=120):
            get_maps_queue().enqueue("app.workers.jobs.warm_plan_paths", plan_id, job_timeout=300)
    except Exception:
        log.warning("Couldn't start drawing plan %s along the roads", plan_id, exc_info=True)


@dataclass
class Drawing:
    router: Router
    lines: dict[str, MetroLine]
    shape: Callable[[str], RouteShape | None]
    #: Something couldn't be drawn now (routing busy or out of this run's calls): the leg is drawn again later.
    later: bool = False

    def route(self, points: list[LngLat], profile: Profile) -> Route | None:
        if not self.router.on(profile):
            return None
        try:
            return self.router.route(points, profile)
        except Unavailable:
            self.later = True
            return None


def _segment(
    mode: str,
    source: str,
    coords: list[LngLat],
    *,
    steps: list[dict] | None = None,
    stops: list[dict] | None = None,
    line: dict | None = None,
    distance_m: float | None = None,
    duration_s: int = 0,
) -> dict:
    length = distance_m if distance_m is not None else sum(metres(coords[i], coords[i + 1]) for i in range(len(coords) - 1))
    return {
        "mode": mode,
        "source": source,
        "coords": [list(c) for c in coords],
        "stops": stops or [],
        "line": line,
        "distanceM": round(length),
        "durationS": duration_s,
        "steps": steps or [],
    }


def _approximate(mode: str, a: LngLat, b: LngLat) -> dict:
    return _segment(mode, "approximate", [a, b])


def _road(d: Drawing, a: LngLat, b: LngLat, mode: str, turns: bool = True) -> list[dict]:
    """A stretch along the roads (on foot for a walk); approximate when no road is known."""
    if metres(a, b) < NEAR_M:
        return []
    route = d.route([a, b], "foot" if mode == "walk" else "car")
    if route is None or len(route.coords) < 2:
        return [_approximate(mode, a, b)]
    steps = [
        {"kind": s.kind, "modifier": s.modifier, "name": s.name, "exit": s.exit, "distanceM": s.distance_m, "durationS": s.duration_s, "at": s.at}
        for s in route.steps
    ]
    return [_segment(mode, "road", route.coords, steps=steps if turns else [], distance_m=route.distance_m, duration_s=route.duration_s)]


def _link(d: Drawing, a: LngLat, b: LngLat, mode: str) -> list[dict]:
    """Getting to or from a station or stand: a walk when it's close, the leg's own ride when it says so."""
    if mode == "walk" and metres(a, b) > WALK_M:
        return [_approximate("walk", a, b)]
    return _road(d, a, b, mode)


def _nearest(points: list[LngLat], to: LngLat) -> int:
    return min(range(len(points)), key=lambda i: metres(points[i], to))


def _modes(leg: dict, main: str) -> tuple[list[str], int, int]:
    """The leg's modes, where its main ride is among them, and that ride's planned minutes."""
    modes = [s["mode"] for s in leg.get("segments", [])] or [main]
    k = modes.index(main) if main in modes else 0
    minutes = leg["segments"][k]["minutes"] if leg.get("segments") else leg.get("travelMin", 0)
    return modes, k, minutes


def _metro(d: Drawing, leg: dict, a: LngLat, b: LngLat, line: MetroLine) -> list[dict] | None:
    points = [(s.lng, s.lat) for s in line.stations]
    i, j = _nearest(points, a), _nearest(points, b)
    if i == j:
        return None
    ride = list(line.stations[i : j + 1]) if i < j else list(reversed(line.stations[j : i + 1]))
    towards = line.stations[-1] if i < j else line.stations[0]
    board, alight = ride[0], ride[-1]
    modes, k, minutes = _modes(leg, "metro")
    coords = [(s.lng, s.lat) for s in ride]
    length = sum(metres(coords[n], coords[n + 1]) for n in range(len(coords) - 1))
    rail = _segment(
        "metro",
        "rail",
        coords,
        steps=[
            {
                "kind": "board",
                "name": board.name,
                "line": line.name,
                "towards": towards.name,
                "stops": len(ride) - 1,
                "at": 0,
                "distanceM": round(length),
                "durationS": minutes * 60,
            },
            {"kind": "alight", "name": alight.name, "at": len(coords) - 1, "distanceM": 0, "durationS": 0},
        ],
        stops=[{"name": s.name, "lng": s.lng, "lat": s.lat} for s in ride],
        line={"name": line.name, "colour": line.colour},
        distance_m=length,
        duration_s=minutes * 60,
    )
    before = modes[k - 1] if k > 0 else "walk"
    after = modes[k + 1] if k + 1 < len(modes) else "walk"
    return [*_link(d, a, coords[0], before), rail, *_link(d, coords[-1], b, after)]


def _between(path: list[LngLat], p: LngLat, q: LngLat) -> list[LngLat]:
    i, j = _nearest(path, p), _nearest(path, q)
    return path[i : j + 1] if i <= j else list(reversed(path[j : i + 1]))


def _raasta(d: Drawing, leg: dict, a: LngLat, b: LngLat, shape: RouteShape) -> list[dict] | None:
    stands = [(lng, lat) for _name, lng, lat in shape.stands]
    if len(stands) < 2:
        return None
    i, j = _nearest(stands, a), _nearest(stands, b)
    if i == j:
        return None
    passed = list(shape.stands[i : j + 1]) if i < j else list(reversed(shape.stands[j : i + 1]))
    vehicle = next((m for m in (s["mode"] for s in leg.get("segments", [])) if m != "walk"), leg["mode"])
    _modes_, _k, minutes = _modes(leg, vehicle)
    board, alight = (passed[0][1], passed[0][2]), (passed[-1][1], passed[-1][2])
    # Along its recorded path where it has one, else along the roads through its stands; straight between
    # the stands when neither is known.
    recorded = _between(list(shape.path), board, alight) if len(shape.path) >= 2 else []
    if len(recorded) >= 2:
        coords, source = recorded, "recorded"
    else:
        route = d.route([(lng, lat) for _n, lng, lat in passed], "car")
        coords, source = (route.coords, "road") if route and len(route.coords) > 1 else ([(lng, lat) for _n, lng, lat in passed], "approximate")
    ride = _segment(
        vehicle,
        source,
        coords,
        steps=[
            {
                "kind": "board",
                "name": passed[0][0],
                "line": None,
                "towards": passed[-1][0],
                "stops": len(passed) - 1,
                "at": 0,
                "distanceM": 0,
                "durationS": minutes * 60,
            },
            {"kind": "alight", "name": passed[-1][0], "at": len(coords) - 1, "distanceM": 0, "durationS": 0},
        ],
        stops=[{"name": n, "lng": lng, "lat": lat} for n, lng, lat in passed],
        duration_s=minutes * 60,
    )
    return [*_link(d, a, board, "walk"), ride, *_link(d, alight, b, "walk")]


def draw_leg(d: Drawing, leg: dict, places: dict[str, LngLat]) -> dict:
    a, b = places.get(leg["fromPlaceId"]), places.get(leg["toPlaceId"])
    d.later = False
    if a is None or b is None:
        return {"seq": leg["seq"], "segments": [], "complete": True}
    ref = leg.get("transitRef") or {}
    segments: list[dict] | None = None
    if ref.get("kind") == "metro" and ref.get("refId") in d.lines:
        segments = _metro(d, leg, a, b, d.lines[ref["refId"]])
    elif ref.get("kind") == "raasta" and (shape := d.shape(ref.get("refId", ""))):
        segments = _raasta(d, leg, a, b, shape)
    if segments is None:
        # A metro without its stations known, or any other ride: along the roads (a cab's turns help the
        # traveller follow along), or straight for the metro.
        segments = [_approximate("metro", a, b)] if leg["mode"] == "metro" else _road(d, a, b, leg["mode"])
    return {"seq": leg["seq"], "segments": segments, "complete": not d.later}


def warm(plan_id: str, version: int | None, trip_id: str, legs: list[dict], places: dict[str, LngLat], d: Drawing) -> dict:
    """Draw what isn't drawn yet, upcoming legs first, within this run's routing calls; keep it; say so."""
    stored = load(plan_id) or {"planId": plan_id, "version": version, "complete": False, "legs": []}
    drawn = {leg["seq"]: leg for leg in stored["legs"] if leg.get("complete")}
    out = []
    for leg in legs:
        if leg["seq"] in drawn:
            out.append(drawn[leg["seq"]])
        elif d.router.calls < BUDGET:
            out.append(draw_leg(d, leg, places))
    complete = len(out) == len(legs) and all(leg["complete"] for leg in out)
    result = {"planId": plan_id, "version": version, "complete": complete, "legs": sorted(out, key=lambda leg: leg["seq"])}
    r = get_redis()
    r.set(_key(plan_id), json.dumps(result), ex=STORE_SECONDS)
    r.delete(f"{_key(plan_id)}:warming")
    events.publish(trip_id, "paths_ready", {"planId": plan_id, "version": version, "complete": complete})
    # Out of calls for this run, not out of luck: carry on. (A busy server waits for the next look at the map.)
    if not complete and d.router.calls >= BUDGET:
        start(plan_id)
    return {"planId": plan_id, "complete": complete, "legs": len(out)}
