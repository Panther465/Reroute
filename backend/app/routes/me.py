"""The signed-in user, and deleting their location history (DPDP Act, 2023)."""

from __future__ import annotations

import logging

from fastapi import APIRouter, Response
from pymongo import MongoClient

from app.config import get_settings
from app.deps import CurrentUser
from app.models import User
from app.schemas import FeaturesOut, UserOut

router = APIRouter(prefix="/v1/me", tags=["me"])
log = logging.getLogger("reroute.me")


def user_out(user: User) -> UserOut:
    s = get_settings()
    features = FeaturesOut(bookings=s.demo_login, ai_helper=s.ai_helper_enabled, voices=s.tts_enabled, wallet=s.demo_login)
    return UserOut(user_id=user.user_id, email=user.email, name=user.name, role=user.role, is_demo=user.is_demo, features=features)  # type: ignore[arg-type]


@router.get("", response_model=UserOut, response_model_by_alias=True)
def me(user: CurrentUser) -> UserOut:
    return user_out(user)


@router.delete("/location-history", status_code=204)
def delete_location_history(user: CurrentUser) -> Response:
    client: MongoClient = MongoClient(get_settings().mongo_url, serverSelectionTimeoutMS=3000)
    try:
        db = client.get_default_database()
        db["location_timeline"].delete_many({"userId": user.user_id})
    finally:
        client.close()
    log.info("Deleted location history", extra={"userId": user.user_id})
    return Response(status_code=204)
