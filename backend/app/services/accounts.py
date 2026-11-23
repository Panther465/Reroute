"""Looking after an account: the links we email (verify an address, reset a password), a copy of everything
kept about a traveller, and deleting it all (docs/data-and-privacy.md)."""

from __future__ import annotations

import html
import logging
import secrets
from datetime import UTC, date, datetime, timedelta
from typing import Any

import httpx
from pydantic.alias_generators import to_camel
from pymongo import MongoClient
from sqlalchemy import delete, select, update
from sqlalchemy.orm import Session

from app.config import get_settings
from app.errors import ApiError
from app.models import (
    Booking,
    Checkin,
    EmailToken,
    Place,
    Plan,
    PushDevice,
    RefreshToken,
    RerouteLog,
    ShareLink,
    Task,
    Trip,
    User,
    WalletEntry,
)
from app.redis_client import get_redis
from app.security import sha256

log = logging.getLogger("reroute.accounts")

#: How long an emailed link works.
LINK_TTL = {"verify": timedelta(days=3), "reset": timedelta(hours=1)}
#: Emails of one kind to one account: one a minute, and this many a day.
DAILY_EMAILS = {"verify": 10, "reset": 5}


# ---------- emailed links ----------


def may_email(user_id: str, purpose: str) -> bool:
    """Count one email of this kind to this account. False when one went less than a minute ago, or the day's
    allowance is used: stops anyone filling an inbox from the sign-in page."""
    r = get_redis()
    if not r.set(f"mail:{purpose}:{user_id}:minute", "1", nx=True, ex=60):
        return False
    day_key = f"mail:{purpose}:{user_id}:{date.today().isoformat()}"
    count = r.incr(day_key)
    if count == 1:
        r.expire(day_key, 24 * 3600)
    return count <= DAILY_EMAILS[purpose]


def new_link(db: Session, user: User, purpose: str, now: datetime | None = None) -> str:
    """A new single-use link token for the account. Only its hash is kept; earlier unused links of the same kind stop working."""
    now = now or datetime.now(UTC)
    db.execute(update(EmailToken).where(EmailToken.user_id == user.user_id, EmailToken.purpose == purpose, EmailToken.used_at.is_(None)).values(used_at=now))
    raw = secrets.token_urlsafe(32)
    db.add(EmailToken(user_id=user.user_id, purpose=purpose, token_hash=sha256(raw), email=user.email, expires_at=now + LINK_TTL[purpose]))
    return raw


def use_link(db: Session, raw: str, purpose: str, now: datetime | None = None) -> User:
    """The account a link is for, marking the link used. Refuses one that's unknown, used, expired, or sent
    to an address the account no longer has."""
    now = now or datetime.now(UTC)
    token = db.scalar(select(EmailToken).where(EmailToken.token_hash == sha256(raw), EmailToken.purpose == purpose))
    user = db.get(User, token.user_id) if token else None
    if token is None or user is None or token.used_at is not None or token.expires_at <= now or token.email.lower() != user.email.lower():
        what = "reset link" if purpose == "reset" else "link"
        raise ApiError(400, f"This {what} has expired or was already used. Ask for a new one.", code="LINK_INVALID")
    token.used_at = now
    return user


def link_email(user: User, purpose: str, raw: str) -> tuple[str, str, str]:
    """The subject, plain text and HTML of the email carrying a link. The token travels in the URL's fragment,
    which browsers never send to a server or in a Referer."""
    base = get_settings().public_base_url.rstrip("/")
    first = user.name.split()[0] if user.name.strip() else "there"
    if purpose == "verify":
        url = f"{base}/verify-email#token={raw}"
        subject = "Confirm your email for Reroute"
        lines = [f"Hi {first},", "", "Confirm this is your email address for Reroute:", url, "", "The link works for 3 days."]
        button = "Confirm my email"
    else:
        url = f"{base}/reset-password#token={raw}"
        subject = "Reset your Reroute password"
        ask = "Someone (we hope you) asked to reset your Reroute password. Choose a new one here:"
        lines = [f"Hi {first},", "", ask, url, "", "The link works for an hour, once."]
        button = "Choose a new password"
    footer = "If you didn't ask for this, ignore this email: nothing changes."
    text = "\n".join([*lines, "", footer, "", "Reroute"]) + "\n"
    paragraphs = "".join(f"<p>{html.escape(line)}</p>" for line in [lines[0], lines[2]])
    page = (
        '<!doctype html><html><body style="font-family:Arial,sans-serif;font-size:16px;line-height:1.5;color:#1b1f1c">'
        f"{paragraphs}"
        f'<p><a href="{html.escape(url)}" style="display:inline-block;padding:12px 20px;border-radius:12px;background:#0b7a4b;color:#ffffff;'
        f'text-decoration:none;font-weight:bold">{button}</a></p>'
        f'<p>{html.escape(lines[-1])}</p><p style="color:#5b625d">{html.escape(footer)}</p><p>Reroute</p></body></html>'
    )
    return subject, text, page


# ---------- sessions ----------


def end_all_sessions(db: Session, user_id: str, now: datetime, keep_family: str | None = None) -> None:
    """Sign out everywhere but `keep_family`: revoke the refresh tokens, and forget the phones those sign-ins
    registered for push."""
    tokens = update(RefreshToken).where(RefreshToken.user_id == user_id, RefreshToken.revoked_at.is_(None))
    phones = delete(PushDevice).where(PushDevice.user_id == user_id)
    if keep_family:
        tokens = tokens.where(RefreshToken.family_id != keep_family)
        phones = phones.where(PushDevice.family_id.is_distinct_from(keep_family))
    db.execute(tokens.values(revoked_at=now))
    db.execute(phones)


