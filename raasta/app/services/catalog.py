"""Reading stands and routes, and turning rows into API shapes."""

from __future__ import annotations

from datetime import datetime, timedelta

from sqlalchemy import func, or_, select
from sqlalchemy.orm import Session

from app.config import Settings
from app.errors import not_found
from app.models import Confirmation, FareReport, Route, RouteStand, Stand
from app.pagination import encode_cursor
from app.schemas import LegOptionOut, LegOptionsOut, Location, RouteOut, RouteStandOut, StandNear, StandOut, StandRef
from app.services.fares import FARE_WINDOW_DAYS, current_fare
from app.services.geo import LatLng
from app.services.options import LegMatch, RouteCandidate, StandOnRoute, select_options
from app.services.timefmt import hhmm, local_minutes, minutes_of_day, to_local_iso


def point(lng: float, lat: float):
    """A geography point for PostGIS, from validated floats."""
    return func.ST_GeogFromText(f"SRID=4326;POINT({float(lng):.7f} {float(lat):.7f})")


def stand_out(s: Stand) -> StandOut:
    return StandOut(stand_id=s.stand_id, name=s.name, location=Location(lat=s.lat, lng=s.lng), sample=s.sample)


def shown_fare(session: Session, route: Route, now: datetime) -> int:
    since = now - timedelta(days=FARE_WINDOW_DAYS)
    rows = session.execute(
        select(FareReport.fare_inr, FareReport.at).where(FareReport.route_id == route.route_id, FareReport.status == "accepted", FareReport.at >= since)
    ).all()
    return current_fare(((r.fare_inr, r.at) for r in rows), now, route.fare_inr)


def confirmations_count(session: Session, route_id: str) -> int:
    """How many different riders have confirmed the route."""
    return int(session.scalar(select(func.count(func.distinct(Confirmation.user_id))).where(Confirmation.route_id == route_id)) or 0)


def route_out(session: Session, route: Route, settings: Settings, now: datetime) -> RouteOut:
    count = confirmations_count(session, route.route_id)
    path = route.path_coords or [[rs.stand.lng, rs.stand.lat] for rs in route.stands]
    return RouteOut(
        route_id=route.route_id,
        city_slug=route.city_slug,
        stands=[RouteStandOut(seq=rs.seq, **stand_out(rs.stand).model_dump()) for rs in route.stands],
        path=[Location(lat=lat, lng=lng) for lng, lat in path],
        vehicle_type=route.vehicle_type,  # type: ignore[arg-type]
        fare_inr=shown_fare(session, route, now),
        frequency_min=route.frequency_min,
        first_trip=hhmm(route.first_trip),
        last_trip=hhmm(route.last_trip),
        status=route.status,  # type: ignore[arg-type]
        source=route.source,  # type: ignore[arg-type]
        confidence=route.confidence,
        last_confirmed_at=to_local_iso(route.last_confirmed_at, settings.city_utc_offset),
        confirmations_count=count,
        sample=route.sample,
    )


def get_route(session: Session, route_id: str) -> Route:
    route = session.get(Route, route_id)
    if route is None:
        raise not_found("Route")
    return route


def shown_stand():
    """A stand is listed when it is sample data or on a route that has been verified (verified or stale).

    Stands only on unverified routes, or left over from rejected ones, stay off the map until a
    moderator or a second contributor vouches for them.
    """
    on_vouched_route = (
        select(RouteStand.stand_id)
        .join(Route, Route.route_id == RouteStand.route_id)
        .where(RouteStand.stand_id == Stand.stand_id, Route.status.in_(("verified", "stale")))
        .exists()
    )
    return or_(Stand.sample.is_(True), on_vouched_route)


