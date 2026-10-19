"""Place search: the places we already know first, then Nominatim (cached, at most 1 request a second).

Nominatim's usage policy asks for a real User-Agent, caching and no more than one request a second.
"""

from __future__ import annotations

import json
import time
from dataclasses import dataclass
from typing import Protocol

import httpx

from app.cities import City
from app.config import get_settings


@dataclass(frozen=True)
class FoundPlace:
    place_id: str
    name: str
    area: str
    lng: float
    lat: float
    osm_id: str | None


class PlaceSearch(Protocol):
    def search(self, query: str, where: City) -> list[FoundPlace]: ...


class NominatimSearch:
    def __init__(self, redis_client, client: httpx.Client | None = None):
        s = get_settings()
        self.redis = redis_client
        self.base = s.nominatim_url.rstrip("/")
        self.client = client or httpx.Client(timeout=6.0, headers={"User-Agent": s.nominatim_user_agent})

    def _throttle(self) -> bool:
        """One request a second across every API copy: a Redis lock that expires after a second.

        Returns False when no slot came free within 3 s; the caller then skips Nominatim.
        """
        for _ in range(30):
            if self.redis.set("nominatim:throttle", "1", nx=True, px=1000):
                return True
            time.sleep(0.1)
        return False

    def search(self, query: str, where: City) -> list[FoundPlace]:
        city_name = where.name
        q = f"{query.strip()}, {city_name}"
        cache_key = "nominatim:q:" + q.lower()
        cached = self.redis.get(cache_key)
        if cached is not None:
            return [FoundPlace(**x) for x in json.loads(cached)]
        if not self._throttle():
            return []
        try:
            west, south, east, north = where.bbox
            params = {
                "q": q,
                "format": "jsonv2",
                "addressdetails": 1,
                "limit": 5,
                "countrycodes": "in",
                "viewbox": f"{west},{north},{east},{south}",
                "bounded": 1,
            }
            res = self.client.get(f"{self.base}/search", params=params)
            res.raise_for_status()
        except httpx.HTTPError:
            return []
        found = []
        for item in res.json():
            addr = item.get("address", {})
            area = addr.get("suburb") or addr.get("neighbourhood") or addr.get("city_district") or addr.get("city") or city_name
            name = item.get("name") or item.get("display_name", "").split(",")[0]
            osm = f"{item.get('osm_type', 'x')[:1]}{item.get('osm_id')}"
            found.append(FoundPlace(place_id=f"osm-{osm}", name=name, area=area, lng=float(item["lon"]), lat=float(item["lat"]), osm_id=osm))
        self.redis.set(cache_key, json.dumps([f.__dict__ for f in found]), ex=24 * 3600)
        return found
