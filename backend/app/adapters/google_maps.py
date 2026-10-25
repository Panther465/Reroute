"""Google Maps Platform, with GOOGLE_MAPS_API_KEY: Google's map for the app (Map Tiles API sessions), and Google's
places (Places API (New)): search, the details Rico's guide shows (rating, opening hours, a photo with its author)
and places nearby. Without a key nothing here is used, and Reroute keeps OpenStreetMap's.

Google's terms shape what's kept: a place's ID may be kept, its coordinates up to 30 days and nothing else, so no
place content is cached here (the app saves the places a traveller picks, like any place); a tile session is reused
until it expires, as Google asks. Whatever goes wrong comes back as GoogleUnavailable, and the caller falls back to
OpenStreetMap's.
"""

from __future__ import annotations

import hashlib
import json
import logging
import re
import time
from dataclasses import dataclass
from datetime import datetime, tzinfo
from typing import Any
from zoneinfo import ZoneInfo

import httpx

from app.adapters.places import FoundPlace
from app.adapters.road_path import metres
from app.cities import City
from app.config import get_settings
from app.redis_client import get_redis

log = logging.getLogger("reroute.google_maps")

TILES = "https://tile.googleapis.com"
PLACES = "https://places.googleapis.com/v1"
TIMEOUT = httpx.Timeout(8.0, connect=4.0)
#: A session's tiles are asked for again a day before Google says it expires.
SESSION_MARGIN_S = 24 * 3600
#: The ID Reroute gives a place Google found: "gpl-" and Google's own place ID.
PREFIX = "gpl-"

#: Google's map in Reroute's own colours (frontend/src/styles/tokens.css), so it looks like the rest of the app: the
#: page's pale sage for land, white roads edged like its cards, its green for parks, a soft blue for water, its
#: ink for labels; no shops (the routes and Rico's places are what matter). Label text always has both a fill and a
#: stroke, as Google asks.
LIGHT_STYLE: list[dict[str, Any]] = [
    {"elementType": "geometry", "stylers": [{"color": "#eef1ec"}]},
    {"elementType": "labels.text.fill", "stylers": [{"color": "#3d4757"}]},
    {"elementType": "labels.text.stroke", "stylers": [{"color": "#ffffff"}]},
    {"featureType": "administrative.locality", "elementType": "labels.text.fill", "stylers": [{"color": "#1a2230"}]},
    {"featureType": "administrative.neighborhood", "elementType": "labels.text.fill", "stylers": [{"color": "#566173"}]},
    {"featureType": "landscape.man_made", "elementType": "geometry", "stylers": [{"color": "#e6eae4"}]},
    {"featureType": "poi", "elementType": "geometry", "stylers": [{"color": "#e3e8e1"}]},
    {"featureType": "poi", "elementType": "labels.icon", "stylers": [{"saturation": -35}]},
    {"featureType": "poi.business", "stylers": [{"visibility": "off"}]},
    {"featureType": "poi.park", "elementType": "geometry", "stylers": [{"color": "#cfe8d6"}]},
    {"featureType": "poi.park", "elementType": "labels.text.fill", "stylers": [{"color": "#0a5c39"}]},
    {"featureType": "road", "elementType": "geometry.fill", "stylers": [{"color": "#ffffff"}]},
    {"featureType": "road", "elementType": "geometry.stroke", "stylers": [{"color": "#d5dbd3"}]},
    {"featureType": "road.highway", "elementType": "geometry.fill", "stylers": [{"color": "#f8ecc4"}]},
    {"featureType": "road.highway", "elementType": "geometry.stroke", "stylers": [{"color": "#e2cf8f"}]},
    {"featureType": "transit", "elementType": "geometry", "stylers": [{"color": "#cdd5cc"}]},
    {"featureType": "water", "elementType": "geometry", "stylers": [{"color": "#c4d5ef"}]},
    {"featureType": "water", "elementType": "labels.text.fill", "stylers": [{"color": "#36589c"}]},
    {"featureType": "water", "elementType": "labels.text.stroke", "stylers": [{"color": "#ffffff"}]},
]

