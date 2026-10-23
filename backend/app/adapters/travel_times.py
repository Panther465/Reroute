"""Travel-time snapshots for the planner. The worker fetches everything first; the planner never calls out.

Two implementations share one interface:
- SampleSnapshotAdapter reads examples/<city>/travel-times.json (the Bengaluru demo). For a place the
  file doesn't know (any place found by search), it adds rough cab and walk estimates from the
  straight-line distance, flagged `rough` so every screen can say so. In a city with no sample file,
  the estimates use real road distances (one table from the routing server per plan) when it answers.
- OsrmSnapshotAdapter asks OSRM for road times (car and foot), prices cabs from the city fare table,
  adds metro options from the timetable file, and caches every pair in Redis for 24 hours.
Both enrich Raasta legs through the transit adapter, so a route's live status and first and last
trip decide whether it may be used.
"""

from __future__ import annotations

import contextlib
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
from app.adapters.road_path import Router, Unavailable
from app.adapters.snapshot_file import parse_snapshot
from app.adapters.transit import TransitAdapter
from app.cities import city as supported_city
from app.config import get_settings
from app.services.planner import LegOption, Mode, PairOptions, Segment, TransitRef, TravelSnapshot
from app.services.planner.util import to_minutes

log = logging.getLogger("reroute.travel")

WALK_LIMIT_KM = 1.5

# Rough estimates (sample assumptions, to replace with measured times): roads run about 1.3 times the
# straight line, cabs average 18 km/h in city traffic, and people walk 4.5 km/h.
ROAD_FACTOR = 1.3
CAB_KMH = 18.0
WALK_KMH = 4.5
DEFAULT_FARES = {"baseInr": 100, "perKmInr": 20, "minimumInr": 100, "pickupMin": 5}


@dataclass(frozen=True)
class PlacePoint:
    place_id: str
    lng: float
    lat: float


def cab_fares(examples_dir: Path, city_slug: str) -> dict:
    path = examples_dir / city_slug / "cab-fares.json"
    return json.loads(path.read_text(encoding="utf-8")) if path.exists() else DEFAULT_FARES


