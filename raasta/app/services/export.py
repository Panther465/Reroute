"""Load a city's verified routes and build its GTFS feed."""

from __future__ import annotations

from datetime import date

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.cities import city
from app.errors import not_found
from app.models import Route
from app.services.geo import LatLng
from app.services.gtfs import GtfsRoute, GtfsStand, build_gtfs
from app.services.timefmt import hhmm


def city_gtfs(session: Session, city_slug: str, today: date, agency_url: str) -> bytes:
    place = city(city_slug)
    if place is None:
        raise not_found("City")
    routes = session.scalars(select(Route).where(Route.city_slug == city_slug, Route.status == "verified").order_by(Route.route_id)).all()
    feed = [
        GtfsRoute(
            route_id=r.route_id,
            vehicle_type=r.vehicle_type,
            fare_inr=r.fare_inr,
            frequency_min=r.frequency_min,
            first_trip=hhmm(r.first_trip),
            last_trip=hhmm(r.last_trip),
            stands=tuple(GtfsStand(rs.stand_id, rs.stand.name, LatLng(rs.stand.lat, rs.stand.lng)) for rs in r.stands),
            path=tuple(LatLng(lat, lng) for lng, lat in (r.path_coords or [])),
        )
        for r in routes
    ]
    return build_gtfs(city_slug, place.name, feed, today, agency_url)
