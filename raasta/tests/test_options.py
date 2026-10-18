"""Which routes are offered for a leg."""

from __future__ import annotations

from app.services.geo import LatLng
from app.services.options import RouteCandidate, StandOnRoute, best_stand_pair, select_options

KOR5 = StandOnRoute("std-kor5", "Koramangala 5th Block stand", 1, LatLng(12.934, 77.6185))
FORUM = StandOnRoute("std-forum", "Forum Mall", 2, LatLng(12.9346, 77.6112))
DAIRY = StandOnRoute("std-dairy", "Dairy Circle", 3, LatLng(12.9375, 77.6013))
JAY4 = StandOnRoute("std-jay4", "Jayanagar 4th Block stand", 4, LatLng(12.929, 77.583))
BANK = LatLng(12.9352, 77.6195)
OFFICE = LatLng(12.9255, 77.5838)


def route(route_id="sample-kor-jay", status="verified", stands=(KOR5, FORUM, DAIRY, JAY4), last=21 * 60 + 30) -> RouteCandidate:
    return RouteCandidate(route_id, status, "shared_auto", 30, 10, 7 * 60, last, stands)


def test_board_near_the_start_and_get_off_near_the_end():
    m = best_stand_pair(route(), BANK, OFFICE, 800, 80)
    assert m is not None
    assert (m.board.stand_id, m.alight.stand_id) == ("std-kor5", "std-jay4")
    assert m.stops_between == 3
    assert m.expected_wait_min == 5
    assert m.walk_from_min >= 1 and m.ride_distance_m > 3000


def test_wrong_direction_is_not_offered():
    assert best_stand_pair(route(), OFFICE, BANK, 800, 80) is None


def test_verified_routes_are_main_options():
    result = select_options([route()], BANK, OFFICE, at_min=15 * 60)
    assert [m.route.route_id for m in result.main] == ["sample-kor-jay"]
    assert result.extras == () and result.last_trip_passed == ()


def test_unverified_and_stale_routes_are_only_extras():
    result = select_options([route("u", "unverified"), route("s", "stale")], BANK, OFFICE, at_min=15 * 60)
    assert result.main == ()
    assert sorted(m.route.route_id for m in result.extras) == ["s", "u"]


def test_no_route_after_its_last_trip():
    result = select_options([route(last=21 * 60 + 30)], BANK, OFFICE, at_min=21 * 60 + 29)
    assert result.main == ()
    assert result.last_trip_passed == ("sample-kor-jay",)


def test_routes_beyond_walking_distance_are_ignored():
    far = LatLng(13.05, 77.6)
    assert select_options([route()], far, OFFICE, at_min=600).main == ()
