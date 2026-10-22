"""Distances and GPS ride cleaning. Pure functions: no database, network or clock."""

from __future__ import annotations

import math
from collections.abc import Sequence
from dataclasses import dataclass
from datetime import datetime

EARTH_RADIUS_M = 6_371_000.0


@dataclass(frozen=True, slots=True)
class LatLng:
    lat: float
    lng: float


@dataclass(frozen=True, slots=True)
class RidePoint:
    lat: float
    lng: float
    t: datetime


def distance_m(a: LatLng | RidePoint, b: LatLng | RidePoint) -> float:
    """Great-circle distance in metres."""
    p1, p2 = math.radians(a.lat), math.radians(b.lat)
    dp = p2 - p1
    dl = math.radians(b.lng - a.lng)
    h = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * EARTH_RADIUS_M * math.asin(math.sqrt(min(1.0, h)))


def path_length_m(points: Sequence[LatLng | RidePoint]) -> float:
    return sum(distance_m(points[i - 1], points[i]) for i in range(1, len(points)))


def trim_ride(points: Sequence[RidePoint], trim_m: float = 200.0) -> list[RidePoint]:
    """Drop every point within the first and last `trim_m` metres of the ride.

    Those ends usually reveal where the rider lives or works, so they are never stored.
    A ride shorter than twice `trim_m` leaves nothing.
    """
    pts = sorted(points, key=lambda p: p.t)
    if len(pts) < 2:
        return []
    cumulative = [0.0]
    for i in range(1, len(pts)):
        cumulative.append(cumulative[-1] + distance_m(pts[i - 1], pts[i]))
    total = cumulative[-1]
    if total <= 2 * trim_m:
        return []
    return [p for p, d in zip(pts, cumulative, strict=True) if trim_m < d < total - trim_m]


def downsample(points: Sequence[RidePoint], max_points: int = 2000) -> list[RidePoint]:
    """At most `max_points` points spread evenly over the ride's duration, keeping the first and last."""
    pts = sorted(points, key=lambda p: p.t)
    if len(pts) <= max_points:
        return pts
    start = pts[0].t
    slot_s = (pts[-1].t - start).total_seconds() / (max_points - 1)
    if slot_s <= 0:
        return [*pts[: max_points - 1], pts[-1]]
    kept = [pts[0]]
    next_at = slot_s
    for p in pts[1:-1]:
        if len(kept) == max_points - 1:
            break
        offset = (p.t - start).total_seconds()
        if offset >= next_at:
            kept.append(p)
            next_at = (offset // slot_s + 1) * slot_s
    kept.append(pts[-1])
    return kept


def suggest_stops(points: Sequence[RidePoint], still_radius_m: float = 15.0, min_still_s: float = 30.0) -> list[LatLng]:
    """Places where the vehicle stood still for at least `min_still_s`: likely stands.

    Linear time. When points stay together for less than `min_still_s`, the scan resumes from
    the last point of that run rather than the next point, so the answer is slightly approximate:
    a stop that starts part-way through a short run is measured from the run's last point.
    """
    pts = sorted(points, key=lambda p: p.t)
    stops: list[LatLng] = []
    i = 0
    while i < len(pts):
        j = i
        while j + 1 < len(pts) and distance_m(pts[i], pts[j + 1]) <= still_radius_m:
            j += 1
        if j > i and (pts[j].t - pts[i].t).total_seconds() >= min_still_s:
            cluster = pts[i : j + 1]
            stops.append(LatLng(lat=sum(p.lat for p in cluster) / len(cluster), lng=sum(p.lng for p in cluster) / len(cluster)))
            i = j + 1
        elif j > i:
            i = j
        else:
            i += 1
    return stops