def rough_options(a: PlacePoint, b: PlacePoint, fares: dict, road_km: float | None = None) -> tuple[LegOption, ...]:
    """A cab, and a walk when it's close, estimated from the road distance, else from the straight line."""
    km = _km(a, b)
    road_km = road_km if road_km is not None else km * ROAD_FACTOR
    cab_min = math.ceil(road_km / CAB_KMH * 60) + int(fares.get("pickupMin", 5))
    fare = max(int(fares["minimumInr"]), round(fares["baseInr"] + fares["perKmInr"] * road_km))
    options = [
        LegOption(
            option_id=f"{a.place_id}-{b.place_id}-cab-rough",
            mode=Mode.CAB,
            label="Cab",
            segments=(Segment(mode=Mode.CAB, minutes=cab_min),),
            travel_min=cab_min,
            fare_inr=fare,
            rough=True,
        )
    ]
    if km < WALK_LIMIT_KM:
        walk_min = max(1, math.ceil(road_km / WALK_KMH * 60))
        options.append(
            LegOption(
                option_id=f"{a.place_id}-{b.place_id}-walk-rough",
                mode=Mode.WALK,
                label="Walk",
                segments=(Segment(mode=Mode.WALK, minutes=walk_min),),
                travel_min=walk_min,
                fare_inr=0,
                rough=True,
            )
        )
    return tuple(options)


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
    def __init__(self, transit: TransitAdapter, examples_dir: Path | None = None, router: Router | None = None):
        self.transit = transit
        self.examples_dir = examples_dir or get_settings().examples_dir
        self.router = router

    def _road_km(self, places: list[PlacePoint]) -> dict[tuple[str, str], float]:
        """Road kilometres between every two places, in one request; nothing when routing is off or busy (the
        estimates then use the straight line). Only the distance: speeds stay the city averages, since an
        empty-road time would promise too much."""
        if self.router is None or not self.router.on("car") or len(places) < 2:
            return {}
        try:
            table = self.router.distances([(p.lng, p.lat) for p in places])
        except Unavailable:
            return {}
        return {(a.place_id, b.place_id): table[i][j] / 1000 for i, a in enumerate(places) for j, b in enumerate(places) if i != j and table[i][j] is not None}

    def snapshot(self, city_slug: str, places: list[PlacePoint], day: date) -> TravelSnapshot:
        path = self.examples_dir / city_slug / "travel-times.json"
        if not path.exists():
            # A city without sample data: rough cab and walk estimates between every two places.
            fares = cab_fares(self.examples_dir, city_slug)
            road_km = self._road_km(places)
            pairs = tuple(
                PairOptions(from_place=a.place_id, to_place=b.place_id, options=rough_options(a, b, fares, road_km.get((a.place_id, b.place_id))))
                for a in places
                for b in places
                if a.place_id != b.place_id
            )
            digest = hashlib.sha256(json.dumps([p.model_dump(mode="json") for p in pairs], sort_keys=True).encode()).hexdigest()[:8]
            return TravelSnapshot(snapshot_id=f"{city_slug}-rough-{digest}", pairs=pairs)
        data = json.loads(path.read_text(encoding="utf-8"))
        known = {p["from"] for p in data["pairs"]} | {p["to"] for p in data["pairs"]}
        wanted = {p.place_id for p in places}
        data = {**data, "pairs": [p for p in data["pairs"] if p["from"] in wanted and p["to"] in wanted]}
        status, service = _enrich(data, self.transit)
        snap = parse_snapshot(data, raasta_status=status, raasta_service=service)
        # Only places the file doesn't know get estimates: the file's own gaps between its places stay
        # gaps, so the sample day plans exactly as the brief's golden test says.
        fares = cab_fares(self.examples_dir, city_slug)
        rough = tuple(
            PairOptions(from_place=a.place_id, to_place=b.place_id, options=rough_options(a, b, fares))
            for a in places
            for b in places
            if a.place_id != b.place_id and (a.place_id not in known or b.place_id not in known)
        )
        # The snapshot ID changes when a route's status or hours change, or estimates join, so replays stay exact.
        parts = [status, service, [p.model_dump(mode="json") for p in rough]]
        suffix = hashlib.sha256(json.dumps(parts, sort_keys=True).encode()).hexdigest()[:8]
        return snap.model_copy(update={"snapshot_id": f"{snap.snapshot_id}-{suffix}", "pairs": snap.pairs + rough})


def _km(a: PlacePoint, b: PlacePoint) -> float:
    r = 6371.0
    dlat = math.radians(b.lat - a.lat)
    dlng = math.radians(b.lng - a.lng)
    h = math.sin(dlat / 2) ** 2 + math.cos(math.radians(a.lat)) * math.cos(math.radians(b.lat)) * math.sin(dlng / 2) ** 2
    return 2 * r * math.asin(math.sqrt(h))


