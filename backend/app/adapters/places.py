"""Place and city search: the places we already know first, then Nominatim (cached, at most 1 request
a second).

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


@dataclass(frozen=True)
class FoundCity:
    name: str
    state: str | None
    lng: float
    lat: float
    #: west, south, east, north, as OpenStreetMap outlines the city
    bbox: tuple[float, float, float, float]
    osm_id: str | None


#: What counts as a city to plan in, biggest first. Wards and districts share town names, so they don't.
SETTLEMENTS = ("city", "town", "municipality", "village")


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
        # With the city's name first; a place whose address doesn't name the city (a campus outside
        # town, like Chitkara University near Rajpura) is found by its own name inside the city's area.
        for q in (f"{query.strip()}, {where.name}", query.strip()):
            found = self._search(q, where)
            if found:
                return found
        return []

    def _search(self, q: str, where: City) -> list[FoundPlace]:
        city_name = where.name
        cache_key = f"nominatim:q:{q.lower()}@{where.slug}"
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

    def settlements(self, query: str) -> list[FoundCity]:
        """Cities, towns and villages in India by name: cities first, then towns, the better known first."""
        cache_key = "nominatim:city:" + query.strip().lower()
        cached = self.redis.get(cache_key)
        if cached is not None:
            return [FoundCity(**{**x, "bbox": tuple(x["bbox"])}) for x in json.loads(cached)]
        if not self._throttle():
            return []
        try:
            params = {"q": query.strip(), "format": "jsonv2", "addressdetails": 1, "limit": 40, "countrycodes": "in", "featureType": "settlement"}
            res = self.client.get(f"{self.base}/search", params=params)
            res.raise_for_status()
        except httpx.HTTPError:
            return []
        ranked = []
        for item in res.json():
            kind = item.get("addresstype")
            if kind not in SETTLEMENTS:
                continue
            south, north, west, east = (float(x) for x in item["boundingbox"])
            addr = item.get("address", {})
            name = item.get("name") or item.get("display_name", "").split(",")[0]
            osm = f"{item.get('osm_type', 'x')[:1]}{item.get('osm_id')}"
            city = FoundCity(name=name, state=addr.get("state"), lng=float(item["lon"]), lat=float(item["lat"]), bbox=(west, south, east, north), osm_id=osm)
            ranked.append((SETTLEMENTS.index(kind), -float(item.get("importance") or 0), city))
        found: list[FoundCity] = []
        for _, _, city in sorted(ranked, key=lambda r: (r[0], r[1])):
            if all((c.name, c.state) != (city.name, city.state) for c in found):
                found.append(city)
        found = found[:8]
        self.redis.set(cache_key, json.dumps([f.__dict__ for f in found]), ex=7 * 24 * 3600)
        return found
