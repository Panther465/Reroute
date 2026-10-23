"""The transit adapter: the only part of Reroute that asks Raasta about routes, over HTTP.

Reroute never reads Raasta's tables. Answers are cached in Redis for a few minutes, so the worker
asks about each route or place pair once per window rather than once per trip. Calls carry the
service token (X-Service-Token), which gives the worker Raasta's service rate limit.

Only a 404 means Raasta doesn't know a route: it is then unverified, a labelled extra at most. A
busy or failing Raasta (429, 5xx, no answer) says nothing about a route, so the last good answer
(kept 24 hours) is used instead, and Raasta isn't asked again until its Retry-After has passed.
With no good answer at all, its routes are unverified and the plan works with metro, walking and cabs.
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
#: The last good answer, used while Raasta is busy or down.
LAST_GOOD_SECONDS = 24 * 3600
#: While this key exists, Raasta isn't asked (it said Retry-After, or didn't answer).
BACKOFF_KEY = "raasta:backoff"
BACKOFF_DEFAULT_SECONDS = 30
BACKOFF_MAX_SECONDS = 600
#: Shared autos, e-rickshaws and tempos in city traffic: about 15 km/h, stops included (sample estimate).
RIDE_M_PER_MIN = 250


class _Unavailable(Exception):
    """Raasta is busy, failing or unreachable: nothing was learnt about the route."""


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


@dataclass(frozen=True)
class RouteShape:
    """Where a route runs, for drawing a ride: its stands in order (name, lng, lat) and its recorded GPS path."""

    vehicle_type: str
    stands: list[tuple[str, float, float]]
    path: list[tuple[float, float]]


class TransitAdapter(Protocol):
    def routes(self, route_ids: list[str]) -> dict[str, RouteInfo]: ...

    def leg_options(self, a: PlacePoint, b: PlacePoint, day: date, utc_offset: str) -> list[RaastaLeg]: ...

    def route_shape(self, route_id: str) -> RouteShape | None: ...


class RaastaHttpAdapter:
    def __init__(
        self, base_url: str | None = None, client: httpx.Client | None = None, timeout: float = 3.0, redis_client=None, service_token: str | None = None
    ):
        s = get_settings()
        self.base_url = (base_url or s.raasta_base_url).rstrip("/")
        token = s.raasta_service_token if service_token is None else service_token
        self.client = client or httpx.Client(timeout=timeout)
        self.headers = {"X-Service-Token": token} if token else {}
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
        """A fresh answer: cached for a few minutes, and kept for a day as the last good one."""
        if self.redis is None:
            return
        with contextlib.suppress(Exception):
            raw = json.dumps(value)
            self.redis.set(key, raw, ex=CACHE_SECONDS)
            self.redis.set(key + ":good", raw, ex=LAST_GOOD_SECONDS)

    def _forget(self, key: str) -> None:
        if self.redis is not None:
            with contextlib.suppress(Exception):
                self.redis.delete(key, key + ":good")

    def _backing_off(self) -> bool:
        if self.redis is None:
            return False
        try:
            return bool(self.redis.exists(BACKOFF_KEY))
        except Exception:
            return False

    def _back_off(self, retry_after: str | None) -> None:
        seconds = int(retry_after) if retry_after and retry_after.isdigit() else BACKOFF_DEFAULT_SECONDS
        if self.redis is not None:
            with contextlib.suppress(Exception):
                self.redis.set(BACKOFF_KEY, "1", ex=max(1, min(seconds, BACKOFF_MAX_SECONDS)))

    def _get(self, path: str, params: dict | None = None) -> httpx.Response | None:
        """The response, or None for a 404. Raises _Unavailable when Raasta is busy, failing or unreachable."""
        if self._backing_off():
            raise _Unavailable("backing off")
        try:
            res = self.client.get(f"{self.base_url}{path}", params=params, headers=self.headers)
        except httpx.HTTPError as exc:
            log.warning("Raasta unreachable: %s", exc)
            self._back_off(None)
            raise _Unavailable(str(exc)) from exc
        if res.status_code == 404:
            return None
        if res.status_code == 429 or res.status_code >= 500:
            log.warning("Raasta answered %s; using the last good answers", res.status_code)
            self._back_off(res.headers.get("retry-after"))
            raise _Unavailable(str(res.status_code))
        if res.status_code != 200:
            log.warning("Raasta answered %s", res.status_code)
            raise _Unavailable(str(res.status_code))
        return res

    def routes(self, route_ids: list[str]) -> dict[str, RouteInfo]:
        found: dict[str, RouteInfo] = {}
        for route_id in sorted(set(route_ids)):
            key = f"raasta:route:{route_id}"
            cached = self._cached(key)
            if cached is not None:
                found[route_id] = RouteInfo(**cached)
                continue
            try:
                res = self._get(f"/v1/raasta/routes/{route_id}")
            except _Unavailable:
                good = self._cached(key + ":good")
                if good is not None:
                    found[route_id] = RouteInfo(**good)
                continue
            if res is None:
                # Raasta doesn't know this route (any more): unverified.
                self._forget(key)
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
            res = self._get("/v1/raasta/routes", params={"from": f"{a.lng},{a.lat}", "to": f"{b.lng},{b.lat}", "at": at})
        except _Unavailable:
            good = self._cached(key + ":good")
            return [RaastaLeg(**x) for x in good] if good is not None else []
        if res is None:
            self._forget(key)
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

    def route_shape(self, route_id: str) -> RouteShape | None:
        """A route's stands and recorded path; None when Raasta doesn't know it or can't answer (it's then drawn
        along the roads, or marked approximate)."""
        key = f"raasta:shape:{route_id}"
        cached = self._cached(key)
        if cached is None:
            try:
                res = self._get(f"/v1/raasta/routes/{route_id}")
            except _Unavailable:
                cached = self._cached(key + ":good")
                return RouteShape(**cached) if cached else None
            if res is None:
                return None
            data = res.json()
            stands = sorted(data.get("stands", []), key=lambda x: x.get("seq", 0))
            path = [(x["lng"], x["lat"]) for x in data.get("path", [])]
            # A route nobody has recorded comes with its stands as its path: that's not a path to draw.
            if path == [(x["location"]["lng"], x["location"]["lat"]) for x in stands]:
                path = []
            shape = RouteShape(
                vehicle_type=data.get("vehicleType", "shared_auto"),
                stands=[(x["name"], x["location"]["lng"], x["location"]["lat"]) for x in stands],
                path=path,
            )
            self._store(key, asdict(shape))
            return shape
        return RouteShape(cached["vehicle_type"], [tuple(x) for x in cached["stands"]], [tuple(x) for x in cached["path"]])  # type: ignore[misc]


class StaticTransitAdapter:
    """For tests and offline runs: a fixed answer."""

    def __init__(self, routes: dict[str, RouteInfo], legs: dict[tuple[str, str], list[RaastaLeg]] | None = None, shapes: dict[str, RouteShape] | None = None):
        self._routes = routes
        self._legs = legs or {}
        self._shapes = shapes or {}

    def routes(self, route_ids: list[str]) -> dict[str, RouteInfo]:
        return {r: self._routes[r] for r in route_ids if r in self._routes}

    def leg_options(self, a: PlacePoint, b: PlacePoint, day: date, utc_offset: str) -> list[RaastaLeg]:
        return list(self._legs.get((a.place_id, b.place_id), []))

    def route_shape(self, route_id: str) -> RouteShape | None:
        return self._shapes.get(route_id)
