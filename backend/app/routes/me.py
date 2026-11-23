"""The signed-in user: their profile and password, their phones for push notifications, a copy of their data,
and deleting their location history or the whole account (DPDP Act, 2023)."""

from __future__ import annotations

import json
import logging
from datetime import UTC, datetime
from typing import Annotated

from fastapi import APIRouter, Header, Path, Response
from pymongo import MongoClient
from sqlalchemy import delete, func, select
from sqlalchemy.dialects.postgresql import insert

from app.config import get_settings
from app.deps import CurrentSession, CurrentUser, Db
from app.errors import ApiError
from app.models import PushDevice, User
from app.schemas import DeleteAccountIn, FeaturesOut, PasswordChangeIn, PostBody, ProfilePatch, PushDeviceIn, PushDeviceOut, TokenOut, UserOut
from app.security import clear_cookies, hash_password, issue_access_token, sha256, verify_password
from app.services import accounts, push

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
        email=s.email_on,
    )
    return UserOut(
        user_id=user.user_id,
        email=user.email,
        name=user.name,
        role=user.role,  # type: ignore[arg-type]
        is_demo=user.is_demo,
        email_verified=user.email_verified_at is not None,
        has_password=user.password_hash is not None,
        features=features,
    )


@router.get("", response_model=UserOut, response_model_by_alias=True)
def me(user: CurrentUser) -> UserOut:
    return user_out(user)


@router.patch("", response_model=UserOut, response_model_by_alias=True, summary="Change your name")
def edit_me(body: ProfilePatch, user: CurrentUser, db: Db) -> UserOut:
    if user.is_demo:
        raise ApiError(409, "The demo account's name stays as it is.", code="DEMO_ACCOUNT")
    user.name = body.name
    db.commit()
    return user_out(user)


@router.post("/password", response_model=TokenOut, response_model_by_alias=True, summary="Change your password")
def change_password(body: PasswordChangeIn, user: CurrentUser, session: CurrentSession, db: Db) -> TokenOut:
    """Signs out every other sign-in, and returns a new access token for this one (its old token stops working)."""
    if user.password_hash is None:
        raise ApiError(409, "This account signs in with Google. To add a password, use “Forgot your password?” when signing in.", code="NO_PASSWORD")
    if not verify_password(body.current_password, user.password_hash):
        raise ApiError(403, "Your current password is wrong.", code="WRONG_PASSWORD")
    now = datetime.now(UTC)
    user.password_hash = hash_password(body.new_password)
    user.password_changed_at = now
    accounts.end_all_sessions(db, user.user_id, now, keep_family=session)
    db.commit()
    token, ttl = issue_access_token(user, session_id=session)
    return TokenOut(access_token=token, expires_in=ttl, user=user_out(user))


@router.post("/verification-email", status_code=202, summary="Email the link that confirms your address again")
def resend_verification(body: PostBody, user: CurrentUser) -> Response:
    from app.routes.auth import send_link

    if user.email_verified_at is not None:
        raise ApiError(409, "Your email is already confirmed.", code="ALREADY_VERIFIED")
    if not get_settings().email_on:
        raise ApiError(503, "This server can't send email.", code="EMAIL_OFF")
    if not send_link(user, "verify"):
        message = "We sent one a moment ago. Check your inbox and spam folder, or try again in a minute."
        raise ApiError(429, message, code="RATE_LIMITED", headers={"Retry-After": "60"})
    return Response(status_code=202)


@router.get(
    "/export",
    summary="Download a copy of your data",
    responses={200: {"content": {"application/json": {}}, "description": "Everything Reroute keeps about you, as a JSON file"}},
)
def export_data(user: CurrentUser, db: Db) -> Response:
    data = accounts.export(db, user)
    name = f"reroute-data-{datetime.now(UTC).date().isoformat()}.json"
    return Response(
        json.dumps(data, ensure_ascii=False, indent=2),
        media_type="application/json",
        headers={"Content-Disposition": f'attachment; filename="{name}"', "Cache-Control": "no-store"},
    )


@router.post("/delete", status_code=204, summary="Delete your account and everything kept with it")
def delete_me(body: DeleteAccountIn, user: CurrentUser, db: Db, authorization: Annotated[str, Header()]) -> Response:
    if user.is_demo:
        raise ApiError(409, "The demo account can't be deleted.", code="DEMO_ACCOUNT")
    if user.password_hash is not None:
        if not body.password or not verify_password(body.password, user.password_hash):
            raise ApiError(403, "That password is wrong.", code="WRONG_PASSWORD")
    elif not body.email or body.email != user.email.lower():
        raise ApiError(403, "Type the email address of this account to confirm.", code="WRONG_EMAIL")
    accounts.delete_account(db, user, authorization)
    out = Response(status_code=204)
    clear_cookies(out)
    return out


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
