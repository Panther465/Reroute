"""OSRM behind a small interface: draw a road path between stands, or snap a GPS ride to roads.

Every call may fail (no OSRM configured, timeout, no match). Callers then fall back to the
straight lines between points, so contributions never depend on routing being up.
"""

from __future__ import annotations

import logging
from collections.abc import Sequence
from typing import Protocol

import httpx

from app.config import get_settings
from app.services.geo import LatLng, RidePoint

log = logging.getLogger("raasta")


class Router(Protocol):
    def route(self, stops: Sequence[LatLng]) -> list[LatLng] | None: ...

    def match(self, points: Sequence[RidePoint]) -> list[LatLng] | None: ...


class OsrmRouter:
    def __init__(self, base_url: str | None, profile: str = "driving", timeout_s: float = 4.0) -> None:
        self.base_url = base_url.rstrip("/") if base_url else None
        self.profile = profile
        self.timeout_s = timeout_s

    def _get(self, service: str, coords: str, params: dict[str, str]) -> dict | None:
        if not self.base_url:
            return None
        url = f"{self.base_url}/{service}/v1/{self.profile}/{coords}"
        try:
            response = httpx.get(url, params=params, timeout=self.timeout_s)
            response.raise_for_status()
            data = response.json()
        except (httpx.HTTPError, ValueError) as exc:
            log.warning("osrm %s failed: %s", service, exc)
            return None
        return data if data.get("code") == "Ok" else None

    def route(self, stops: Sequence[LatLng]) -> list[LatLng] | None:
        if len(stops) < 2:
            return None
        coords = ";".join(f"{p.lng:.6f},{p.lat:.6f}" for p in stops)
        data = self._get("route", coords, {"overview": "full", "geometries": "geojson"})
        if not data or not data.get("routes"):
            return None
        return [LatLng(lat=lat, lng=lng) for lng, lat in data["routes"][0]["geometry"]["coordinates"]]

    def match(self, points: Sequence[RidePoint]) -> list[LatLng] | None:
        if len(points) < 2:
            return None
        # OSRM's match service takes at most 100 points by default; sample evenly.
        step = max(1, len(points) // 100)
        sample = list(points[::step])[:100]
        coords = ";".join(f"{p.lng:.6f},{p.lat:.6f}" for p in sample)
        stamps = ";".join(str(int(p.t.timestamp())) for p in sample)
        data = self._get("match", coords, {"overview": "full", "geometries": "geojson", "timestamps": stamps, "tidy": "true"})
        if not data or not data.get("matchings"):
            return None
        out: list[LatLng] = []
        for matching in data["matchings"]:
            out.extend(LatLng(lat=lat, lng=lng) for lng, lat in matching["geometry"]["coordinates"])
        return out


def get_router() -> Router:
    s = get_settings()
    return OsrmRouter(s.osrm_url, s.osrm_profile, s.osrm_timeout_s)
