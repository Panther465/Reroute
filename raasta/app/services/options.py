"""Which Raasta routes can carry a traveller between two points at a given time.

Only verified, current routes are main options. Unverified or stale routes appear only as
labelled extras. No route is offered once its last trip has gone; those are listed so the
planner can say why (LAST_TRIP_PASSED).
"""

from __future__ import annotations

import math
from collections.abc import Sequence
from dataclasses import dataclass

from app.services.geo import LatLng, distance_m


@dataclass(frozen=True, slots=True)
class StandOnRoute:
    stand_id: str
    name: str
    seq: int
    location: LatLng


@dataclass(frozen=True, slots=True)
class RouteCandidate:
    route_id: str
    status: str
    vehicle_type: str
    fare_inr: int
    frequency_min: int
    first_trip_min: int
    last_trip_min: int
    stands: tuple[StandOnRoute, ...]


@dataclass(frozen=True, slots=True)
class LegMatch:
    route: RouteCandidate
    board: StandOnRoute
    alight: StandOnRoute
    walk_from_m: float
    walk_to_m: float
    walk_from_min: int
    walk_to_min: int
    ride_distance_m: float
    stops_between: int
    expected_wait_min: int


@dataclass(frozen=True, slots=True)
class LegOptions:
    main: tuple[LegMatch, ...]
    extras: tuple[LegMatch, ...]
    last_trip_passed: tuple[str, ...]


def best_stand_pair(route: RouteCandidate, origin: LatLng, dest: LatLng, radius_m: float, walk_m_per_min: float) -> LegMatch | None:
    """The boarding and alighting stands with the least walking, boarding before alighting."""
    best: LegMatch | None = None
    best_walk = math.inf
    stands = sorted(route.stands, key=lambda s: s.seq)
    for i, board in enumerate(stands):
        walk_from = distance_m(origin, board.location)
        if walk_from > radius_m:
            continue
        for j in range(i + 1, len(stands)):
            alight = stands[j]
            walk_to = distance_m(alight.location, dest)
            if walk_to > radius_m or walk_from + walk_to >= best_walk:
                continue
            best_walk = walk_from + walk_to
            ride = sum(distance_m(stands[k].location, stands[k + 1].location) for k in range(i, j))
            best = LegMatch(
                route=route,
                board=board,
                alight=alight,
                walk_from_m=round(walk_from, 1),
                walk_to_m=round(walk_to, 1),
                walk_from_min=math.ceil(walk_from / walk_m_per_min),
                walk_to_min=math.ceil(walk_to / walk_m_per_min),
                ride_distance_m=round(ride, 1),
                stops_between=j - i,
                expected_wait_min=math.ceil(route.frequency_min / 2),
            )
    return best


def select_options(
    candidates: Sequence[RouteCandidate], origin: LatLng, dest: LatLng, at_min: int, radius_m: float = 800, walk_m_per_min: float = 80
) -> LegOptions:
    main: list[LegMatch] = []
    extras: list[LegMatch] = []
    passed: list[str] = []
    for route in candidates:
        match = best_stand_pair(route, origin, dest, radius_m, walk_m_per_min)
        if match is None:
            continue
        boarding = at_min + match.walk_from_min
        if boarding > route.last_trip_min:
            passed.append(route.route_id)
            continue
        (main if route.status == "verified" else extras).append(match)

    def order(m: LegMatch) -> tuple:
        return (m.walk_from_m + m.walk_to_m + m.ride_distance_m, m.route.fare_inr, m.route.route_id)

    return LegOptions(main=tuple(sorted(main, key=order)), extras=tuple(sorted(extras, key=order)), last_trip_passed=tuple(sorted(passed)))
