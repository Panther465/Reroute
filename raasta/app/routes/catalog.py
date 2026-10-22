"""Public open-data reads: route options for a leg, one route, stands near a point, GTFS."""

from __future__ import annotations

from datetime import datetime

from fastapi import APIRouter, Depends, Query, Response
from sqlalchemy.orm import Session

from app.config import Settings, get_settings
from app.db import get_session
from app.pagination import Page, cursor_value
from app.ratelimit import per_minute_limit
from app.routes.deps import parse_lnglat, utc_now
from app.schemas import LegOptionsOut, RouteOut, StandNear
from app.schemas import Page as PageOut
from app.services import catalog
from app.services.export import city_gtfs
from app.services.timefmt import parse_offset

router = APIRouter(tags=["Routes and stands"], dependencies=[Depends(per_minute_limit)])


@router.get("/routes", response_model=LegOptionsOut, summary="Shared-auto options for one leg")
def leg_options(
    from_: str = Query(alias="from", description='Start as "lng,lat".', examples=["77.6195,12.9352"]),
    to: str = Query(description='Destination as "lng,lat".', examples=["77.5838,12.9255"]),
    at: datetime | None = Query(default=None, description="Departure time, ISO 8601. Defaults to now."),
    limit: int = Query(default=20, ge=1, le=100),
    session: Session = Depends(get_session),
    settings: Settings = Depends(get_settings),
    now: datetime = Depends(utc_now),
) -> LegOptionsOut:
    origin = parse_lnglat(from_, "from")
    dest = parse_lnglat(to, "to")
    when = at or now
    if when.tzinfo is None:
        when = when.replace(tzinfo=parse_offset(settings.city_utc_offset))
    return catalog.leg_options(session, origin, dest, when, now, settings, limit)


@router.get("/routes/{route_id}", response_model=RouteOut, summary="One route with its stands")
def get_route(route_id: str, session: Session = Depends(get_session), settings: Settings = Depends(get_settings), now: datetime = Depends(utc_now)) -> RouteOut:
    return catalog.route_out(session, catalog.get_route(session, route_id), settings, now)


@router.get("/stands", response_model=PageOut[StandNear], summary="Stands near a point")
def stands_near(
    near: str = Query(description='Centre as "lng,lat".', examples=["77.6195,12.9352"]),
    radius: int = Query(default=500, ge=10, le=5000, description="Metres."),
    page: Page = Depends(),
    session: Session = Depends(get_session),
) -> PageOut[StandNear]:
    centre = parse_lnglat(near, "near")
    offset = cursor_value(page.position, "o", int) if page.position else 0
    items, cursor = catalog.stands_near(session, centre.lng, centre.lat, radius, offset, page.limit)
    return PageOut[StandNear](items=items, next_cursor=cursor)


@router.get(
    "/cities/{slug}/gtfs.zip",
    response_class=Response,
    summary="Download the city's verified routes as GTFS",
    responses={200: {"content": {"application/zip": {}}, "description": "A GTFS feed of verified routes."}},
)
def gtfs(slug: str, session: Session = Depends(get_session), now: datetime = Depends(utc_now)) -> Response:
    data = city_gtfs(session, slug, now.date(), "https://github.com/Panther465/Reroute")
    return Response(
        content=data,
        media_type="application/zip",
        headers={"Content-Disposition": f'attachment; filename="raasta-{slug}-gtfs.zip"', "Cache-Control": "public, max-age=300"},
    )
