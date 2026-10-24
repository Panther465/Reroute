"""The signed-in user, their phones for push notifications, and deleting their location history (DPDP Act, 2023)."""

from __future__ import annotations

import logging

from fastapi import APIRouter, Path, Response
from pymongo import MongoClient
from sqlalchemy import delete, func, select
from sqlalchemy.dialects.postgresql import insert

from app.config import get_settings
from app.deps import CurrentSession, CurrentUser, Db
from app.errors import ApiError
from app.models import PushDevice, User
from app.schemas import FeaturesOut, PushDeviceIn, PushDeviceOut, UserOut
from app.security import sha256
from app.services import push

router = APIRouter(prefix="/v1/me", tags=["me"])
log = logging.getLogger("reroute.me")


def user_out(user: User) -> UserOut:
    s = get_settings()
    agent = s.ai_helper_enabled and bool(s.gemini_api_key or s.roo_fake_llm)
    features = FeaturesOut(
        bookings=s.simulated_services,
        ai_helper=s.ai_helper_enabled,
        voices=s.tts_enabled,
        wallet=s.simulated_services,
        agent=agent,
        # Realtime voice needs Google itself: the scripted fake model has no voice.
        voice_chat=s.ai_helper_enabled and bool(s.gemini_api_key),
        push=push.offered(),
    )
    return UserOut(user_id=user.user_id, email=user.email, name=user.name, role=user.role, is_demo=user.is_demo, features=features)  # type: ignore[arg-type]


@router.get("", response_model=UserOut, response_model_by_alias=True)
def me(user: CurrentUser) -> UserOut:
    return user_out(user)


#: Phones per traveller: registering one more forgets the one heard from longest ago.
MAX_PUSH_DEVICES = 10


@router.post("/push-devices", response_model=PushDeviceOut, response_model_by_alias=True, summary="Get alerts on this phone as push notifications")
def add_push_device(body: PushDeviceIn, user: CurrentUser, session: CurrentSession, db: Db) -> PushDeviceOut:
    # No pushes from this server: the phone's token isn't kept.
    if not push.offered():
        raise ApiError(409, "Push notifications aren't on for this server.", code="PUSH_OFF")
    device_id = sha256(body.token)
    # One statement, so two registrations of the same phone at once can't collide. The phone belongs to whoever
    # signed in on it last, for as long as that sign-in lasts: the earlier traveller's alerts stop coming here.
    fields = {"user_id": user.user_id, "family_id": session, "token": body.token, "platform": body.platform}
    db.execute(
        insert(PushDevice)
        .values(device_id=device_id, **fields)
        .on_conflict_do_update(index_elements=[PushDevice.device_id], set_={**fields, "last_seen_at": func.now()})
    )
    others = db.scalars(
        select(PushDevice.device_id).where(PushDevice.user_id == user.user_id, PushDevice.device_id != device_id).order_by(PushDevice.last_seen_at.desc())
    ).all()
    if len(others) >= MAX_PUSH_DEVICES:
        db.execute(delete(PushDevice).where(PushDevice.device_id.in_(others[MAX_PUSH_DEVICES - 1 :])))
    db.commit()
    return PushDeviceOut(device_id=device_id)


@router.delete("/push-devices/{device_id}", status_code=204, summary="Stop push notifications on a phone")
def remove_push_device(user: CurrentUser, db: Db, device_id: str = Path(pattern=r"^[0-9a-f]{64}$")) -> Response:
    db.execute(delete(PushDevice).where(PushDevice.device_id == device_id, PushDevice.user_id == user.user_id))
    db.commit()
    return Response(status_code=204)


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
