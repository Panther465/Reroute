from __future__ import annotations

from datetime import UTC, datetime, timedelta

from app.services.geo import LatLng, RidePoint, distance_m, path_length_m, suggest_stops, trim_ride

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
