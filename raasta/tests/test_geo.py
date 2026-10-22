from __future__ import annotations

import time
from datetime import UTC, datetime, timedelta

from app.services.geo import LatLng, RidePoint, distance_m, downsample, path_length_m, suggest_stops, trim_ride

T0 = datetime(2026, 10, 14, 9, 0, tzinfo=UTC)
# About 11.1 m per 0.0001 degree of latitude.
STEP = 0.0001


def straight_ride(n: int, every_s: int = 5) -> list[RidePoint]:
    return [RidePoint(lat=12.9 + i * STEP, lng=77.6, t=T0 + timedelta(seconds=i * every_s)) for i in range(n)]


def test_distance_is_about_111_km_per_degree_of_latitude():
    assert abs(distance_m(LatLng(12.0, 77.0), LatLng(13.0, 77.0)) - 111_195) < 50


def test_trim_drops_the_first_and_last_200_m():
    ride = straight_ride(100)  # ~1.1 km
    kept = trim_ride(ride, 200)
    total = path_length_m(ride)
    assert kept
    assert distance_m(ride[0], kept[0]) > 200
    assert distance_m(kept[-1], ride[-1]) > 200
    assert path_length_m(kept) < total - 400 + 25


def test_trim_never_keeps_the_ends_even_if_points_arrive_out_of_order():
    ride = list(reversed(straight_ride(100)))
    kept = trim_ride(ride, 200)
    assert all(distance_m(p, ride[-1]) > 200 for p in kept)  # ride[-1] is the true start after sorting


def test_jitter_while_waiting_at_the_start_does_not_use_up_the_trim():
    """Five minutes at the start with GPS jumping 30 m back and forth adds ~870 m of path but goes nowhere."""
    start = RidePoint(12.9, 77.6, T0)
    waiting = [RidePoint(12.9 + 0.00027 * (i % 2), 77.6, T0 + timedelta(seconds=10 * i)) for i in range(30)]
    riding = [RidePoint(12.9 + (i + 1) * STEP, 77.6, waiting[-1].t + timedelta(seconds=5 * (i + 1))) for i in range(100)]
    assert path_length_m(waiting) > 800
    kept = trim_ride(waiting + riding, 200)
    assert kept
    assert all(distance_m(p, start) > 200 and distance_m(p, riding[-1]) > 200 for p in kept)


def test_a_ride_that_ends_where_it_started_keeps_only_the_far_part():
    out = straight_ride(60)
    back = [RidePoint(p.lat, p.lng, out[-1].t + timedelta(seconds=5 * (i + 1))) for i, p in enumerate(reversed(out[:-1]))]
    kept = trim_ride(out + back, 200)
    assert kept and all(distance_m(p, out[0]) > 200 for p in kept)


def test_ride_shorter_than_400_m_leaves_nothing():
    assert trim_ride(straight_ride(30), 200) == []  # ~320 m
    assert trim_ride(straight_ride(1), 200) == []


def test_stops_are_suggested_where_the_vehicle_stood_still():
    moving = straight_ride(20, every_s=5)
    last = moving[-1]
    still = [RidePoint(last.lat + 0.00001 * (i % 2), last.lng, last.t + timedelta(seconds=10 * (i + 1))) for i in range(5)]  # 50 s, within 2 m
    after = [RidePoint(last.lat + (i + 1) * STEP * 5, last.lng, still[-1].t + timedelta(seconds=5 * (i + 1))) for i in range(10)]
    stops = suggest_stops(moving + still + after)
    assert len(stops) == 1
    assert distance_m(stops[0], last) < 5


def test_short_pauses_are_not_stops():
    moving = straight_ride(10)
    last = moving[-1]
    pause = [RidePoint(last.lat, last.lng, last.t + timedelta(seconds=10))]
    assert suggest_stops(moving + pause) == []


def test_jitter_that_never_lasts_30_s_is_linear():
    """A crafted ride of 20,000 points, all within 15 m and over in 20 s, used to take minutes."""
    jitter = [RidePoint(12.9 + 0.00005 * (i % 3), 77.6 + 0.00005 * (i % 2), T0 + timedelta(milliseconds=i)) for i in range(20_000)]
    started = time.perf_counter()
    assert suggest_stops(jitter) == []
    assert time.perf_counter() - started < 1.0


def test_jitter_that_lasts_is_one_stop():
    jitter = [RidePoint(12.9 + 0.00005 * (i % 3), 77.6 + 0.00005 * (i % 2), T0 + timedelta(milliseconds=10 * i)) for i in range(20_000)]
    started = time.perf_counter()
    stops = suggest_stops(jitter)
    assert time.perf_counter() - started < 1.0
    assert len(stops) == 1 and distance_m(stops[0], jitter[0]) < 15


def test_downsample_spreads_points_over_time_and_keeps_both_ends():
    ride = straight_ride(20_000, every_s=1)
    kept = downsample(list(reversed(ride)), 2000)
    assert len(kept) == 2000
    assert kept[0] == ride[0] and kept[-1] == ride[-1]
    gaps = [(b.t - a.t).total_seconds() for a, b in zip(kept, kept[1:], strict=False)]
    assert min(gaps) > 0 and max(gaps) <= 2 * (20_000 / 1999)
    assert downsample(ride[:50], 2000) == ride[:50]
