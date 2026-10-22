"""The road path of a leg, for the map."""

from __future__ import annotations

from typing import Annotated, Literal

from fastapi import APIRouter, Query
from fastapi.concurrency import run_in_threadpool

from app.adapters.road_path import RoadPaths
from app.cities import covers
from app.deps import CurrentUser
from app.errors import ApiError
from app.redis_client import get_redis
from app.schemas import RoadPathOut

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