#: The same at night, in Reroute's dark colours: its blue-black page, dark green parks, navy water.
DARK_STYLE: list[dict[str, Any]] = [
    {"elementType": "geometry", "stylers": [{"color": "#141b25"}]},
    {"elementType": "labels.text.fill", "stylers": [{"color": "#9aa5b3"}]},
    {"elementType": "labels.text.stroke", "stylers": [{"color": "#10161f"}]},
    {"featureType": "administrative.locality", "elementType": "labels.text.fill", "stylers": [{"color": "#c3cbd5"}]},
    {"featureType": "administrative.neighborhood", "elementType": "labels.text.fill", "stylers": [{"color": "#7f8a99"}]},
    {"featureType": "landscape.man_made", "elementType": "geometry", "stylers": [{"color": "#18202b"}]},
    {"featureType": "poi", "elementType": "geometry", "stylers": [{"color": "#18202b"}]},
    {"featureType": "poi", "elementType": "labels.icon", "stylers": [{"saturation": -55}, {"lightness": -15}]},
    {"featureType": "poi.business", "stylers": [{"visibility": "off"}]},
    {"featureType": "poi.park", "elementType": "geometry", "stylers": [{"color": "#143127"}]},
    {"featureType": "poi.park", "elementType": "labels.text.fill", "stylers": [{"color": "#6fcf9f"}]},
    {"featureType": "road", "elementType": "geometry.fill", "stylers": [{"color": "#283342"}]},
    {"featureType": "road", "elementType": "geometry.stroke", "stylers": [{"color": "#10161f"}]},
    {"featureType": "road.highway", "elementType": "geometry.fill", "stylers": [{"color": "#3b4757"}]},
    {"featureType": "road.highway", "elementType": "geometry.stroke", "stylers": [{"color": "#10161f"}]},
    {"featureType": "transit", "elementType": "geometry", "stylers": [{"color": "#222b37"}]},
    {"featureType": "water", "elementType": "geometry", "stylers": [{"color": "#0d1e33"}]},
    {"featureType": "water", "elementType": "labels.text.fill", "stylers": [{"color": "#7096ff"}]},
    {"featureType": "water", "elementType": "labels.text.stroke", "stylers": [{"color": "#0d1e33"}]},
]

#: Google's place types for what Rico looks for nearby: sights, things to do, places to eat.
NEARBY_TYPES = {
    "see": ["tourist_attraction", "museum", "art_gallery"],
    "do": ["park", "zoo", "amusement_park", "aquarium"],
    "eat": ["restaurant", "cafe"],
}
NEARBY_RADIUS_M = {"see": 6000.0, "do": 6000.0, "eat": 1500.0}
#: Rated this many times or more: a well-known place.
WELL_KNOWN_RATINGS = 1000


class GoogleUnavailable(Exception):
    """No key, a refusal, or no answer: the caller uses OpenStreetMap's instead."""


def enabled() -> bool:
    return bool(get_settings().google_maps_api_key)


def _key() -> str:
    key = get_settings().google_maps_api_key
    if not key:
        raise GoogleUnavailable("no GOOGLE_MAPS_API_KEY")
    return key


def _refused(res: httpx.Response, what: str) -> GoogleUnavailable:
    try:
        status = res.json().get("error", {}).get("status", "")
    except ValueError:
        status = ""
    # The reason, never the key: an API not enabled for the key (PERMISSION_DENIED), no billing, or the quota.
    log.warning("Google %s answered %s %s", what, res.status_code, status)
    return GoogleUnavailable(f"{what}: {res.status_code} {status}")


# ---------- the map's tiles ----------


@dataclass(frozen=True)
class TileSession:
    session: str
    expires_at: int


def session_body(dark: bool) -> dict[str, Any]:
    """What a tiles session is asked for: Google's roadmap in Reroute's colours (dark: its night ones), English labels
    (Google adds the local script's names where it has them), at twice the pixels for phones."""
    return {
        "mapType": "roadmap",
        "language": "en",
        "region": "IN",
        "scale": "scaleFactor2x",
        "highDpi": True,
        "styles": DARK_STYLE if dark else LIGHT_STYLE,
    }


def tile_session(dark: bool, client: httpx.Client | None = None) -> TileSession:
    """A Map Tiles API session for Google's roadmap in Reroute's colours (dark: its night ones), reused until a day
    before it expires: the same session serves every traveller, as Google allows. A changed style is a new session."""
    body = session_body(dark)
    look = hashlib.sha256(json.dumps(body, sort_keys=True).encode()).hexdigest()[:10]
    cache = f"gmaps:tiles:{'dark' if dark else 'light'}:{look}"
    r = get_redis()
    kept = r.get(cache)
    if kept:
        found = json.loads(kept)
        return TileSession(found["session"], int(found["expires_at"]))
    try:
        if client is None:
            with httpx.Client(timeout=TIMEOUT) as own:
                res = own.post(f"{TILES}/v1/createSession", params={"key": _key()}, json=body)
        else:
            res = client.post(f"{TILES}/v1/createSession", params={"key": _key()}, json=body)
    except httpx.HTTPError as exc:
        raise GoogleUnavailable("Map Tiles: no answer") from exc
    if res.status_code != 200:
        raise _refused(res, "Map Tiles")
    data = res.json()
    session = TileSession(str(data["session"]), int(data["expiry"]))
    keep_s = session.expires_at - int(time.time()) - SESSION_MARGIN_S
    if keep_s > 60:
        r.set(cache, json.dumps({"session": session.session, "expires_at": session.expires_at}), ex=keep_s)
    return session


