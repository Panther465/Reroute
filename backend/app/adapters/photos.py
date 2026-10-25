"""Photos of a place, for Rico to show while he talks about it: Wikimedia Commons' own search, free and keyless.

Only photographs come back (no maps, plans, logos, flags or drawings), as pictures 800 px wide, each with who took
it and its licence: Commons' photos may be shown with that credit, which the app puts under each one. A place's
photos are kept 7 days in Redis (finding none, a day). Nothing here raises: a search that fails finds no photos, and
Commons is left alone for a while, as the guide's sources are.
"""

from __future__ import annotations

import html
import json
import re
from dataclasses import asdict, dataclass

import httpx

from app.adapters.guide import _cached, _call, _keep

COMMONS_URL = "https://commons.wikimedia.org/w/api.php"
TIMEOUT = httpx.Timeout(8.0, connect=4.0)
PHOTOS_SECONDS = 7 * 24 * 3600
NONE_SECONDS = 24 * 3600
#: Photos shown at most, from the first this many search results.
MOST = 8
SEARCHED = 24
#: Not a photograph of the place: maps, plans, drawings, logos, flags, seals and the like.
NOT_A_PHOTO = re.compile(r"\b(maps?|plan|locator|location|diagram|logo|flag|seal|emblem|coat of arms|icon|chart|drawing|sketch|stamp)\b", re.I)
PICTURES = ("image/jpeg", "image/png", "image/webp")


@dataclass(frozen=True)
class Photo:
    #: The picture itself, full size.
    url: str
    #: The picture 800 px wide, for the screen.
    thumb_url: str
    #: What it shows, from its file name.
    title: str
    #: Who took it and its licence, shown under it.
    credit: str
    #: Its page on Commons.
    source_url: str


def _plain(value: str) -> str:
    return re.sub(r"\s+", " ", html.unescape(re.sub(r"<[^>]+>", " ", value or ""))).strip()


def _title(file: str) -> str:
    return re.sub(r"^File:|\.[A-Za-z0-9]+$", "", file).replace("_", " ").strip()


def search_text(place: str, city: str | None) -> str:
    """What Commons is asked for: the place, and its city unless the name says it already."""
    place = place.strip()
    return f"{place} {city.strip()}" if city and city.strip() and city.strip().lower() not in place.lower() else place


async def place_photos(place: str, city: str | None = None, client: httpx.AsyncClient | None = None) -> list[Photo]:
    """Up to MOST photographs of `place` (in `city`), best match first; none when Commons has none or can't answer."""
    query = search_text(place, city)
    key = "photos:" + query.lower()
    cached = _cached(key)
    if cached is not None:
        return [Photo(**p) for p in json.loads(cached)]
    params = {
        "action": "query",
        "format": "json",
        "formatversion": "2",
        "generator": "search",
        "gsrsearch": f"{query} filetype:bitmap",
        "gsrnamespace": "6",
        "gsrlimit": str(SEARCHED),
        "prop": "imageinfo",
        "iiprop": "url|extmetadata|mime|size",
        "iiurlwidth": "800",
        "iiextmetadatafilter": "Artist|LicenseShortName",
    }
    res = await _call("Wikimedia Commons", "GET", COMMONS_URL, TIMEOUT, client, params=params)
    if res is None:
        return []
    try:
        pages = res.json().get("query", {}).get("pages", [])
    except ValueError:
        return []
    found: list[Photo] = []
    for page in sorted(pages, key=lambda p: p.get("index", 0)):
        info = (page.get("imageinfo") or [{}])[0]
        title = _title(page.get("title", ""))
        thumb = info.get("thumburl") or ""
        # Photos big enough to fill the screen; no maps, logos or drawings.
        if info.get("mime") not in PICTURES or info.get("width", 0) < 600 or info.get("height", 0) < 400 or not thumb or NOT_A_PHOTO.search(title):
            continue
        meta = info.get("extmetadata") or {}
        author = _plain((meta.get("Artist") or {}).get("value", ""))[:60] or "unknown"
        licence = _plain((meta.get("LicenseShortName") or {}).get("value", ""))
        credit = f"Photo: {author}{f', {licence}' if licence else ''}, Wikimedia Commons"
        found.append(Photo(url=info.get("url") or thumb, thumb_url=thumb, title=title, credit=credit, source_url=info.get("descriptionurl") or ""))
        if len(found) == MOST:
            break
    _keep(key, json.dumps([asdict(p) for p in found]), PHOTOS_SECONDS if found else NONE_SECONDS)
    return found