# ---------- a copy of everything ----------

#: Never in the copy: secrets, even hashed ones.
_SECRET = {"password_hash", "token_hash", "token", "idempotency_key"}


def _plain(value: Any) -> Any:
    if isinstance(value, datetime | date):
        return value.isoformat()
    if isinstance(value, dict):
        return {k: _plain(v) for k, v in value.items()}
    if isinstance(value, list | tuple):
        return [_plain(v) for v in value]
    return value


def _row(obj: Any, skip: set[str] = frozenset()) -> dict[str, Any]:
    return {to_camel(c.key): _plain(getattr(obj, c.key)) for c in obj.__table__.columns if c.key not in _SECRET | skip}


def export(db: Session, user: User) -> dict[str, Any]:
    """Everything Reroute keeps about the traveller, as one JSON document."""
    trips = []
    for trip in db.scalars(select(Trip).where(Trip.user_id == user.user_id).order_by(Trip.start_date, Trip.trip_id)):
        tid = trip.trip_id
        trips.append(
            {
                **_row(trip),
                "tasks": [_row(t) for t in db.scalars(select(Task).where(Task.trip_id == tid).order_by(Task.created_at))],
                "plans": [_row(p) for p in db.scalars(select(Plan).where(Plan.trip_id == tid).order_by(Plan.created_at))],
                "checkins": [_row(c) for c in db.scalars(select(Checkin).where(Checkin.trip_id == tid).order_by(Checkin.at))],
                "bookings": [_row(b) for b in db.scalars(select(Booking).where(Booking.trip_id == tid).order_by(Booking.created_at))],
                "shareLinks": [_row(s) for s in db.scalars(select(ShareLink).where(ShareLink.trip_id == tid).order_by(ShareLink.created_at))],
                "rerouteLog": [_row(r) for r in db.scalars(select(RerouteLog).where(RerouteLog.trip_id == tid).order_by(RerouteLog.at))],
            }
        )
    live = select(RefreshToken).where(RefreshToken.user_id == user.user_id, RefreshToken.revoked_at.is_(None))
    return {
        "exportedAt": datetime.now(UTC).isoformat(),
        "about": "Everything Reroute keeps about your account (docs/data-and-privacy.md). Passwords and sign-in tokens are never included.",
        "account": _row(user),
        "trips": trips,
        "places": [_row(p, skip={"location"}) for p in db.scalars(select(Place).where(Place.owner_id == user.user_id).order_by(Place.created_at))],
        "wallet": [_row(w) for w in db.scalars(select(WalletEntry).where(WalletEntry.user_id == user.user_id).order_by(WalletEntry.created_at))],
        "phonesForAlerts": [_row(d) for d in db.scalars(select(PushDevice).where(PushDevice.user_id == user.user_id))],
        "signIns": [_row(t, skip={"user_id"}) for t in db.scalars(live.order_by(RefreshToken.created_at))],
        "locationHistory": location_history(user.user_id),
        "raasta": "Routes, confirmations and fare reports you sent to Raasta stay with Raasta under your account ID. Deleting your account removes that link.",
    }


def _mongo() -> MongoClient:
    return MongoClient(get_settings().mongo_url, serverSelectionTimeoutMS=3000)


def location_history(user_id: str) -> list[dict]:
    client = _mongo()
    try:
        rows = client.get_default_database()["location_timeline"].find({"userId": user_id}, {"_id": 0}).limit(50_000)
        return [_plain(r) for r in rows]
    except Exception as exc:
        raise ApiError(503, "Couldn't read your location history just now. Try again in a minute.", code="UNAVAILABLE") from exc
    finally:
        client.close()


# ---------- deleting an account ----------


def erase_from_raasta(authorization: str) -> None:
    """Ask Raasta to delete the traveller's recorded rides and drop their ID from what they added, as them."""
    s = get_settings()
    try:
        res = httpx.delete(f"{s.raasta_base_url.rstrip('/')}/v1/raasta/me", headers={"Authorization": authorization}, timeout=8.0)
    except httpx.HTTPError as exc:
        log.warning("Raasta unreachable while deleting an account: %s", exc)
        res = None
    if res is None or res.status_code != 204:
        raise ApiError(503, "Couldn't reach Raasta to remove your routes, so nothing was deleted. Try again in a minute.", code="UNAVAILABLE")


def delete_account(db: Session, user: User, authorization: str) -> None:
    """Delete the account and everything kept with it, in Raasta and MongoDB first, so a failure part-way leaves
    the account to delete again. The database trigger keeps a place another traveller's trip goes to (or one a
    moderator approved for everyone), without its owner or note; every other row goes with the account."""
    erase_from_raasta(authorization)
    client = _mongo()
    try:
        client.get_default_database()["location_timeline"].delete_many({"userId": user.user_id})
    except Exception as exc:
        raise ApiError(503, "Couldn't delete your location history just now, so nothing was deleted. Try again in a minute.", code="UNAVAILABLE") from exc
    finally:
        client.close()
    user_id = user.user_id
    db.delete(user)
    db.commit()
    r = get_redis()
    for key in r.scan_iter(f"mail:*:{user_id}:*"):
        r.delete(key)
    log.info("Deleted an account", extra={"userId": user_id})