# ---------- places ----------


def _area(place: dict[str, Any], city: str) -> str:
    """The neighbourhood a place is in, as Google names it ("Koramangala"), else the start of its short address."""
    for kind in ("sublocality_level_1", "sublocality", "neighborhood", "locality"):
        for part in place.get("addressComponents", []):
            if kind in part.get("types", []):
                name = part.get("longText") or part.get("shortText") or ""
                if name and name.lower() != city.lower():
                    return name
    short = place.get("shortFormattedAddress") or place.get("formattedAddress") or ""
    parts = [p.strip() for p in short.split(",") if p.strip() and p.strip().lower() != city.lower()]
    return parts[-1] if parts else city


def search_places(query: str, where: City, client: httpx.Client | None = None) -> list[FoundPlace]:
    """Up to five places matching the text inside the city's box, Google's best first (Text Search, Pro fields)."""
    west, south, east, north = where.bbox
    body = {
        "textQuery": query.strip(),
        "languageCode": "en",
        "regionCode": "IN",
        "pageSize": 5,
        "locationRestriction": {"rectangle": {"low": {"latitude": south, "longitude": west}, "high": {"latitude": north, "longitude": east}}},
    }
    fields = "places.id,places.displayName,places.location,places.shortFormattedAddress,places.formattedAddress,places.addressComponents"
    headers = {"X-Goog-Api-Key": _key(), "X-Goog-FieldMask": fields}
    try:
        if client is None:
            with httpx.Client(timeout=TIMEOUT) as own:
                res = own.post(f"{PLACES}/places:searchText", json=body, headers=headers)
        else:
            res = client.post(f"{PLACES}/places:searchText", json=body, headers=headers)
    except httpx.HTTPError as exc:
        raise GoogleUnavailable("Places: no answer") from exc
    if res.status_code != 200:
        raise _refused(res, "Places search")
    found = []
    for p in res.json().get("places", []):
        at = p.get("location") or {}
        name = (p.get("displayName") or {}).get("text") or ""
        if not name or "latitude" not in at:
            continue
        found.append(
            FoundPlace(place_id=PREFIX + p["id"], name=name, area=_area(p, where.name), lng=float(at["longitude"]), lat=float(at["latitude"]), osm_id=None)
        )
    return found


@dataclass(frozen=True)
class GooglePlace:
    """What Rico's guide shows of a place from Google."""

    place_id: str
    name: str
    lat: float
    lng: float
    #: What it is, in Google's words ("Botanical garden").
    what: str | None
    rating: float | None
    ratings: int | None
    open_now: bool | None
    #: Today's opening hours, as Google writes them ("6:00 AM – 7:00 PM").
    today_hours: str | None
    maps_url: str | None
    photo_url: str | None
    #: Who took the photo, credited under it, and their Google Maps page.
    photo_author: str | None
    photo_author_url: str | None


_DETAILS = ",".join(
    f"places.{f}"
    for f in (
        "id",
        "displayName",
        "location",
        "primaryTypeDisplayName",
        "rating",
        "userRatingCount",
        "currentOpeningHours",
        "regularOpeningHours",
        "googleMapsUri",
        "photos",
    )
)


def _today(hours: dict[str, Any] | None, tz: tzinfo) -> str | None:
    """Today's line of Google's opening hours ("Monday: 9:00 AM – 5:00 PM", Monday first), without the day's name."""
    days = (hours or {}).get("weekdayDescriptions") or []
    if len(days) != 7:
        return None
    line = days[datetime.now(tz).weekday()]
    return re.sub(r"^[^:]+:\s*", "", line).replace(" ", " ").replace(" ", " ").strip() or None


