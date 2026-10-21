"""Finding places: the ones Reroute already knows first, then Nominatim, saving what it finds."""

from __future__ import annotations

from geoalchemy2.elements import WKTElement
from sqlalchemy import or_, select
from sqlalchemy.orm import Session

from app.adapters.places import NominatimSearch
from app.cities import city as supported_city
from app.models import Place
from app.redis_client import get_redis


def _rank(place: Place, text: str) -> int:
    """The exact name first, then names that start with the text, then names that contain it, then areas."""
    name, t = place.name.lower(), text.lower()
    return 0 if name == t else 1 if name.startswith(t) else 2 if t in name else 3


def find_places(db: Session, q: str, city_slug: str, limit: int = 8) -> list[Place]:
    where = supported_city(city_slug)
    text = q.strip()
    if where is None or len(text) < 2:
        return []
    like = f"%{text}%"
    matching = or_(Place.name.ilike(like), Place.area.ilike(like))
    known = list(db.scalars(select(Place).where(Place.city_slug == city_slug, matching).order_by(Place.sample.desc(), Place.name).limit(20)))
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
    return sorted(known, key=lambda p: _rank(p, text))[:limit]


def best_place(db: Session, place_text: str, city_slug: str) -> Place | None:
    """The likeliest place for free text such as "ITPL Road, Whitefield": its first part, searched."""
    words = (place_text or "").split(",")[0].strip()
    found = find_places(db, words, city_slug, limit=1)
    return found[0] if found else None
