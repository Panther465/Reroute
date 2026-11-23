"""The signed-in rider's own data."""

from __future__ import annotations

from fastapi import APIRouter, Depends, status
from sqlalchemy.orm import Session

from app.adapters.rides import RideStore, get_ride_store
from app.config import Settings, get_settings
from app.db import get_session
from app.ratelimit import per_minute_limit
from app.security import User, no_service_writes, require_user
from app.services import erasure

# The service token alone can't erase anyone: no_service_writes refuses it with 403.
router = APIRouter(tags=["Your data"], dependencies=[Depends(per_minute_limit), Depends(no_service_writes)])


@router.delete("/me", status_code=status.HTTP_204_NO_CONTENT, summary="Delete my recorded rides and unlink the rest from me")
def forget_me(
    user: User = Depends(require_user),
    session: Session = Depends(get_session),
    rides: RideStore = Depends(get_ride_store),
    settings: Settings = Depends(get_settings),
) -> None:
    """For account deletion: rides are deleted, other rows stay under a pseudonym. Safe to repeat; a 503 changed nothing, so retry."""
    # The JWT secret keys the pseudonym: never public, and the same in every Raasta copy, so a repeat gives the same stand-in.
    erasure.forget_rider(session, user.user_id, rides, settings.jwt_secret)
