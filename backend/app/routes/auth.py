"""Sign-in: an email and password account, Google (authorization code flow) or, locally, the demo account."""

from __future__ import annotations

from datetime import datetime
from typing import Annotated

from fastapi import APIRouter, Cookie, Header, Response
from sqlalchemy import func, select

from app.adapters.google import sign_in_with_code
from app.clock import demo_key, set_demo_now
from app.config import get_settings
from app.deps import Db
from app.errors import ApiError
from app.models import Trip, User
from app.redis_client import get_redis
from app.routes.me import user_out
from app.schemas import DemoSignIn, GoogleSignIn, LoginIn, SignUpIn, TokenOut
from app.security import (
    CSRF_COOKIE,
    REFRESH_COOKIE,
    check_csrf,
    clear_cookies,
    hash_password,
    issue_access_token,
    revoke_refresh,
    rotate_refresh,
    start_session,
    verify_password,
)
from app.services import wallet

router = APIRouter(prefix="/v1/auth", tags=["auth"])

DEMO_EMAILS = {"traveller": "demo.traveller@reroute.example", "moderator": "demo.moderator@reroute.example"}
DEMO_CLOCK_START = "2026-10-14T07:30:00+05:30"


def _token(user: User) -> TokenOut:
    token, ttl = issue_access_token(user)
    return TokenOut(access_token=token, expires_in=ttl, user=user_out(user))


#: A dummy hash to compare against when no account has the email, so a wrong email takes as long as a wrong password.
_NO_ACCOUNT = hash_password("no account has this email")


@router.post("/signup", response_model=TokenOut, response_model_by_alias=True, status_code=201, summary="Create an account with an email and a password")
def signup(body: SignUpIn, response: Response, db: Db) -> TokenOut:
    if db.scalar(select(User.user_id).where(func.lower(User.email) == body.email).limit(1)):
        raise ApiError(409, "An account with this email already exists. Sign in instead.", code="EMAIL_TAKEN")
    user = User(email=body.email, name=body.name, role="traveller", password_hash=hash_password(body.password))
    db.add(user)
    db.flush()
    wallet.credit_welcome(db, user.user_id)
    start_session(db, user, response)
    db.commit()
    return _token(user)


@router.post("/login", response_model=TokenOut, response_model_by_alias=True, summary="Sign in with an email and a password")
def login(body: LoginIn, response: Response, db: Db) -> TokenOut:
    user = db.scalar(select(User).where(func.lower(User.email) == body.email, User.password_hash.is_not(None)))
    if not verify_password(body.password, user.password_hash if user else _NO_ACCOUNT) or user is None:
        # One answer for a wrong email and a wrong password: it doesn't say which accounts exist.
        raise ApiError(401, "Email or password is wrong.")
    start_session(db, user, response)
    db.commit()
    return _token(user)


@router.post("/google", response_model=TokenOut, response_model_by_alias=True)
def google(body: GoogleSignIn, response: Response, db: Db) -> TokenOut:
    identity = sign_in_with_code(body.code)
    user = db.scalar(select(User).where(User.google_sub == identity.sub))
    if user is None:
        user = User(google_sub=identity.sub, email=identity.email, name=identity.name, role="traveller")
        db.add(user)
        db.flush()
        wallet.credit_welcome(db, user.user_id)
    start_session(db, user, response)
    db.commit()
    return _token(user)


@router.post("/demo", response_model=TokenOut, response_model_by_alias=True, summary="Demo sign-in (only when DEMO_LOGIN=true)")
def demo(body: DemoSignIn, response: Response, db: Db) -> TokenOut:
    if not get_settings().demo_login:
        raise ApiError(404, "Not found.")
    user = db.scalar(select(User).where(User.email == DEMO_EMAILS[body.as_role]))
    if user is None:
        raise ApiError(503, "The demo account isn't seeded. Run the seed script.", code="NOT_SEEDED")
    # The demo trip starts on its own simulated morning, so the reviewer can replay the day.
    for trip in db.scalars(select(Trip).where(Trip.user_id == user.user_id, Trip.sample.is_(True))):
        if not get_redis().exists(demo_key(trip.trip_id)):
            set_demo_now(trip.trip_id, datetime.fromisoformat(DEMO_CLOCK_START))
    start_session(db, user, response)
    db.commit()
    return _token(user)


@router.post("/refresh", response_model=TokenOut, response_model_by_alias=True)
def refresh(
    response: Response,
    db: Db,
    rr_refresh: Annotated[str | None, Cookie(alias=REFRESH_COOKIE)] = None,
    rr_csrf: Annotated[str | None, Cookie(alias=CSRF_COOKIE)] = None,
    x_csrf_token: Annotated[str | None, Header()] = None,
) -> TokenOut:
    if not rr_refresh:
        # No session at all (a first visit): "sign in", not a CSRF failure.
        raise ApiError(401, "Sign in to continue.")
    check_csrf(rr_csrf, x_csrf_token)
    user = rotate_refresh(db, rr_refresh, response)
    return _token(user)


@router.post("/logout", status_code=204)
def logout(
    response: Response,
    db: Db,
    rr_refresh: Annotated[str | None, Cookie(alias=REFRESH_COOKIE)] = None,
    rr_csrf: Annotated[str | None, Cookie(alias=CSRF_COOKIE)] = None,
    x_csrf_token: Annotated[str | None, Header()] = None,
) -> Response:
    check_csrf(rr_csrf, x_csrf_token)
    revoke_refresh(db, rr_refresh)
    out = Response(status_code=204)
    clear_cookies(out)
    return out
