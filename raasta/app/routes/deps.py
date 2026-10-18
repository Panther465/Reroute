"""Shared request helpers: parsing "lng,lat" values and reading the clock in one place."""

from __future__ import annotations

from datetime import UTC, datetime

from app.errors import ApiError
from app.services.geo import LatLng


def utc_now() -> datetime:
    """The only clock read in the service. Tests override it."""
    return datetime.now(UTC)


def parse_lnglat(value: str, name: str) -> LatLng:
    try:
        lng_s, lat_s = value.split(",")
        lng, lat = float(lng_s), float(lat_s)
    except ValueError as exc:
        raise ApiError(400, "BAD_REQUEST", f'{name} must be "lng,lat", for example 77.6185,12.934.') from exc
    if not (-180 <= lng <= 180 and -90 <= lat <= 90):
        raise ApiError(400, "BAD_REQUEST", f"{name} is outside the valid range of coordinates.")
    return LatLng(lat=lat, lng=lng)
