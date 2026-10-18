"""When two contributions describe the same route (project brief, section 12).

Two routes count as the same when they have the same vehicle type and the same stands in the
same order, with each stand within 150 m of its partner.
"""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass

from app.services.geo import LatLng, distance_m

MATCH_RADIUS_M = 150.0


@dataclass(frozen=True, slots=True)
class RouteShape:
    vehicle_type: str
    stands: tuple[LatLng, ...]


def same_route(a: RouteShape, b: RouteShape, radius_m: float = MATCH_RADIUS_M) -> bool:
    if a.vehicle_type != b.vehicle_type or len(a.stands) != len(b.stands) or len(a.stands) < 2:
        return False
    return all(distance_m(x, y) <= radius_m for x, y in zip(a.stands, b.stands, strict=True))


def find_match(candidate: RouteShape, others: Sequence[tuple[str, RouteShape]]) -> str | None:
    """The ID of the first route in `others` that matches, in the order given."""
    for route_id, shape in others:
        if same_route(candidate, shape):
            return route_id
    return None
