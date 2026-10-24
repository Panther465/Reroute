"""Places: search for the task form (known places first, then Nominatim), the places travellers add
themselves, and the moderators' check before a shared one shows to everyone."""

from __future__ import annotations

import time
from typing import Annotated, Literal

import redis
from fastapi import APIRouter, Path, Query, Response

from app.cities import city as supported_city
from app.deps import CurrentUser, Db, Moderator
from app.errors import ApiError
from app.models import Place
from app.redis_client import get_redis
from app.schemas import OwnPlaceIn, OwnPlaceOut, PlaceOut, PlaceRejectIn, PlaceReviewOut, PostBody
from app.services import places
from app.services.views import place_out

router = APIRouter(prefix="/v1", tags=["places"])

CITY = r"^[a-z][a-z0-9-]{1,39}$"
#: Places one traveller can add a day, besides the limit on every request: a moderator's queue stays readable.
ADDS_PER_DAY = 50


@router.get("/places", response_model=list[PlaceOut], response_model_by_alias=True, summary="Search places in a city")
def search(
    db: Db,
    user: CurrentUser,
    q: Annotated[str, Query(min_length=2, max_length=80)],
    city: Annotated[str, Query(pattern=CITY)] = "bengaluru",
    city_name: Annotated[str | None, Query(alias="cityName", max_length=80, deprecated=True, description="Ignored: the server knows each city's name.")] = None,
) -> list[PlaceOut]:
    if supported_city(city) is None:
        raise ApiError(422, "Reroute doesn't cover that city yet.", code="VALIDATION_ERROR")
    return [place_out(p, user.user_id) for p in places.find_places(db, q, city, user_id=user.user_id)]


# ---------- your own places ----------


def _own_out(place: Place) -> OwnPlaceOut:
    return OwnPlaceOut(
        place_id=place.place_id,
        name=place.name,
        area=place.area,
        lng=place.lng,
        lat=place.lat,
        category=place.category,  # type: ignore[arg-type]
        city_slug=place.city_slug,
        note=place.note,
        status=place.status,  # type: ignore[arg-type]
        reject_reason=place.reject_reason,
        created_at=place.created_at,
    )


def _within_daily_limit(user_id: str) -> None:
    r = get_redis()
    key = f"places:add:{user_id}:{time.strftime('%Y-%m-%d', time.gmtime())}"
    try:
        used = r.incr(key)
        if used == 1:
            r.expire(key, 25 * 3600)
    except redis.RedisError:
        # Without Redis the day's count can't be kept; the cap on places still holds.
        return
    if used > ADDS_PER_DAY:
        retry = str(24 * 3600 - int(time.time()) % (24 * 3600))
        raise ApiError(429, f"You can add {ADDS_PER_DAY} places a day. Try again tomorrow.", code="RATE_LIMITED", headers={"Retry-After": retry})


@router.post("/me/places", response_model=OwnPlaceOut, response_model_by_alias=True, status_code=201, summary="Add a place of your own in a city")
def add_place(body: OwnPlaceIn, user: CurrentUser, db: Db) -> OwnPlaceOut:
    """Only you see it. With `share`, a moderator checks it, and then everyone can find it (never its note)."""
    _within_daily_limit(user.user_id)
    place = places.add_own(db, user.user_id, body)
    db.commit()
    return _own_out(place)


@router.get("/me/places", response_model=list[OwnPlaceOut], response_model_by_alias=True, summary="Your places, newest first")
def my_places(user: CurrentUser, db: Db, city: Annotated[str | None, Query(pattern=CITY)] = None) -> list[OwnPlaceOut]:
    return [_own_out(p) for p in places.own_places(db, user.user_id, city)]


@router.delete("/me/places/{place_id}", status_code=204, summary="Delete one of your places")
def delete_place(user: CurrentUser, db: Db, place_id: str = Path(max_length=80)) -> Response:
    """A trip that already goes there keeps it; it leaves your places, search and the map, and its note goes."""
    places.delete_own(db, user.user_id, place_id)
    db.commit()
    return Response(status_code=204)


# ---------- the moderators' check ----------


def _review_out(place: Place) -> PlaceReviewOut:
    where = supported_city(place.city_slug)
    return PlaceReviewOut(
        place_id=place.place_id,
        name=place.name,
        area=place.area,
        lng=place.lng,
        lat=place.lat,
        category=place.category,  # type: ignore[arg-type]
        city_slug=place.city_slug,
        city_name=where.name if where else place.city_slug,
        status=place.status,  # type: ignore[arg-type]
        reject_reason=place.reject_reason,
        added_by=place.owner_id,
        created_at=place.created_at,
        reviewed_at=place.reviewed_at,
    )


@router.get("/places/review", response_model=list[PlaceReviewOut], response_model_by_alias=True, summary="Places travellers shared, for moderators to check")
def review_queue(moderator: Moderator, db: Db, status: Literal["pending", "approved", "rejected"] = "pending") -> list[PlaceReviewOut]:
    return [_review_out(p) for p in places.shared_places(db, status)]


@router.post("/places/{place_id}/approve", response_model=PlaceReviewOut, response_model_by_alias=True, summary="Show a shared place to everyone (moderators)")
def approve(body: PostBody, moderator: Moderator, db: Db, place_id: str = Path(max_length=80)) -> PlaceReviewOut:
    place = places.review(db, moderator.user_id, place_id, approve=True)
    db.commit()
    return _review_out(place)


@router.post("/places/{place_id}/reject", response_model=PlaceReviewOut, response_model_by_alias=True, summary="Don't share a place (moderators)")
def reject(body: PlaceRejectIn, moderator: Moderator, db: Db, place_id: str = Path(max_length=80)) -> PlaceReviewOut:
    place = places.review(db, moderator.user_id, place_id, approve=False, reason=body.reason)
    db.commit()
    return _review_out(place)
