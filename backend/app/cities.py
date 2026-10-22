"""Cities Reroute plans in.

Bengaluru is built in, with sample places, travel times, the metro and shared autos. Any other city or
town in India joins the first time someone picks it (services/cities.py): its area comes from
OpenStreetMap and is kept in the cities table, and travel there is rough cab and walk estimates. Place
search and new trips stay inside a city's area (section 15.1: coordinates inside the city).
"""

from __future__ import annotations

from dataclasses import dataclass


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


CITIES: dict[str, City] = {
    # Bruhat Bengaluru Mahanagara Palike area with a margin for Whitefield and Electronic City.
    "bengaluru": City("bengaluru", "Bengaluru", "+05:30", (77.35, 12.75, 77.90, 13.20), state="Karnataka", sample=True),
}

#: Cities read from the database before. A city's area never changes, so each API copy keeps it once read.
_kept: dict[str, City] = {}


def city(slug: str) -> City | None:
    """A built-in city, or one someone picked before. A city on the built-in list of Indian cities
    that nobody has picked yet is looked up now."""
    found = CITIES.get(slug) or _kept.get(slug)
    if found is None:
        from app.services.cities import kept_or_looked_up  # the service imports this module

        found = kept_or_looked_up(slug)
        if found is not None:
            _kept[slug] = found
    return found


def covers(lng: float, lat: float) -> bool:
    """Whether a point is inside a city Reroute plans in."""
    if any(c.contains(lng, lat) for c in (*CITIES.values(), *_kept.values())):
        return True
    from app.services.cities import a_kept_city_covers

    return a_kept_city_covers(lng, lat)
