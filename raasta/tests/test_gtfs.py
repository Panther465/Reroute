from __future__ import annotations

import csv
import io
import zipfile
from datetime import date

from app.services.geo import LatLng
from app.services.gtfs import GtfsRoute, GtfsStand, build_gtfs

STANDS = (
    GtfsStand("std-kor5", "Koramangala 5th Block stand", LatLng(12.934, 77.6185)),
    GtfsStand("std-forum", 'Forum Mall, "Gate 2"', LatLng(12.9346, 77.6112)),
    GtfsStand("std-jay4", "Jayanagar 4th Block stand", LatLng(12.929, 77.583)),
)
ROUTE = GtfsRoute("sample-kor-jay", "shared_auto", 30, 10, "07:00", "21:30", STANDS)


def read(feed: bytes) -> dict[str, list[dict[str, str]]]:
    with zipfile.ZipFile(io.BytesIO(feed)) as zf:
        return {name: list(csv.DictReader(io.StringIO(zf.read(name).decode()))) for name in zf.namelist()}


def test_feed_has_every_required_file():
    files = read(build_gtfs("bengaluru", "Bengaluru", [ROUTE], date(2026, 10, 14), "https://example.org"))
    assert set(files) == {
        "agency.txt",
        "stops.txt",
        "routes.txt",
        "trips.txt",
        "stop_times.txt",
        "frequencies.txt",
        "shapes.txt",
        "calendar.txt",
        "feed_info.txt",
    }


def test_names_with_commas_and_quotes_survive_csv_quoting():
    files = read(build_gtfs("bengaluru", "Bengaluru", [ROUTE], date(2026, 10, 14), "https://example.org"))
    names = {s["stop_id"]: s["stop_name"] for s in files["stops.txt"]}
    assert names["std-forum"] == 'Forum Mall, "Gate 2"'


def test_frequencies_and_stop_times_follow_the_route():
    files = read(build_gtfs("bengaluru", "Bengaluru", [ROUTE], date(2026, 10, 14), "https://example.org"))
    freq = files["frequencies.txt"][0]
    assert (freq["start_time"], freq["end_time"], freq["headway_secs"]) == ("07:00:00", "21:30:00", "600")
    times = files["stop_times.txt"]
    assert [t["stop_id"] for t in times] == ["std-kor5", "std-forum", "std-jay4"]
    assert times[0]["arrival_time"] == "07:00:00"
    assert times == sorted(times, key=lambda t: t["arrival_time"])


def test_calendar_runs_a_year_from_the_given_day():
    cal = read(build_gtfs("bengaluru", "Bengaluru", [ROUTE], date(2026, 10, 14), "https://example.org"))["calendar.txt"][0]
    assert (cal["start_date"], cal["end_date"]) == ("20261014", "20271014")


def test_shapes_fall_back_to_the_stands():
    shapes = read(build_gtfs("bengaluru", "Bengaluru", [ROUTE], date(2026, 10, 14), "https://example.org"))["shapes.txt"]
    assert len(shapes) == 3 and float(shapes[-1]["shape_dist_traveled"]) > 0


def test_same_input_gives_the_same_bytes():
    a = build_gtfs("bengaluru", "Bengaluru", [ROUTE], date(2026, 10, 14), "https://example.org")
    b = build_gtfs("bengaluru", "Bengaluru", [ROUTE], date(2026, 10, 14), "https://example.org")
    assert a == b
