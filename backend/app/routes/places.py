"""Place search for the task form: known places first, then Nominatim."""

from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Query

from app.cities import city as supported_city
from app.deps import CurrentUser, Db
from app.errors import ApiError
from app.schemas import PlaceOut
from app.services.places import find_places
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
    if supported_city(city) is None:
        raise ApiError(422, "Reroute doesn't cover that city yet.", code="VALIDATION_ERROR")
    return [place_out(p) for p in find_places(db, q, city)]
