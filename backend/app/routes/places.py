"""Place search for the task form: known places first, then Nominatim."""

from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Query
from geoalchemy2.elements import WKTElement
from sqlalchemy import or_, select

from app.adapters.places import NominatimSearch
from app.cities import city as supported_city
from app.deps import CurrentUser, Db
from app.errors import ApiError
from app.models import Place
from app.redis_client import get_redis
from app.schemas import PlaceOut
from app.services.views import place_out

router = APIRouter(prefix="/v1/places", tags=["places"])


@router.get("", response_model=list[PlaceOut], response_model_by_alias=True, summary="Search places in a city")
def search(
    db: Db,
    user: CurrentUser,
    q: Annotated[str, Query(min_length=2, max_length=80)],
    city: Annotated[str, Query(pattern=r"^[a-z][a-z0-9-]{1,39}$")] = "bengaluru",
    city_name: Annotated[str | None, Query(alias="cityName", max_length=80, deprecated=True, description="Ignored: the server knows each city's name.")] = None,
) -> list[PlaceOut]:
    where = supported_city(city)
    if where is None:
        raise ApiError(422, "Reroute doesn't cover that city yet.", code="VALIDATION_ERROR")
    like = f"%{q.strip()}%"
    known = list(
        db.scalars(
            select(Place).where(Place.city_slug == city, or_(Place.name.ilike(like), Place.area.ilike(like))).order_by(Place.sample.desc(), Place.name).limit(8)
        )
    )
    if len(known) >= 3:
        return [place_out(p) for p in known]
    for found in NominatimSearch(get_redis()).search(q, where):
        if any(p.place_id == found.place_id for p in known) or not where.contains(found.lng, found.lat):
            continue
        place = db.get(Place, found.place_id)
        if place is None:
            place = Place(
                place_id=found.place_id,
                city_slug=city,
                name=found.name[:200],
                area=found.area[:120],
                lng=found.lng,
                lat=found.lat,
                osm_id=found.osm_id,
                location=WKTElement(f"POINT({found.lng} {found.lat})", srid=4326),
            )
            db.add(place)
        known.append(place)
    db.commit()
    return [place_out(p) for p in known[:8]]