async def place_details(
    name: str, city: str, near: tuple[float, float] | None, tz: tzinfo = ZoneInfo("Asia/Kolkata"), client: httpx.AsyncClient | None = None
) -> GooglePlace:
    """Google's place for a name Rico read elsewhere (the travel guide, OpenStreetMap), near where that put it: its
    rating, whether it's open, today's hours, a photo and its Google Maps page. One Text Search with the details
    asked for (Enterprise fields), then the photo's own address (Place Photos), which carries no key."""
    body: dict[str, Any] = {"textQuery": f"{name}, {city}", "languageCode": "en", "regionCode": "IN", "pageSize": 1}
    if near is not None:
        body["locationBias"] = {"circle": {"center": {"latitude": near[0], "longitude": near[1]}, "radius": 3000.0}}
    headers = {"X-Goog-Api-Key": _key(), "X-Goog-FieldMask": _DETAILS}
    own = client is None
    http = client or httpx.AsyncClient(timeout=TIMEOUT)
    try:
        res = await http.post(f"{PLACES}/places:searchText", json=body, headers=headers)
        if res.status_code != 200:
            raise _refused(res, "Places details")
        places = res.json().get("places") or []
        if not places:
            raise GoogleUnavailable(f"Google has no place for {name}")
        p = places[0]
        at = p.get("location") or {}
        if near is not None and "latitude" in at and metres((near[1], near[0]), (at["longitude"], at["latitude"])) > 5000:
            # Another place with the same name: not this one.
            raise GoogleUnavailable(f"Google's {name} is somewhere else")
        photo = (p.get("photos") or [None])[0]
        photo_url = author = author_url = None
        if photo and photo.get("name"):
            media = await http.get(
                f"{PLACES}/{photo['name']}/media", params={"maxWidthPx": 800, "skipHttpRedirect": "true"}, headers={"X-Goog-Api-Key": _key()}
            )
            if media.status_code == 200:
                photo_url = media.json().get("photoUri")
                who = (photo.get("authorAttributions") or [{}])[0]
                author, author_url = who.get("displayName"), who.get("uri")
        hours = p.get("currentOpeningHours") or p.get("regularOpeningHours")
        return GooglePlace(
            place_id=p["id"],
            name=(p.get("displayName") or {}).get("text") or name,
            lat=float(at.get("latitude", near[0] if near else 0.0)),
            lng=float(at.get("longitude", near[1] if near else 0.0)),
            what=(p.get("primaryTypeDisplayName") or {}).get("text"),
            rating=p.get("rating"),
            ratings=p.get("userRatingCount"),
            open_now=(p.get("currentOpeningHours") or {}).get("openNow"),
            today_hours=_today(hours, tz),
            maps_url=p.get("googleMapsUri"),
            photo_url=photo_url,
            photo_author=author,
            photo_author_url=author_url,
        )
    except httpx.HTTPError as exc:
        raise GoogleUnavailable("Places: no answer") from exc
    finally:
        if own:
            await http.aclose()


@dataclass(frozen=True)
class NearbyPlace:
    place_id: str
    name: str
    what: str
    lat: float
    lng: float
    metres: int
    rating: float | None
    ratings: int | None


async def places_nearby(lat: float, lng: float, kind: str, client: httpx.AsyncClient | None = None) -> list[NearbyPlace]:
    """Popular places of a kind ("see", "do", "eat") around a point, Google's best known first (Nearby Search)."""
    body = {
        "includedTypes": NEARBY_TYPES[kind],
        "maxResultCount": 10,
        "rankPreference": "POPULARITY",
        "languageCode": "en",
        "regionCode": "IN",
        "locationRestriction": {"circle": {"center": {"latitude": lat, "longitude": lng}, "radius": NEARBY_RADIUS_M[kind]}},
    }
    fields = "places.id,places.displayName,places.location,places.primaryTypeDisplayName,places.rating,places.userRatingCount"
    headers = {"X-Goog-Api-Key": _key(), "X-Goog-FieldMask": fields}
    own = client is None
    http = client or httpx.AsyncClient(timeout=TIMEOUT)
    try:
        res = await http.post(f"{PLACES}/places:searchNearby", json=body, headers=headers)
    except httpx.HTTPError as exc:
        raise GoogleUnavailable("Places: no answer") from exc
    finally:
        if own:
            await http.aclose()
    if res.status_code != 200:
        raise _refused(res, "Places nearby")
    found = []
    for p in res.json().get("places", []):
        at = p.get("location") or {}
        name = (p.get("displayName") or {}).get("text") or ""
        if not name or "latitude" not in at:
            continue
        found.append(
            NearbyPlace(
                place_id=p["id"],
                name=name,
                what=((p.get("primaryTypeDisplayName") or {}).get("text") or kind).lower(),
                lat=float(at["latitude"]),
                lng=float(at["longitude"]),
                metres=round(metres((lng, lat), (at["longitude"], at["latitude"]))),
                rating=p.get("rating"),
                ratings=p.get("userRatingCount"),
            )
        )
    return found
