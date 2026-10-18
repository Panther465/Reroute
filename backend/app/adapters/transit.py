"""The transit adapter: the only part of Reroute that asks Raasta about routes, over HTTP.

Reroute never reads Raasta's tables. If Raasta is unreachable, its routes are treated as unverified,
so they can't become a main option, and the plan still works with metro, walking and cabs.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from typing import Protocol

import httpx

from app.config import get_settings

log = logging.getLogger("reroute.transit")


@dataclass(frozen=True)
class RouteInfo:
    route_id: str
    status: str
    first_trip: str
    last_trip: str
    fare_inr: int
    frequency_min: int


class TransitAdapter(Protocol):
    def routes(self, route_ids: list[str]) -> dict[str, RouteInfo]: ...


class RaastaHttpAdapter:
    def __init__(self, base_url: str | None = None, client: httpx.Client | None = None, timeout: float = 3.0):
        self.base_url = (base_url or get_settings().raasta_base_url).rstrip("/")
        self.client = client or httpx.Client(timeout=timeout)

    def routes(self, route_ids: list[str]) -> dict[str, RouteInfo]:
        found: dict[str, RouteInfo] = {}
        for route_id in sorted(set(route_ids)):
            try:
                res = self.client.get(f"{self.base_url}/v1/raasta/routes/{route_id}")
            except httpx.HTTPError as exc:
                log.warning("Raasta unreachable for %s: %s", route_id, exc)
                continue
            if res.status_code != 200:
                continue
            data = res.json()
            found[route_id] = RouteInfo(
                route_id=route_id,
                status=data.get("status", "unverified"),
                first_trip=data.get("firstTrip", "00:00"),
                last_trip=data.get("lastTrip", "00:00"),
                fare_inr=int(data.get("fareInr", 0)),
                frequency_min=int(data.get("frequencyMin", 0)),
            )
        return found


class StaticTransitAdapter:
    """For tests and offline runs: a fixed answer."""

    def __init__(self, routes: dict[str, RouteInfo]):
        self._routes = routes

    def routes(self, route_ids: list[str]) -> dict[str, RouteInfo]:
        return {r: self._routes[r] for r in route_ids if r in self._routes}
