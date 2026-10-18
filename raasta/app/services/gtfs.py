"""Build a GTFS feed of verified routes (agency, stops, routes, trips, stop_times, frequencies, shapes, calendar).

Shared autos run on frequencies, not timetables, so each route has one template trip with
frequency-based headways between its first and last trip. Pure: "today" is passed in.
"""

from __future__ import annotations

import csv
import io
import zipfile
from collections.abc import Sequence
from dataclasses import dataclass
from datetime import date, timedelta

from app.services.geo import LatLng, distance_m

#: GTFS route_type for the extended "share taxi" type, which describes shared autos.
ROUTE_TYPE_SHARE_TAXI = 1501
#: Assumed average speed between stands, used only for stop_times offsets inside a template trip.
AVERAGE_SPEED_M_PER_MIN = 250

VEHICLE_NAMES = {"shared_auto": "Shared auto", "e_rickshaw": "E-rickshaw", "tempo": "Tempo"}


@dataclass(frozen=True, slots=True)
class GtfsStand:
    stand_id: str
    name: str
    location: LatLng


@dataclass(frozen=True, slots=True)
class GtfsRoute:
    route_id: str
    vehicle_type: str
    fare_inr: int
    frequency_min: int
    first_trip: str
    last_trip: str
    stands: tuple[GtfsStand, ...]
    path: tuple[LatLng, ...] = ()


def _csv(header: Sequence[str], rows: Sequence[Sequence[object]]) -> str:
    buf = io.StringIO()
    writer = csv.writer(buf, lineterminator="\n", quoting=csv.QUOTE_MINIMAL)
    writer.writerow(header)
    writer.writerows(rows)
    return buf.getvalue()


def _gtfs_time(hhmm: str, extra_min: int = 0) -> str:
    h, m = (int(x) for x in hhmm.split(":"))
    total = h * 60 + m + extra_min
    return f"{total // 60:02d}:{total % 60:02d}:00"


def build_gtfs(city_slug: str, city_name: str, routes: Sequence[GtfsRoute], today: date, agency_url: str, timezone_name: str = "Asia/Kolkata") -> bytes:
    stops: dict[str, GtfsStand] = {}
    for r in routes:
        for s in r.stands:
            stops.setdefault(s.stand_id, s)

    route_rows, trip_rows, time_rows, freq_rows, shape_rows = [], [], [], [], []
    for r in sorted(routes, key=lambda x: x.route_id):
        first, last = r.stands[0].name, r.stands[-1].name
        route_rows.append([r.route_id, "raasta", "", f"{VEHICLE_NAMES.get(r.vehicle_type, r.vehicle_type)}: {first} to {last}", ROUTE_TYPE_SHARE_TAXI])
        trip_id = f"{r.route_id}-template"
        shape_id = f"{r.route_id}-shape"
        trip_rows.append([r.route_id, "daily", trip_id, last, shape_id])
        offset_min = 0
        for seq, s in enumerate(r.stands, start=1):
            if seq > 1:
                offset_min += max(1, round(distance_m(r.stands[seq - 2].location, s.location) / AVERAGE_SPEED_M_PER_MIN))
            t = _gtfs_time(r.first_trip, offset_min)
            time_rows.append([trip_id, t, t, s.stand_id, seq])
        freq_rows.append([trip_id, _gtfs_time(r.first_trip), _gtfs_time(r.last_trip), r.frequency_min * 60, 0])
        points = r.path or tuple(s.location for s in r.stands)
        travelled = 0.0
        for seq, p in enumerate(points, start=1):
            if seq > 1:
                travelled += distance_m(points[seq - 2], p)
            shape_rows.append([shape_id, f"{p.lat:.6f}", f"{p.lng:.6f}", seq, f"{travelled:.1f}"])

    start, end = today, today + timedelta(days=365)
    files = {
        "agency.txt": _csv(
            ["agency_id", "agency_name", "agency_url", "agency_timezone", "agency_lang"],
            [["raasta", f"Raasta riders, {city_name}", agency_url, timezone_name, "en"]],
        ),
        "stops.txt": _csv(
            ["stop_id", "stop_name", "stop_lat", "stop_lon"],
            [[s.stand_id, s.name, f"{s.location.lat:.6f}", f"{s.location.lng:.6f}"] for s in sorted(stops.values(), key=lambda s: s.stand_id)],
        ),
        "routes.txt": _csv(["route_id", "agency_id", "route_short_name", "route_long_name", "route_type"], route_rows),
        "trips.txt": _csv(["route_id", "service_id", "trip_id", "trip_headsign", "shape_id"], trip_rows),
        "stop_times.txt": _csv(["trip_id", "arrival_time", "departure_time", "stop_id", "stop_sequence"], time_rows),
        "frequencies.txt": _csv(["trip_id", "start_time", "end_time", "headway_secs", "exact_times"], freq_rows),
        "shapes.txt": _csv(["shape_id", "shape_pt_lat", "shape_pt_lon", "shape_pt_sequence", "shape_dist_traveled"], shape_rows),
        "calendar.txt": _csv(
            ["service_id", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday", "start_date", "end_date"],
            [["daily", 1, 1, 1, 1, 1, 1, 1, start.strftime("%Y%m%d"), end.strftime("%Y%m%d")]],
        ),
        "feed_info.txt": _csv(
            ["feed_publisher_name", "feed_publisher_url", "feed_lang", "feed_version"], [["Raasta", agency_url, "en", f"{city_slug}-{today.isoformat()}"]]
        ),
    }
    out = io.BytesIO()
    with zipfile.ZipFile(out, "w", compression=zipfile.ZIP_DEFLATED) as zf:
        for name, text in files.items():
            info = zipfile.ZipInfo(name, date_time=(today.year, today.month, today.day, 0, 0, 0))
            info.compress_type = zipfile.ZIP_DEFLATED
            zf.writestr(info, text)
    return out.getvalue()
