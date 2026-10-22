"""Request dependencies: the signed-in user, roles and trip ownership (section 15.4)."""

from __future__ import annotations

from typing import Annotated

from fastapi import Depends, Header
from sqlalchemy.orm import Session

from app.config import get_settings
from app.db import get_session
from app.errors import ApiError
from app.models import Trip, User
from app.security import decode_access_token

Db = Annotated[Session, Depends(get_session)]


def current_user(db: Db, authorization: Annotated[str | None, Header()] = None) -> User:
    if not authorization or not authorization.lower().startswith("bearer "):
        raise ApiError(401, "Sign in to continue.", headers={"WWW-Authenticate": "Bearer"})
    claims = decode_access_token(authorization[7:])
    user = db.get(User, claims["sub"])
    if user is None:
        raise ApiError(401, "Sign in to continue.")
    return user


CurrentUser = Annotated[User, Depends(current_user)]


def require_role(*roles: str):
    def check(user: CurrentUser) -> User:
        if user.role not in roles:
            raise ApiError(403, "You don't have access to this.")
        return user

    return check


def owned_trip(trip_id: str, user: CurrentUser, db: Db) -> Trip:
    trip = db.get(Trip, trip_id)
    # Same answer for "missing" and "not yours", so trip IDs can't be probed.
    if trip is None or (trip.user_id != user.user_id and user.role != "admin"):
        raise ApiError(404, "Trip not found.")
    return trip


OwnedTrip = Annotated[Trip, Depends(owned_trip)]


def demo_only() -> None:
    """Routes that exist only with DEMO_LOGIN=true (the demo clock, simulated bookings): 404 otherwise."""
    if not get_settings().demo_login:
        raise ApiError(404, "Not found.")
