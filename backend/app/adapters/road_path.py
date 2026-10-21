"""Road paths for drawing legs on the map: OSRM's route geometry, cached for 30 days.

For the map only: the planner's times and fares come from the travel-time snapshot, not from here.
The public OSRM server asks for light use, so answers are cached and calls are throttled to one a
second across every API copy. When OSRM can't answer, the path is a straight line, marked as such.
"""

from __future__ import annotations

import json
import math
import time
from dataclasses import dataclass
from typing import Literal

import httpx

from app.config import get_settings

LngLat = tuple[float, float]
CACHE_SECONDS = 30 * 24 * 3600


@dataclass(frozen=True)
class RoadPath:
    coords: list[LngLat]
    distance_m: int
    duration_s: int
    source: Literal["road", "line"]


def _km(a: LngLat, b: LngLat) -> float:
    dlat, dlng = math.radians(b[1] - a[1]), math.radians(b[0] - a[0])
    h = math.sin(dlat / 2) ** 2 + math.cos(math.radians(a[1])) * math.cos(math.radians(b[1])) * math.sin(dlng / 2) ** 2
    return 2 * 6371.0 * math.asin(math.sqrt(h))


def straight(a: LngLat, b: LngLat) -> RoadPath:
    metres = _km(a, b) * 1000
    return RoadPath(coords=[a, b], distance_m=round(metres), duration_s=0, source="line")


class RoadPaths:
    def __init__(self, redis_client, client: httpx.Client | None = None):
        s = get_settings()
        self.redis = redis_client
        self.base = s.road_path_url.rstrip("/")
        self.client = client or httpx.Client(timeout=8.0, headers={"User-Agent": s.nominatim_user_agent})

    def _throttle(self) -> bool:
        for _ in range(30):
            if self.redis.set("roadpath:throttle", "1", nx=True, px=1000):
                return True
            time.sleep(0.1)
        return False

    def get(self, a: LngLat, b: LngLat, profile: Literal["driving", "foot"]) -> RoadPath:
        key = f"roadpath:{profile}:{a[0]:.5f},{a[1]:.5f};{b[0]:.5f},{b[1]:.5f}"
        cached = self.redis.get(key)
        if cached:
            data = json.loads(cached)
            return RoadPath(coords=[tuple(c) for c in data["coords"]], distance_m=data["distance_m"], duration_s=data["duration_s"], source="road")  # type: ignore[misc]
        if not self.base or not self._throttle():
            return straight(a, b)
        try:
            res = self.client.get(
                f"{self.base}/route/v1/{profile}/{a[0]:.6f},{a[1]:.6f};{b[0]:.6f},{b[1]:.6f}",
                params={"overview": "full", "geometries": "geojson"},
            )
            res.raise_for_status()
            route = res.json()["routes"][0]
        except (httpx.HTTPError, KeyError, IndexError, ValueError):
            return straight(a, b)
        coords = [(round(lng, 5), round(lat, 5)) for lng, lat in route["geometry"]["coordinates"]]
        path = RoadPath(coords=coords, distance_m=round(route["distance"]), duration_s=round(route["duration"]), source="road")
        self.redis.set(key, json.dumps({"coords": coords, "distance_m": path.distance_m, "duration_s": path.duration_s}), ex=CACHE_SECONDS)
        return path
