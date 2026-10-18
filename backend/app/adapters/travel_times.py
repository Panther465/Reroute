"""Travel-time snapshots for the planner. The worker fetches everything first; the planner never calls out.

Two implementations share one interface:
- SampleSnapshotAdapter reads examples/<city>/travel-times.json (the Bengaluru demo).
- OsrmSnapshotAdapter asks OSRM for road times (car and foot), prices cabs from the city fare table,
  adds metro options from the timetable file, and caches every pair in Redis for 24 hours.
Both enrich Raasta legs through the transit adapter, so a route's live status and first and last
trip decide whether it may be used.
"""

from __future__ import annotations

import hashlib
import json
import logging
import math
from dataclasses import dataclass
from datetime import date
from pathlib import Path
from typing import Protocol

import httpx

from app.adapters.metro import MetroTimetable
from app.adapters.snapshot_file import parse_snapshot
from app.adapters.transit import TransitAdapter
from app.config import get_settings
from app.services.planner import LegOption, Mode, PairOptions, Segment, TravelSnapshot

log = logging.getLogger("reroute.travel")

WALK_LIMIT_KM = 1.5


@dataclass(frozen=True)
class PlacePoint:
    place_id: str
    lng: float
    lat: float


class TravelTimeAdapter(Protocol):
    def snapshot(self, city_slug: str, places: list[PlacePoint], day: date) -> TravelSnapshot: ...


def _raasta_refs(data: dict) -> list[str]:
    return [o["transitRef"]["refId"] for p in data["pairs"] for o in p["options"] if (o.get("transitRef") or {}).get("kind") == "raasta"]


def _enrich(data: dict, transit: TransitAdapter) -> tuple[dict[str, str], dict[str, tuple[str, str]]]:
    refs = _raasta_refs(data)
    info = transit.routes(refs) if refs else {}
    # Anything Raasta didn't confirm is unverified: shown as an extra at most, never a main option.
    status = {r: (info[r].status if r in info else "unverified") for r in refs}
    service = {r: (info[r].first_trip, info[r].last_trip) for r in refs if r in info}
    return status, service


class SampleSnapshotAdapter:
    def __init__(self, transit: TransitAdapter, examples_dir: Path | None = None):
        self.transit = transit
        self.examples_dir = examples_dir or get_settings().examples_dir

    def snapshot(self, city_slug: str, places: list[PlacePoint], day: date) -> TravelSnapshot:
        path = self.examples_dir / city_slug / "travel-times.json"
        if not path.exists():
            return TravelSnapshot(snapshot_id=f"{city_slug}-empty", pairs=())
        data = json.loads(path.read_text(encoding="utf-8"))
        wanted = {p.place_id for p in places}
        data = {**data, "pairs": [p for p in data["pairs"] if p["from"] in wanted and p["to"] in wanted]}
        status, service = _enrich(data, self.transit)
        snap = parse_snapshot(data, raasta_status=status, raasta_service=service)
        # The snapshot ID changes when a route's status or hours change, so replays stay exact.
        suffix = hashlib.sha256(json.dumps([status, service], sort_keys=True).encode()).hexdigest()[:8]
        return snap.model_copy(update={"snapshot_id": f"{snap.snapshot_id}-{suffix}"})


def _km(a: PlacePoint, b: PlacePoint) -> float:
    r = 6371.0
    dlat = math.radians(b.lat - a.lat)
    dlng = math.radians(b.lng - a.lng)
    h = math.sin(dlat / 2) ** 2 + math.cos(math.radians(a.lat)) * math.cos(math.radians(b.lat)) * math.sin(dlng / 2) ** 2
    return 2 * r * math.asin(math.sqrt(h))


class OsrmSnapshotAdapter:
    def __init__(self, transit: TransitAdapter, redis_client=None, client: httpx.Client | None = None, examples_dir: Path | None = None):
        s = get_settings()
        self.transit = transit
        self.redis = redis_client
        self.client = client or httpx.Client(timeout=10.0)
        # osrm-routed serves one profile per instance, so car and foot are separate services.
        self.osrm = {"driving": s.osrm_car_url.rstrip("/"), "foot": s.osrm_foot_url.rstrip("/")}
        self.examples_dir = examples_dir or s.examples_dir

    def _fares(self, city_slug: str) -> dict:
        path = self.examples_dir / city_slug / "cab-fares.json"
        if path.exists():
            return json.loads(path.read_text(encoding="utf-8"))
        return {"baseInr": 100, "perKmInr": 20, "minimumInr": 100, "pickupMin": 5}

    def _table(self, profile: str, points: list[PlacePoint]) -> list[list[float | None]]:
        coords = ";".join(f"{p.lng},{p.lat}" for p in points)
        res = self.client.get(f"{self.osrm[profile]}/table/v1/{profile}/{coords}", params={"annotations": "duration,distance"})
        res.raise_for_status()
        body = res.json()
        return [[(d, k) for d, k in zip(drow, krow, strict=True)] for drow, krow in zip(body["durations"], body["distances"], strict=True)]  # type: ignore[misc]

    def snapshot(self, city_slug: str, places: list[PlacePoint], day: date) -> TravelSnapshot:
        if len(places) < 2:
            return TravelSnapshot(snapshot_id=f"{city_slug}-osrm-empty", pairs=())
        fares = self._fares(city_slug)
        metro = MetroTimetable.load(self.examples_dir / city_slug / "metro.json")
        car = self._table("driving", places)
        foot = self._table("foot", places)
        pairs: list[PairOptions] = []
        for i, a in enumerate(places):
            for j, b in enumerate(places):
                if i == j:
                    continue
                options: list[LegOption] = []
                car_cell, foot_cell = car[i][j], foot[i][j]
                if car_cell and car_cell[0] is not None:
                    secs, metres = car_cell  # type: ignore[misc]
                    minutes = math.ceil(secs / 60) + int(fares.get("pickupMin", 5))
                    fare = max(int(fares["minimumInr"]), round(fares["baseInr"] + fares["perKmInr"] * metres / 1000))
                    options.append(
                        LegOption(
                            option_id=f"{a.place_id}-{b.place_id}-cab",
                            mode=Mode.CAB,
                            label="Cab",
                            segments=(Segment(mode=Mode.CAB, minutes=minutes),),
                            travel_min=minutes,
                            fare_inr=fare,
                        )
                    )
                if _km(a, b) < WALK_LIMIT_KM and foot_cell and foot_cell[0] is not None:
                    minutes = math.ceil(foot_cell[0] / 60)  # type: ignore[index]
                    options.append(
                        LegOption(
                            option_id=f"{a.place_id}-{b.place_id}-walk",
                            mode=Mode.WALK,
                            label="Walk",
                            segments=(Segment(mode=Mode.WALK, minutes=minutes),),
                            travel_min=minutes,
                            fare_inr=0,
                        )
                    )
                options.extend(metro.options(a, b))
                if options:
                    pairs.append(PairOptions(from_place=a.place_id, to_place=b.place_id, options=tuple(options)))
        digest = hashlib.sha256(json.dumps([p.model_dump(mode="json") for p in pairs], sort_keys=True).encode()).hexdigest()[:12]
        return TravelSnapshot(snapshot_id=f"{city_slug}-osrm-{day.isoformat()}-{digest}", pairs=tuple(pairs))


def make_adapter(transit: TransitAdapter, redis_client=None) -> TravelTimeAdapter:
    if get_settings().travel_times_source == "osrm":
        return OsrmSnapshotAdapter(transit, redis_client)
    return SampleSnapshotAdapter(transit)
