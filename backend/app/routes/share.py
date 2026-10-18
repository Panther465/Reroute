"""Share links: view-only access to one trip. A link is not a role and grants nothing else.

The token is 128 random bits, shown once and stored hashed. It can be revoked and expires when the
trip ends; after that the family view answers 410 Gone.
"""

from __future__ import annotations

from datetime import UTC, datetime, time

from fastapi import APIRouter, Response
from sqlalchemy import select

from app import events
from app.clock import now_for, tz_for
from app.config import get_settings
from app.deps import CurrentUser, Db, OwnedTrip
from app.errors import ApiError
from app.models import ShareLink, Trip, User
from app.schemas import SharedTripOut, ShareLinkIn, ShareLinkOut
from app.security import new_share_token, sha256
from app.services.views import shared_out

router = APIRouter(prefix="/v1", tags=["sharing"])


@router.post("/trips/{trip_id}/share-links", response_model=ShareLinkOut, response_model_by_alias=True, status_code=201)
def create_link(body: ShareLinkIn, trip: OwnedTrip, db: Db) -> ShareLinkOut:
    token = new_share_token()
    expires = datetime.combine(trip.end_date, time(23, 59), tz_for(trip.utc_offset))
    link = ShareLink(trip_id=trip.trip_id, token_hash=sha256(token), expires_at=expires)
    db.add(link)
    db.commit()
    url = f"{get_settings().public_base_url.rstrip('/')}/shared/{token}"
    return ShareLinkOut(share_id=link.share_id, trip_id=trip.trip_id, token=token, url=url, expires_at=link.expires_at)


@router.get("/trips/{trip_id}/share-links", response_model=list[ShareLinkOut], response_model_by_alias=True)
def list_links(trip: OwnedTrip, db: Db) -> list[ShareLinkOut]:
    rows = db.scalars(select(ShareLink).where(ShareLink.trip_id == trip.trip_id).order_by(ShareLink.created_at.desc()))
    return [ShareLinkOut(share_id=r.share_id, trip_id=r.trip_id, expires_at=r.expires_at, revoked_at=r.revoked_at) for r in rows]


@router.delete("/share-links/{share_id}", status_code=204)
def revoke_link(share_id: str, user: CurrentUser, db: Db) -> Response:
    link = db.get(ShareLink, share_id)
    trip = db.get(Trip, link.trip_id) if link else None
    if link is None or trip is None or (trip.user_id != user.user_id and user.role != "admin"):
        raise ApiError(404, "Share link not found.")
    if link.revoked_at is None:
        link.revoked_at = datetime.now(UTC)
        db.commit()
    return Response(status_code=204)


@router.get("/shared/{token}", response_model=SharedTripOut, response_model_by_alias=True, summary="Family view of a shared trip (no sign-in)")
def shared_trip(token: str, db: Db) -> SharedTripOut:
    link = db.scalar(select(ShareLink).where(ShareLink.token_hash == sha256(token)))
    if link is None:
        raise ApiError(404, "This link doesn't exist.")
    trip = db.get(Trip, link.trip_id)
    now = now_for(link.trip_id)
    if trip is None or link.revoked_at is not None or link.expires_at <= now:
        raise ApiError(410, "This trip is no longer shared.")
    owner = db.get(User, trip.user_id)
    return shared_out(db, trip, owner.name if owner else "", now, events.last_updated(trip.trip_id))
