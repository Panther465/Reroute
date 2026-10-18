"""Trimmed GPS rides, kept in MongoDB (collection gps_rides). Never the first or last 200 m."""

from __future__ import annotations

from collections.abc import Sequence
from datetime import datetime
from functools import lru_cache
from typing import Protocol

from pymongo import MongoClient

from app.config import get_settings
from app.services.geo import RidePoint


class RideStore(Protocol):
    def save(self, contribution_id: str, user_id: str, city_slug: str, points: Sequence[RidePoint], at: datetime) -> None: ...

    def delete_for_user(self, user_id: str) -> int: ...


class MongoRideStore:
    def __init__(self, client: MongoClient, db_name: str) -> None:
        self.collection = client[db_name]["gps_rides"]

    def save(self, contribution_id: str, user_id: str, city_slug: str, points: Sequence[RidePoint], at: datetime) -> None:
        self.collection.replace_one(
            {"_id": contribution_id},
            {
                "_id": contribution_id,
                "userId": user_id,
                "citySlug": city_slug,
                "createdAt": at,
                "trimmed": True,
                "points": [{"lat": p.lat, "lng": p.lng, "t": p.t} for p in points],
            },
            upsert=True,
        )

    def delete_for_user(self, user_id: str) -> int:
        return self.collection.delete_many({"userId": user_id}).deleted_count


@lru_cache
def _client() -> MongoClient:
    return MongoClient(get_settings().mongo_url, serverSelectionTimeoutMS=3000, tz_aware=True)


def get_ride_store() -> RideStore:
    return MongoRideStore(_client(), get_settings().mongo_db)
