"""Finding a city to plan in: any city or town in India, by name or in a sentence that mentions one, or from the
list of cities Reroute knows."""

from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Query

from app.cities import centre
from app.deps import CurrentUser, Db
from app.schemas import CityOut
from app.services.cities import CityChoice, every_city, find_cities

router = APIRouter(prefix="/v1/cities", tags=["places"])


def city_out(c: CityChoice) -> CityOut:
    if c.bbox is None:
        return CityOut(slug=c.slug, name=c.name, state=c.state, sample=c.sample)
    lng, lat = centre(c.bbox)
    return CityOut(slug=c.slug, name=c.name, state=c.state, sample=c.sample, lng=lng, lat=lat, bbox=list(c.bbox))


@router.get(
    "",
    response_model=list[CityOut],
    response_model_by_alias=True,
    summary="Find a city in India by name, or in a sentence that mentions one; without q, every city on Reroute's list",
)
def search(db: Db, user: CurrentUser, q: Annotated[str | None, Query(min_length=2, max_length=300)] = None) -> list[CityOut]:
    return [city_out(c) for c in (find_cities(db, q) if q is not None else every_city())]