class OsrmSnapshotAdapter:
    """Road times from OSRM (car and foot), cab fares from the city fare table, metro from the
    timetable file, and verified Raasta routes from the transit adapter.

    OSRM tables are cached in Redis by city, places and hour for 24 hours. If OSRM can't be reached,
    the sample snapshot is used instead, so planning degrades rather than fails.
    """

    def __init__(self, transit: TransitAdapter, redis_client=None, client: httpx.Client | None = None, examples_dir: Path | None = None):
        s = get_settings()
        self.transit = transit
        self.redis = redis_client
        self.client = client or httpx.Client(timeout=10.0)
        # osrm-routed serves one profile per instance, so car and foot are separate services.
        self.osrm = {"driving": s.osrm_car_url.rstrip("/"), "foot": s.osrm_foot_url.rstrip("/")}
        self.examples_dir = examples_dir or s.examples_dir

    def _table(self, city_slug: str, profile: str, points: list[PlacePoint], day: date) -> list[list[tuple[float | None, float | None]]]:
        coords = ";".join(f"{p.lng:.6f},{p.lat:.6f}" for p in points)
        key = f"tt:{city_slug}:{profile}:{day.isoformat()}:" + hashlib.sha256(coords.encode()).hexdigest()[:20]
        if self.redis is not None:
            try:
                cached = self.redis.get(key)
                if cached:
                    return [[tuple(cell) for cell in row] for row in json.loads(cached)]  # type: ignore[misc]
            except Exception:
                pass
        res = self.client.get(f"{self.osrm[profile]}/table/v1/{profile}/{coords}", params={"annotations": "duration,distance"})
        res.raise_for_status()
        body = res.json()
        table = [list(zip(drow, krow, strict=True)) for drow, krow in zip(body["durations"], body["distances"], strict=True)]
        if self.redis is not None:
            with contextlib.suppress(Exception):
                self.redis.set(key, json.dumps(table), ex=24 * 3600)
        return table

    def _raasta_options(self, a: PlacePoint, b: PlacePoint, day: date, utc_offset: str) -> list[LegOption]:
        options = []
        for leg in self.transit.leg_options(a, b, day, utc_offset):
            mode = Mode(leg.vehicle_type) if leg.vehicle_type in ("shared_auto", "e_rickshaw", "tempo") else Mode.SHARED_AUTO
            segments = tuple(
                x
                for x in (
                    Segment(mode=Mode.WALK, minutes=leg.walk_from_min),
                    Segment(mode=mode, minutes=leg.wait_min + leg.ride_min),
                    Segment(mode=Mode.WALK, minutes=leg.walk_to_min),
                )
                if x.minutes > 0
            )
            options.append(
                LegOption(
                    option_id=f"{a.place_id}-{b.place_id}-raasta-{leg.route_id}",
                    mode=mode,
                    label={"shared_auto": "Shared auto", "e_rickshaw": "E-rickshaw", "tempo": "Tempo"}[mode.value],
                    segments=segments,
                    travel_min=leg.travel_min,
                    fare_inr=leg.fare_inr,
                    service_first=to_minutes(leg.first_trip),
                    service_last=to_minutes(leg.last_trip),
                    transit_ref=TransitRef(kind="raasta", ref_id=leg.route_id, status=leg.status),
                )
            )
        return options

    def snapshot(self, city_slug: str, places: list[PlacePoint], day: date) -> TravelSnapshot:
        if len(places) < 2:
            return TravelSnapshot(snapshot_id=f"{city_slug}-osrm-empty", pairs=())
        try:
            car = self._table(city_slug, "driving", places, day)
            foot = self._table(city_slug, "foot", places, day)
        except (httpx.HTTPError, KeyError, ValueError) as exc:
            log.warning("OSRM unavailable, using the sample snapshot: %s", exc)
            return SampleSnapshotAdapter(self.transit, self.examples_dir).snapshot(city_slug, places, day)
        where = supported_city(city_slug)
        utc_offset = where.utc_offset if where else "+05:30"
        fares = cab_fares(self.examples_dir, city_slug)
        metro = MetroTimetable.load(self.examples_dir / city_slug / "metro.json")
        pairs: list[PairOptions] = []
        for i, a in enumerate(places):
            for j, b in enumerate(places):
                if i == j:
                    continue
                options: list[LegOption] = []
                secs, metres = car[i][j]
                if secs is not None and metres is not None:
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
                walk_secs = foot[i][j][0]
                if _km(a, b) < WALK_LIMIT_KM and walk_secs is not None:
                    minutes = math.ceil(walk_secs / 60)
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
                options.extend(self._raasta_options(a, b, day, utc_offset))
                if options:
                    pairs.append(PairOptions(from_place=a.place_id, to_place=b.place_id, options=tuple(options)))
        digest = hashlib.sha256(json.dumps([p.model_dump(mode="json") for p in pairs], sort_keys=True).encode()).hexdigest()[:12]
        return TravelSnapshot(snapshot_id=f"{city_slug}-osrm-{day.isoformat()}-{digest}", pairs=tuple(pairs))


def make_adapter(transit: TransitAdapter, redis_client=None) -> TravelTimeAdapter:
    if get_settings().travel_times_source == "osrm":
        return OsrmSnapshotAdapter(transit, redis_client)
    return SampleSnapshotAdapter(transit, router=Router(redis_client) if redis_client is not None else None)
