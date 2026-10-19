"""The transit adapter: the only part of Reroute that asks Raasta about routes, over HTTP.

Reroute never reads Raasta's tables. Answers are cached in Redis for a few minutes, so the worker
asks about each route or place pair once per window rather than once per trip. If Raasta is
unreachable, its routes are treated as unverified: they can only be labelled extras, and the plan
still works with metro, walking and cabs.
"""

from __future__ import annotations

import contextlib
import json
import logging
import math
from dataclasses import asdict, dataclass
from datetime import date, datetime, time, timedelta, timezone
from typing import TYPE_CHECKING, Protocol

import httpx

from app.config import get_settings

if TYPE_CHECKING:
    from app.adapters.travel_times import PlacePoint

log = logging.getLogger("reroute.transit")

CACHE_SECONDS = 5 * 60
#: Shared autos, e-rickshaws and tempos in city traffic: about 15 km/h, stops included (sample estimate).
RIDE_M_PER_MIN = 250


@dataclass(frozen=True)
class RouteInfo:
    route_id: str
    status: str
    first_trip: str
    last_trip: str
    fare_inr: int
    frequency_min: int


@dataclass(frozen=True)
class RaastaLeg:
    """One Raasta route serving a pair of places, with the walking at each end."""

    route_id: str
    vehicle_type: str
    status: str
    fare_inr: int
    first_trip: str
    last_trip: str
    walk_from_min: int
    walk_to_min: int
    wait_min: int
    ride_min: int

    @property
    def travel_min(self) -> int:
        return self.walk_from_min + self.wait_min + self.ride_min + self.walk_to_min


class TransitAdapter(Protocol):
    def routes(self, route_ids: list[str]) -> dict[str, RouteInfo]: ...

    def leg_options(self, a: PlacePoint, b: PlacePoint, day: date, utc_offset: str) -> list[RaastaLeg]: ...


class RaastaHttpAdapter:
    def __init__(self, base_url: str | None = None, client: httpx.Client | None = None, timeout: float = 3.0, redis_client=None):
        self.base_url = (base_url or get_settings().raasta_base_url).rstrip("/")
        self.client = client or httpx.Client(timeout=timeout)
        self.redis = redis_client

    def _cached(self, key: str):
        if self.redis is None:
            return None
        try:
            raw = self.redis.get(key)
        except Exception:
            return None
        return json.loads(raw) if raw else None

    def _store(self, key: str, value) -> None:
        if self.redis is None:
            return
        with contextlib.suppress(Exception):
            self.redis.set(key, json.dumps(value), ex=CACHE_SECONDS)

    def routes(self, route_ids: list[str]) -> dict[str, RouteInfo]:
        found: dict[str, RouteInfo] = {}
        for route_id in sorted(set(route_ids)):
            key = f"raasta:route:{route_id}"
            cached = self._cached(key)
            if cached is not None:
                found[route_id] = RouteInfo(**cached)
                continue
            try:
                res = self.client.get(f"{self.base_url}/v1/raasta/routes/{route_id}")
            except httpx.HTTPError as exc:
                log.warning("Raasta unreachable for %s: %s", route_id, exc)
                continue
            if res.status_code != 200:
                continue
            data = res.json()
            info = RouteInfo(
                route_id=route_id,
                status=data.get("status", "unverified"),
                first_trip=data.get("firstTrip", "00:00"),
                last_trip=data.get("lastTrip", "00:00"),
                fare_inr=int(data.get("fareInr", 0)),
                frequency_min=int(data.get("frequencyMin", 0)),
            )
            self._store(key, asdict(info))
            found[route_id] = info
        return found

    def leg_options(self, a: PlacePoint, b: PlacePoint, day: date, utc_offset: str) -> list[RaastaLeg]:
        key = f"raasta:legs:{a.lng:.5f},{a.lat:.5f}>{b.lng:.5f},{b.lat:.5f}"
        cached = self._cached(key)
        if cached is not None:
            return [RaastaLeg(**x) for x in cached]
        # Ask about the start of the day: routes whose last trip is later are all listed with their
        # hours, and the planner itself decides whether each one is still running at departure.
        sign = -1 if utc_offset.startswith("-") else 1
        hours, minutes = utc_offset.lstrip("+-").split(":")
        tz = timezone(sign * timedelta(hours=int(hours), minutes=int(minutes)))
        at = datetime.combine(day, time(0, 5), tz).isoformat()
        try:
            res = self.client.get(f"{self.base_url}/v1/raasta/routes", params={"from": f"{a.lng},{a.lat}", "to": f"{b.lng},{b.lat}", "at": at})
        except httpx.HTTPError as exc:
            log.warning("Raasta unreachable for leg options: %s", exc)
            return []
        if res.status_code != 200:
            return []
        body = res.json()
        legs = [
            RaastaLeg(
                route_id=item["routeId"],
                vehicle_type=item["vehicleType"],
                status=item.get("status", "unverified"),
                fare_inr=int(item["fareInr"]),
                first_trip=item["firstTrip"],
                last_trip=item["lastTrip"],
                walk_from_min=int(item["walkFromMin"]),
                walk_to_min=int(item["walkToMin"]),
                wait_min=int(item["expectedWaitMin"]),
                ride_min=max(1, math.ceil(float(item["rideDistanceM"]) / RIDE_M_PER_MIN)),
            )
            for item in [*body.get("items", []), *body.get("extras", [])]
        ]
        self._store(key, [asdict(x) for x in legs])
        return legs


class StaticTransitAdapter:
    """For tests and offline runs: a fixed answer."""

    def __init__(self, routes: dict[str, RouteInfo], legs: dict[tuple[str, str], list[RaastaLeg]] | None = None):
        self._routes = routes
        self._legs = legs or {}

    def routes(self, route_ids: list[str]) -> dict[str, RouteInfo]:
        return {r: self._routes[r] for r in route_ids if r in self._routes}

    def leg_options(self, a: PlacePoint, b: PlacePoint, day: date, utc_offset: str) -> list[RaastaLeg]:
        return list(self._legs.get((a.place_id, b.place_id), []))
