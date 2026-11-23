"""Forgetting a rider who deletes their Reroute account. The Reroute API calls this before it deletes the account."""

from __future__ import annotations

import hashlib
import hmac
import logging

from sqlalchemy import select, update
from sqlalchemy.orm import Session

from app.adapters.rides import RideStore, RideStoreUnavailable
from app.errors import ApiError
from app.models import Confirmation, Contribution, FareReport, Route

log = logging.getLogger("raasta")

#: Every column that holds a Reroute user ID. Moderator edits keep one in contributions.payload too.
USER_ID_COLUMNS = (
    Contribution.contributor_id,
    Contribution.decided_by,
    Route.contributor_id,
    Confirmation.user_id,
    FareReport.user_id,
    FareReport.decided_by,
)


def pseudonym(user_id: str, secret: str) -> str:
    """A stable stand-in for a user ID. Different riders stay different, so verification counts don't change.

    Keyed with a server secret, so nobody can find the ID again by hashing guesses.
    """
    return "gone-" + hmac.new(secret.encode(), user_id.encode(), hashlib.sha256).hexdigest()[:16]


def forget_rider(session: Session, user_id: str, rides: RideStore, secret: str) -> None:
    """Delete the rider's recorded rides and put a pseudonym wherever a table keeps their ID.

    All or nothing: if MongoDB can't delete the rides, nothing changes and the caller retries.
    Running it again finds nothing left to change.
    """
    gone = pseudonym(user_id, secret)
    for column in USER_ID_COLUMNS:
        session.execute(update(column.class_).where(column == user_id).values({column: gone}))
    edited = select(Contribution).where(Contribution.payload["edits"].contains([{"by": user_id}]))
    for c in session.scalars(edited):
        c.payload = {**c.payload, "edits": [{**e, "by": gone} if e.get("by") == user_id else e for e in c.payload["edits"]]}
    session.flush()
    try:
        rides.delete_for_user(user_id)
    except RideStoreUnavailable as exc:
        session.rollback()
        log.warning("ride store unavailable: %s", exc)
        raise ApiError(503, "UNAVAILABLE", "Recorded rides can't be removed right now. Try again in a few minutes.") from exc
    session.commit()