def stands_near(session: Session, lng: float, lat: float, radius_m: int, offset: int, limit: int) -> tuple[list[StandNear], str | None]:
    here = point(lng, lat)
    distance = func.ST_Distance(Stand.location, here).label("distance")
    rows = session.execute(
        select(Stand, distance)
        .where(func.ST_DWithin(Stand.location, here, radius_m), shown_stand())
        .order_by(distance, Stand.stand_id)
        .offset(offset)
        .limit(limit + 1)
    ).all()
    items = [StandNear(distance_m=round(float(d), 1), **stand_out(s).model_dump()) for s, d in rows[:limit]]
    next_cursor = encode_cursor({"o": offset + limit}) if len(rows) > limit else None
    return items, next_cursor


def _candidates(session: Session, origin: LatLng, dest: LatLng, radius_m: int) -> list[Route]:
    near_origin = (
        select(RouteStand.route_id)
        .join(Stand, Stand.stand_id == RouteStand.stand_id)
        .where(func.ST_DWithin(Stand.location, point(origin.lng, origin.lat), radius_m))
    )
    near_dest = (
        select(RouteStand.route_id)
        .join(Stand, Stand.stand_id == RouteStand.stand_id)
        .where(func.ST_DWithin(Stand.location, point(dest.lng, dest.lat), radius_m))
    )
    ids = set(session.scalars(near_origin)) & set(session.scalars(near_dest))
    if not ids:
        return []
    return list(session.scalars(select(Route).where(Route.route_id.in_(ids)).order_by(Route.route_id)))


def _candidate(session: Session, route: Route, now: datetime) -> RouteCandidate:
    return RouteCandidate(
        route_id=route.route_id,
        status=route.status,
        vehicle_type=route.vehicle_type,
        fare_inr=shown_fare(session, route, now),
        frequency_min=route.frequency_min,
        first_trip_min=minutes_of_day(route.first_trip),
        last_trip_min=minutes_of_day(route.last_trip),
        stands=tuple(StandOnRoute(rs.stand_id, rs.stand.name, rs.seq, LatLng(rs.stand.lat, rs.stand.lng)) for rs in route.stands),
    )


def _leg_out(m: LegMatch, sample_by_id: dict[str, bool]) -> LegOptionOut:
    r = m.route

    def ref(s: StandOnRoute) -> StandRef:
        return StandRef(stand_id=s.stand_id, name=s.name, seq=s.seq, location=Location(lat=s.location.lat, lng=s.location.lng))

    return LegOptionOut(
        route_id=r.route_id,
        vehicle_type=r.vehicle_type,  # type: ignore[arg-type]
        status=r.status,  # type: ignore[arg-type]
        fare_inr=r.fare_inr,
        frequency_min=r.frequency_min,
        first_trip=f"{r.first_trip_min // 60:02d}:{r.first_trip_min % 60:02d}",
        last_trip=f"{r.last_trip_min // 60:02d}:{r.last_trip_min % 60:02d}",
        board=ref(m.board),
        alight=ref(m.alight),
        stops_between=m.stops_between,
        walk_from_m=m.walk_from_m,
        walk_to_m=m.walk_to_m,
        walk_from_min=m.walk_from_min,
        walk_to_min=m.walk_to_min,
        expected_wait_min=m.expected_wait_min,
        ride_distance_m=m.ride_distance_m,
        sample=sample_by_id.get(r.route_id, False),
    )


def leg_options(session: Session, origin: LatLng, dest: LatLng, at: datetime, now: datetime, settings: Settings, limit: int) -> LegOptionsOut:
    routes = _candidates(session, origin, dest, settings.walk_radius_m)
    sample_by_id = {r.route_id: r.sample for r in routes}
    result = select_options(
        [_candidate(session, r, now) for r in routes],
        origin,
        dest,
        local_minutes(at, settings.city_utc_offset),
        radius_m=settings.walk_radius_m,
        walk_m_per_min=settings.walk_speed_m_per_min,
    )
    return LegOptionsOut(
        items=[_leg_out(m, sample_by_id) for m in result.main[:limit]],
        extras=[_leg_out(m, sample_by_id) for m in result.extras[:limit]],
        last_trip_passed=list(result.last_trip_passed),
    )
