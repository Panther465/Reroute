"""The road path of a leg, for the map, and which map the app draws under it."""

from __future__ import annotations

from datetime import UTC, datetime
from typing import Annotated, Literal
from urllib.parse import quote

from fastapi import APIRouter, Query
from fastapi.concurrency import run_in_threadpool

from app.adapters import google_maps
from app.adapters.road_path import RoadPaths
from app.cities import covers
from app.config import get_settings
from app.deps import CurrentUser
from app.errors import ApiError
from app.redis_client import get_redis
from app.schemas import MapTilesOut, RoadPathOut

router = APIRouter(prefix="/v1", tags=["maps"])

LNG_LAT = r"^-?\d{1,3}(\.\d{1,8})?,-?\d{1,2}(\.\d{1,8})?$"


def _point(text: str) -> tuple[float, float]:
    lng, lat = (float(x) for x in text.split(","))
    # Only places in a city Reroute covers: this isn't a general routing proxy.
    if not covers(lng, lat):
        raise ApiError(422, "That place is outside the cities Reroute covers.", code="VALIDATION_ERROR")
    return lng, lat


@router.get("/road-path", response_model=RoadPathOut, response_model_by_alias=True, summary="A leg's path along the roads, for the map")
async def road_path(
    user: CurrentUser,
    from_: Annotated[str, Query(alias="from", pattern=LNG_LAT, description="lng,lat")],
    to: Annotated[str, Query(pattern=LNG_LAT, description="lng,lat")],
    profile: Literal["driving", "foot"] = "driving",
) -> RoadPathOut:
    a, b = _point(from_), _point(to)
    # The lookup blocks (OSRM allows one request a second), so it runs off the event loop.
    path = await run_in_threadpool(lambda: RoadPaths(get_redis()).get(a, b, profile))
    return RoadPathOut(coords=[list(c) for c in path.coords], distance_m=path.distance_m, duration_s=path.duration_s, source=path.source)


@router.get("/maps/tiles", response_model=MapTilesOut, response_model_by_alias=True, summary="Which map the app draws: Google's, or OpenStreetMap's")
async def map_tiles(user: CurrentUser) -> MapTilesOut:
    """Google's roadmap (light and dark) with a Google Maps key, as tile addresses for the app's map and where its
    copyright line comes from; OpenStreetMap's (OpenFreeMap) without one, or when Google can't start a session."""
    if not google_maps.enabled():
        return MapTilesOut(provider="open")
    try:
        light, dark = await run_in_threadpool(lambda: (google_maps.tile_session(False), google_maps.tile_session(True)))
    except google_maps.GoogleUnavailable:
        return MapTilesOut(provider="open")
    s = get_settings()
    key = quote(s.google_maps_browser_key or s.google_maps_api_key, safe="")
    base = google_maps.TILES

    def tiles(session: str) -> str:
        return f"{base}/v1/2dtiles/{{z}}/{{x}}/{{y}}?session={quote(session, safe='')}&key={key}"

    def viewport(session: str) -> str:
        return f"{base}/tile/v1/viewport?session={quote(session, safe='')}&key={key}"

    return MapTilesOut(
        provider="google",
        tiles_url=tiles(light.session),
        dark_tiles_url=tiles(dark.session),
        viewport_url=viewport(light.session),
        dark_viewport_url=viewport(dark.session),
        expires_at=datetime.fromtimestamp(min(light.expires_at, dark.expires_at) - google_maps.SESSION_MARGIN_S, UTC),
    )
