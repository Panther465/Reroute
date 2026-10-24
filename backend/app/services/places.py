"""Finding places: the ones Reroute already knows first, then Nominatim, saving what it finds. And the places
travellers add themselves: theirs alone, unless they share one and a moderator approves it for everyone.
"""

from __future__ import annotations

import math
from datetime import UTC, datetime

from geoalchemy2.elements import WKTElement
from sqlalchemy import ColumnElement, and_, case, exists, func, or_, select
from sqlalchemy.orm import Session

from app.adapters.places import NominatimSearch
from app.cities import City
from app.cities import city as supported_city
from app.errors import ApiError
from app.india import in_india
from app.models import Place, Task, Trip, User, new_id
from app.redis_client import get_redis
from app.schemas import OwnPlaceIn

#: The most places one traveller keeps.
MAX_OWN = 200
#: A place a traveller adds takes its area's name from the nearest place Reroute knows within this many
#: degrees (about 3 km), else the city's.
NEAR = 0.03
#: A place its owner asked to share is in one of these, and a moderator can move it between them.
SHARED = ("pending", "approved", "rejected")


def visible(user_id: str | None) -> ColumnElement[bool]:
    """Places a traveller may find: every place Reroute knows, their own, and others' a moderator approved."""
    seen = or_(Place.status.is_(None), Place.status == "approved")
    return or_(seen, and_(Place.owner_id == user_id, Place.status != "deleted")) if user_id else seen


def can_see(place: Place, user_id: str | None) -> bool:
    """The same rule, for one place in hand."""
    return place.status in (None, "approved") or (user_id is not None and place.owner_id == user_id and place.status != "deleted")


def _rank(place: Place, text: str) -> int:
    """The exact name first, then names that start with the text, then names that contain it, then areas."""
    name, t = place.name.lower(), text.lower()
    return 0 if name == t else 1 if name.startswith(t) else 2 if t in name else 3


