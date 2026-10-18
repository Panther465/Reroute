"""Google sign-in (authorization code flow) and read-only Calendar import.

The browser only ever holds a one-time code. The server exchanges it with the client secret, then
verifies the ID token's issuer, audience and expiry against Google's published keys.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime

import httpx
import jwt

from app.config import get_settings
from app.errors import ApiError

TOKEN_URL = "https://oauth2.googleapis.com/token"
JWKS_URL = "https://www.googleapis.com/oauth2/v3/certs"
ISSUERS = ("https://accounts.google.com", "accounts.google.com")
CALENDAR_EVENTS = "https://www.googleapis.com/calendar/v3/calendars/primary/events"

_jwks = jwt.PyJWKClient(JWKS_URL, cache_keys=True)


@dataclass(frozen=True)
class GoogleIdentity:
    sub: str
    email: str
    name: str


@dataclass(frozen=True)
class CalendarEvent:
    title: str
    location: str
    start: datetime
    end: datetime


def _exchange(code: str, client: httpx.Client | None = None) -> dict:
    s = get_settings()
    if not s.google_client_id or not s.google_client_secret:
        raise ApiError(503, "Google sign-in isn't set up on this server.", code="NOT_CONFIGURED")
    http = client or httpx.Client(timeout=8.0)
    res = http.post(
        TOKEN_URL,
        data={
            "code": code,
            "client_id": s.google_client_id,
            "client_secret": s.google_client_secret,
            "redirect_uri": s.google_redirect_uri,
            "grant_type": "authorization_code",
        },
    )
    if res.status_code != 200:
        raise ApiError(401, "Google didn't accept that sign-in. Try again.")
    return res.json()


def verify_id_token(id_token: str) -> GoogleIdentity:
    s = get_settings()
    try:
        key = _jwks.get_signing_key_from_jwt(id_token)
        claims = jwt.decode(id_token, key.key, algorithms=["RS256"], audience=s.google_client_id, options={"require": ["exp", "iss", "aud", "sub"]})
    except jwt.PyJWTError as exc:
        raise ApiError(401, "Google didn't accept that sign-in. Try again.") from exc
    if claims.get("iss") not in ISSUERS:
        raise ApiError(401, "Google didn't accept that sign-in. Try again.")
    return GoogleIdentity(sub=claims["sub"], email=claims.get("email", ""), name=claims.get("name") or claims.get("email", "Traveller"))


def sign_in_with_code(code: str) -> GoogleIdentity:
    tokens = _exchange(code)
    if "id_token" not in tokens:
        raise ApiError(401, "Google didn't accept that sign-in. Try again.")
    return verify_id_token(tokens["id_token"])


def calendar_events(code: str, time_min: datetime, time_max: datetime) -> list[CalendarEvent]:
    """Exchange a code granted with calendar.readonly scope, then read events in the range."""
    tokens = _exchange(code)
    access = tokens.get("access_token")
    if not access or "calendar.readonly" not in tokens.get("scope", ""):
        raise ApiError(403, "Allow read-only Calendar access to import appointments.")
    res = httpx.get(
        CALENDAR_EVENTS,
        params={"timeMin": time_min.isoformat(), "timeMax": time_max.isoformat(), "singleEvents": "true", "orderBy": "startTime", "maxResults": 50},
        headers={"Authorization": f"Bearer {access}"},
        timeout=8.0,
    )
    if res.status_code != 200:
        raise ApiError(502, "Couldn't read your calendar. Try again.", code="UPSTREAM")
    events = []
    for item in res.json().get("items", []):
        start, end = item.get("start", {}).get("dateTime"), item.get("end", {}).get("dateTime")
        if not start or not end:
            continue  # all-day events have no time to plan around
        events.append(
            CalendarEvent(
                title=item.get("summary", "Appointment"),
                location=item.get("location", ""),
                start=datetime.fromisoformat(start),
                end=datetime.fromisoformat(end),
            )
        )
    return events
