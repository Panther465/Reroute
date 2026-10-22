"""Finding a city to plan in: any city or town in India, by name or in a sentence that mentions one."""

from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Query

from app.deps import CurrentUser, Db
from app.schemas import CityOut
from app.services.cities import find_cities

router = APIRouter(prefix="/v1/cities", tags=["places"])


@router.get("", response_model=list[CityOut], response_model_by_alias=True, summary="Find a city in India by name, or in a sentence that mentions one")
def search(db: Db, user: CurrentUser, q: Annotated[str, Query(min_length=2, max_length=300)]) -> list[CityOut]:
    return [CityOut(slug=c.slug, name=c.name, state=c.state, sample=c.sample) for c in find_cities(db, q)]