def find_places(db: Session, q: str, city_slug: str, limit: int = 8, user_id: str | None = None) -> list[Place]:
    """Places in the city matching the text, the traveller's own first."""
    where = supported_city(city_slug)
    text = q.strip()
    if where is None or len(text) < 2:
        return []
    like = f"%{text}%"
    matching = or_(Place.name.ilike(like), Place.area.ilike(like))
    own_first = [case((Place.owner_id == user_id, 0), else_=1)] if user_id else []
    query = select(Place).where(Place.city_slug == city_slug, matching, visible(user_id))
    known = list(db.scalars(query.order_by(*own_first, Place.sample.desc(), Place.name).limit(20)))
    if len(known) < 3:
        for found in NominatimSearch(get_redis()).search(text, where):
            if any(p.place_id == found.place_id for p in known) or not where.contains(found.lng, found.lat):
                continue
            place = db.get(Place, found.place_id)
            if place is None:
                place = Place(
                    place_id=found.place_id,
                    city_slug=city_slug,
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
    return sorted(known, key=lambda p: (p.owner_id is None or p.owner_id != user_id, _rank(p, text)))[:limit]


def best_place(db: Session, place_text: str, city_slug: str, user_id: str | None = None) -> Place | None:
    """The likeliest place for free text such as "ITPL Road, Whitefield": its first part, searched."""
    words = (place_text or "").split(",")[0].strip()
    found = find_places(db, words, city_slug, limit=1, user_id=user_id)
    return found[0] if found else None


# ---------- places travellers add ----------


def _area_near(db: Session, where: City, lng: float, lat: float) -> str:
    """The area of the nearest place Reroute knows, such as "Koramangala", else the city's name."""
    rows = db.execute(
        select(Place.area, Place.lng, Place.lat).where(
            Place.city_slug == where.slug, Place.status.is_(None), Place.lng.between(lng - NEAR, lng + NEAR), Place.lat.between(lat - NEAR, lat + NEAR)
        )
    ).all()
    squash = math.cos(math.radians(lat)) ** 2
    nearest = min(rows, key=lambda r: (r.lng - lng) ** 2 * squash + (r.lat - lat) ** 2, default=None)
    return nearest.area if nearest else where.name


def add_own(db: Session, user_id: str, body: OwnPlaceIn) -> Place:
    """A place of the traveller's own, in the city they're planning in. Private unless they ask to share it."""
    if not in_india(body.lng, body.lat):
        raise ApiError(422, "That point is outside India. Reroute plans trips in India only.", code="VALIDATION_ERROR")
    where = supported_city(body.city_slug)
    if where is None:
        raise ApiError(422, "Reroute doesn't cover that city yet.", code="VALIDATION_ERROR")
    if not where.contains(body.lng, body.lat):
        raise ApiError(422, f"That point is outside {where.name}. Add places in the city you're planning in.", code="VALIDATION_ERROR")
    # Lock the traveller so two places added at once can't both get past the limit.
    db.execute(select(User.user_id).where(User.user_id == user_id).with_for_update())
    kept = db.scalar(select(func.count()).select_from(Place).where(Place.owner_id == user_id, Place.status != "deleted")) or 0
    if kept >= MAX_OWN:
        raise ApiError(409, f"You have {MAX_OWN} places, the most Reroute keeps. Delete one to add another.", code="TOO_MANY_PLACES")
    place = Place(
        place_id=new_id("own"),
        city_slug=where.slug,
        name=body.name,
        area=_area_near(db, where, body.lng, body.lat)[:120],
        lng=body.lng,
        lat=body.lat,
        location=WKTElement(f"POINT({body.lng} {body.lat})", srid=4326),
        owner_id=user_id,
        category=body.category,
        note=body.note or None,
        status="pending" if body.share else "private",
    )
    db.add(place)
    db.flush()
    return place


def own_places(db: Session, user_id: str, city_slug: str | None = None) -> list[Place]:
    """The traveller's places, newest first."""
    query = select(Place).where(Place.owner_id == user_id, Place.status != "deleted")
    if city_slug:
        query = query.where(Place.city_slug == city_slug)
    return list(db.scalars(query.order_by(Place.created_at.desc(), Place.place_id).limit(MAX_OWN)))


def _in_use(db: Session, place_id: str) -> bool:
    """Whether a task or a trip's stay goes there, anyone's."""
    return bool(db.scalar(select(or_(exists().where(Task.place_id == place_id), exists().where(Trip.stay_place_id == place_id)))))


def delete_own(db: Session, user_id: str, place_id: str) -> None:
    """Delete one of the traveller's places. If a trip goes there (theirs, or anyone's once it was shared),
    the trip keeps it until nothing goes there any more: it leaves search, the map and their places, and its
    note goes at once."""
    place = db.get(Place, place_id)
    # Same answer for "missing" and "not yours", so place IDs can't be probed.
    if place is None or place.owner_id != user_id or place.status == "deleted":
        raise ApiError(404, "Place not found.")
    if _in_use(db, place_id):
        place.status, place.note = "deleted", None
    else:
        db.delete(place)
    db.flush()


def release(db: Session, place_id: str) -> None:
    """A task moved elsewhere or removed: a place its owner deleted goes for good once nothing goes there."""
    place = db.get(Place, place_id)
    if place is not None and place.status == "deleted" and not _in_use(db, place_id):
        db.delete(place)
        db.flush()


# ---------- moderation ----------


def shared_places(db: Session, status: str = "pending", limit: int = 100) -> list[Place]:
    """Places travellers asked to share, oldest first: the moderators' queue."""
    return list(db.scalars(select(Place).where(Place.status == status).order_by(Place.created_at, Place.place_id).limit(limit)))


def review(db: Session, moderator_id: str, place_id: str, approve: bool, reason: str | None = None) -> Place:
    """A moderator's decision on a shared place. They can change their mind later; never about their own."""
    place = db.get(Place, place_id)
    # A place nobody asked to share is nobody else's business: it isn't found.
    if place is None or place.status not in SHARED:
        raise ApiError(404, "Place not found.")
    if place.owner_id == moderator_id:
        raise ApiError(403, "Another moderator checks the places you add.")
    place.status = "approved" if approve else "rejected"
    place.reject_reason = None if approve else reason
    place.reviewed_by, place.reviewed_at = moderator_id, datetime.now(UTC)
    db.flush()
    return place
