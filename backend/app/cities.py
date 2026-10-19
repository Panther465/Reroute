"""Cities Reroute supports. Place search and new trips are limited to these, so no request can add
places outside a city's area to the shared places table (section 15.1: coordinates inside the city).
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

    def contains(self, lng: float, lat: float) -> bool:
        west, south, east, north = self.bbox
        return west <= lng <= east and south <= lat <= north


CITIES: dict[str, City] = {
    # Bruhat Bengaluru Mahanagara Palike area with a margin for Whitefield and Electronic City.
    "bengaluru": City("bengaluru", "Bengaluru", "+05:30", (77.35, 12.75, 77.90, 13.20)),
}


def city(slug: str) -> City | None:
    return CITIES.get(slug)
