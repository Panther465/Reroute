"""Cities Reroute plans in.

Bengaluru is built in, with sample places, travel times, the metro and shared autos. Every other city on the
built-in list of Indian cities (app/india.py) comes with its centre and area from examples/india-cities.json,
looked up once from OpenStreetMap, so planning there starts at once. Any other town in India joins the first
time someone picks it (services/cities.py): its area comes from OpenStreetMap and is kept in the cities
table. Travel outside Bengaluru is rough cab and walk estimates. Place search and new trips stay inside a
city's area (section 15.1: coordinates inside the city).
"""

from __future__ import annotations

import json
import logging
import re
import unicodedata
from dataclasses import dataclass
from functools import lru_cache

from app.config import get_settings
from app.india import CITIES as INDIA

log = logging.getLogger("reroute.cities")

#: An area is at least this many degrees either side of the centre (about 22 km), at most 0.6, and reaches 0.08
#: past OpenStreetMap's outline of the city.
MIN_HALF, MAX_HALF, MARGIN = 0.2, 0.6, 0.08


@dataclass(frozen=True)
class City:
    slug: str
    name: str
    utc_offset: str
    #: west, south, east, north
    bbox: tuple[float, float, float, float]
    state: str | None = None
    #: Sample places, travel times and shared autos. Elsewhere, rough cab and walk estimates.
    sample: bool = False

    def contains(self, lng: float, lat: float) -> bool:
        west, south, east, north = self.bbox
        return west <= lng <= east and south <= lat <= north


def centre(bbox: tuple[float, float, float, float]) -> tuple[float, float]:
    """lng, lat: the middle of a city's area, which is centred on the city."""
    west, south, east, north = bbox
    return (round((west + east) / 2, 5), round((south + north) / 2, 5))


def plain(text: str) -> str:
    """Lower case, no accents: letters, digits and single spaces."""
    t = unicodedata.normalize("NFKD", text).encode("ascii", "ignore").decode().lower()
    return " ".join(re.sub(r"[^a-z0-9]+", " ", t).split())


def slugify(text: str) -> str:
    s = plain(text).replace(" ", "-")
    return (s if s[:1].isalpha() else f"c-{s}")[:40].rstrip("-")


def area(lng: float, lat: float, outline: tuple[float, float, float, float]) -> tuple[float, float, float, float]:
    """OpenStreetMap's outline of a city with a margin, centred on the city, at least about 22 km either way."""
    west, south, east, north = outline
    half_lat = min(max((north - south) / 2 + MARGIN, MIN_HALF), MAX_HALF)
    half_lng = min(max((east - west) / 2 + MARGIN, MIN_HALF), MAX_HALF)
    return (round(lng - half_lng, 5), round(lat - half_lat, 5), round(lng + half_lng, 5), round(lat + half_lat, 5))


CITIES: dict[str, City] = {
    # Bruhat Bengaluru Mahanagara Palike area with a margin for Whitefield and Electronic City.
    "bengaluru": City("bengaluru", "Bengaluru", "+05:30", (77.35, 12.75, 77.90, 13.20), state="Karnataka", sample=True),
}

#: Cities read from the database before. A city's area never changes, so each API copy keeps it once read.
_kept: dict[str, City] = {}


@lru_cache(maxsize=1)
def listed_cities() -> dict[str, City]:
    """Every city on the built-in list with its area, by slug, from examples/india-cities.json. A city the
    file doesn't have is looked up when it's first picked, like any other town."""
    path = get_settings().examples_dir / "india-cities.json"
    try:
        rows = {(c["name"], c["state"]): c for c in json.loads(path.read_text(encoding="utf-8"))["cities"]}
    except (OSError, ValueError, KeyError) as exc:
        log.warning("Couldn't read the cities file %s: %s", path, exc)
        return {}
    out: dict[str, City] = {}
    for name, state, _ in INDIA:
        row, slug = rows.get((name, state)), slugify(name)
        if row is not None and slug not in CITIES:
            out[slug] = City(slug, name, "+05:30", (row["west"], row["south"], row["east"], row["north"]), state=state)
    return out


def city(slug: str) -> City | None:
    """A built-in city, one on the list of Indian cities, or a town someone picked before. A town nobody has
    picked yet is looked up now."""
    found = CITIES.get(slug) or listed_cities().get(slug) or _kept.get(slug)
    if found is None:
        from app.services.cities import kept_or_looked_up  # the service imports this module

        found = kept_or_looked_up(slug)
        if found is not None:
            _kept[slug] = found
    return found


def covers(lng: float, lat: float) -> bool:
    """Whether a point is inside a city Reroute plans in."""
    if any(c.contains(lng, lat) for c in (*CITIES.values(), *listed_cities().values(), *_kept.values())):
        return True
    from app.services.cities import a_kept_city_covers

    return a_kept_city_covers(lng, lat)
