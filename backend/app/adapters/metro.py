"""The metro adapter: a static file per city (examples/<city>/metro.json) with the lines' stations in order (for
drawing rides), and optionally a timetable (for planning).

The file lists stations and, for station pairs, the riding minutes and fare. A metro leg is offered
when both ends are within walking distance of a station; its time includes the walk at each end and
the expected wait (half the headway).
"""

from __future__ import annotations

import json
import math
import re
from dataclasses import dataclass, field
from functools import lru_cache
from pathlib import Path
from typing import TYPE_CHECKING

from app.services.planner import LegOption, Mode, Segment, TransitRef
from app.services.planner.util import to_minutes

if TYPE_CHECKING:
    from app.adapters.travel_times import PlacePoint

WALK_M_PER_MIN = 80
STATION_RADIUS_M = 1000


def _metres(lng1: float, lat1: float, lng2: float, lat2: float) -> float:
    dx = (lng2 - lng1) * 111_320 * math.cos(math.radians((lat1 + lat2) / 2))
    dy = (lat2 - lat1) * 110_540
    return math.hypot(dx, dy)


@dataclass(frozen=True)
class Station:
    station_id: str
    name: str
    lng: float
    lat: float


@dataclass(frozen=True)
class MetroLine:
    """A line's stations in order, for drawing a ride station to station (the file's `lines`, from OpenStreetMap)."""

    line_id: str
    name: str
    colour: str
    stations: tuple[Station, ...]


@lru_cache(maxsize=16)
def metro_lines(path: Path) -> dict[str, MetroLine]:
    if not path.exists():
        return {}
    data = json.loads(path.read_text(encoding="utf-8"))
    lines = {}
    for line in data.get("lines", []):
        # OpenStreetMap names an interchange per line ("Majestic (Green Line)"): the rider needs only the station.
        stations = tuple(Station(s["stationId"], re.sub(r"\s*\([^)]*Line\)$", "", s["name"]), s["lng"], s["lat"]) for s in line["stations"])
        lines[line["lineId"]] = MetroLine(line["lineId"], line["name"], line["colour"], stations)
    return lines


@dataclass
class MetroTimetable:
    first: int = 5 * 60
    last: int = 23 * 60
    headway_min: int = 10
    stations: dict[str, tuple[float, float]] = field(default_factory=dict)
    rides: dict[tuple[str, str], tuple[int, int, str]] = field(default_factory=dict)

    @classmethod
    def load(cls, path: Path) -> MetroTimetable:
        if not path.exists():
            return cls()
        data = json.loads(path.read_text(encoding="utf-8"))
        stations = {s["stationId"]: (s["lng"], s["lat"]) for s in data.get("stations", [])}
        rides = {}
        for r in data.get("rides", []):
            rides[(r["from"], r["to"])] = (r["minutes"], r["fareInr"], r.get("line", "metro"))
            rides[(r["to"], r["from"])] = (r["minutes"], r["fareInr"], r.get("line", "metro"))
        return cls(to_minutes(data.get("first", "05:00")), to_minutes(data.get("last", "23:00")), data.get("headwayMin", 10), stations, rides)

    def _near(self, p: PlacePoint) -> list[tuple[str, float]]:
        out = [(sid, _metres(p.lng, p.lat, lng, lat)) for sid, (lng, lat) in self.stations.items()]
        return sorted((x for x in out if x[1] <= STATION_RADIUS_M), key=lambda x: (x[1], x[0]))

    def options(self, a: PlacePoint, b: PlacePoint) -> list[LegOption]:
        best: tuple[int, int, str, int, int] | None = None
        for sa, da in self._near(a):
            for sb, db in self._near(b):
                ride = self.rides.get((sa, sb))
                if not ride:
                    continue
                walk_a, walk_b = math.ceil(da / WALK_M_PER_MIN), math.ceil(db / WALK_M_PER_MIN)
                total = walk_a + self.headway_min // 2 + ride[0] + walk_b
                if best is None or total < best[0]:
                    best = (total, ride[1], ride[2], walk_a, walk_b)
        if best is None:
            return []
        total, fare, line, walk_a, walk_b = best
        segments = tuple(
            s
            for s in (
                Segment(mode=Mode.WALK, minutes=walk_a),
                Segment(mode=Mode.METRO, minutes=total - walk_a - walk_b),
                Segment(mode=Mode.WALK, minutes=walk_b),
            )
            if s.minutes > 0
        )
        return [
            LegOption(
                option_id=f"{a.place_id}-{b.place_id}-metro",
                mode=Mode.METRO,
                label="Metro",
                segments=segments,
                travel_min=total,
                fare_inr=fare,
                service_first=self.first,
                service_last=self.last,
                transit_ref=TransitRef(kind="metro", ref_id=line),
            )
        ]
