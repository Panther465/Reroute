"""Verification matching, fares and freshness (project brief, section 12)."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

from app.services.fares import current_fare
from app.services.freshness import is_stale, reverified_by_riders
from app.services.geo import LatLng
from app.services.matching import RouteShape, find_match, same_route

KOR = LatLng(12.934, 77.6185)
FORUM = LatLng(12.9346, 77.6112)
JAY = LatLng(12.929, 77.583)
NOW = datetime(2026, 10, 14, 12, 0, tzinfo=UTC)


def nudge(p: LatLng, metres_north: float) -> LatLng:
    return LatLng(p.lat + metres_north / 111_195, p.lng)


# ---------- matching ----------


def test_same_stands_same_order_same_vehicle_match():
    a = RouteShape("shared_auto", (KOR, FORUM, JAY))
    b = RouteShape("shared_auto", (nudge(KOR, 100), nudge(FORUM, -140), nudge(JAY, 60)))
    assert same_route(a, b)


def test_a_stand_more_than_150_m_away_does_not_match():
    a = RouteShape("shared_auto", (KOR, FORUM, JAY))
    b = RouteShape("shared_auto", (KOR, nudge(FORUM, 160), JAY))
    assert not same_route(a, b)


def test_different_vehicle_type_or_order_does_not_match():
    a = RouteShape("shared_auto", (KOR, FORUM, JAY))
    assert not same_route(a, RouteShape("e_rickshaw", (KOR, FORUM, JAY)))
    assert not same_route(a, RouteShape("shared_auto", (JAY, FORUM, KOR)))
    assert not same_route(a, RouteShape("shared_auto", (KOR, JAY)))


def test_find_match_returns_the_first_matching_route():
    a = RouteShape("tempo", (KOR, JAY))
    others = [("r1", RouteShape("tempo", (JAY, KOR))), ("r2", RouteShape("tempo", (nudge(KOR, 50), JAY))), ("r3", RouteShape("tempo", (KOR, JAY)))]
    assert find_match(a, others) == "r2"
    assert find_match(a, others[:1]) is None


# ---------- fares ----------


def test_most_common_fare_in_the_last_30_days_wins():
    reports = [(30, NOW - timedelta(days=1)), (30, NOW - timedelta(days=2)), (40, NOW - timedelta(days=1))]
    assert current_fare(reports, NOW, fallback=25) == 30


def test_tie_goes_to_the_newer_fare():
    reports = [(30, NOW - timedelta(days=5)), (40, NOW - timedelta(days=1))]
    assert current_fare(reports, NOW, fallback=25) == 40


def test_reports_older_than_30_days_are_ignored():
    reports = [(50, NOW - timedelta(days=31)), (50, NOW - timedelta(days=40))]
    assert current_fare(reports, NOW, fallback=25) == 25


# ---------- freshness ----------


def test_stale_after_90_days_without_confirmation():
    assert not is_stale(NOW - timedelta(days=89), NOW - timedelta(days=200), NOW)
    assert is_stale(NOW - timedelta(days=90), NOW - timedelta(days=200), NOW)


def test_never_confirmed_routes_age_from_when_they_were_verified():
    assert is_stale(None, NOW - timedelta(days=91), NOW)
    assert not is_stale(None, NOW - timedelta(days=10), NOW)


def test_two_different_riders_reverify_a_stale_route():
    assert not reverified_by_riders(["u1", "u1", "u1"])
    assert reverified_by_riders(["u1", "u2"])
