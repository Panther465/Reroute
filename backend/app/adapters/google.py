"""Google sign-in (authorization code flow) and read-only Calendar import.

The browser only ever holds a one-time code. The server exchanges it with the client secret, then
verifies the ID token's issuer, audience and expiry against Google's published keys.
"""

from __future__ import annotations

import logging
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
#: Google's reasons for "this project hasn't switched the Calendar API on".
API_OFF = ("accessNotConfigured", "SERVICE_DISABLED")

log = logging.getLogger("reroute.google")
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


def _error(res: httpx.Response) -> str:
    try:
        err = res.json().get("error", "")
    except ValueError:
        return ""
    return err if isinstance(err, str) else ""


def _exchange(code: str, client: httpx.Client | None = None) -> dict:
    """The tokens for a one-time code. The web's codes (Google's popup) name the redirect "postmessage"; the Android
    app's name the same as the web app's, or none: on Google's "redirect_uri_mismatch" the code is tried once without."""
    s = get_settings()
    if not s.google_client_id or not s.google_client_secret:
        raise ApiError(503, "Google sign-in isn't set up on this server.", code="NOT_CONFIGURED")
    http = client or httpx.Client(timeout=8.0)
    form = {
        "code": code,
        "client_id": s.google_client_id,
        "client_secret": s.google_client_secret,
        "redirect_uri": s.google_redirect_uri,
        "grant_type": "authorization_code",
    }
    res = http.post(TOKEN_URL, data=form)
    if res.status_code == 400 and _error(res) == "redirect_uri_mismatch" and form["redirect_uri"]:
        res = http.post(TOKEN_URL, data={**form, "redirect_uri": ""})
    if res.status_code != 200:
        reason = _error(res)
        if reason in ("invalid_client", "unauthorized_client"):
            # The server's GOOGLE_CLIENT_ID or GOOGLE_CLIENT_SECRET is wrong: the traveller can't fix that.
            log.warning("Google refused this server's client ID or secret (%s)", reason)
            raise ApiError(503, "Google sign-in isn't set up properly on this server.", code="NOT_CONFIGURED")
        log.info("Google refused a sign-in code (%s)", reason or res.status_code)
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


def _calendar_off(res: httpx.Response) -> bool:
    """Google says this server's Google project hasn't switched the Calendar API on."""
    try:
        error = res.json().get("error", {})
    except ValueError:
        return False
    if not isinstance(error, dict):
        return False
    reasons = [e.get("reason") for e in error.get("errors", []) if isinstance(e, dict)]
    reasons += [d.get("reason") for d in error.get("details", []) if isinstance(d, dict)]
    return any(r in API_OFF for r in reasons)


def calendar_events(code: str, time_min: datetime, time_max: datetime, client: httpx.Client | None = None) -> list[CalendarEvent]:
    """Exchange a code granted with calendar.readonly scope, then read events in the range: timed ones only (an all-day
    event has no time to plan around), and none the traveller declined."""
    if client is None:
        with httpx.Client(timeout=8.0) as own:
            return calendar_events(code, time_min, time_max, own)
    try:
        tokens = _exchange(code, client)
        access = tokens.get("access_token")
        if not access or "calendar.readonly" not in tokens.get("scope", ""):
            raise ApiError(403, "Allow read-only Calendar access to import appointments.")
        res = client.get(
            CALENDAR_EVENTS,
            params={"timeMin": time_min.isoformat(), "timeMax": time_max.isoformat(), "singleEvents": "true", "orderBy": "startTime", "maxResults": 50},
            headers={"Authorization": f"Bearer {access}"},
        )
    except httpx.HTTPError as exc:
        raise ApiError(502, "Couldn't reach Google. Try again.", code="UPSTREAM") from exc
    if res.status_code == 403 and _calendar_off(res):
        log.warning("Google Calendar's API is off in this server's Google project")
        raise ApiError(503, "Calendar import isn't switched on for this server's Google project yet.", code="NOT_CONFIGURED")
    if res.status_code in (401, 403):
        raise ApiError(403, "Allow read-only Calendar access to import appointments.")
    if res.status_code != 200:
        raise ApiError(502, "Couldn't read your calendar. Try again.", code="UPSTREAM")
    events = []
    for item in res.json().get("items", []):
        start, end = item.get("start", {}).get("dateTime"), item.get("end", {}).get("dateTime")
        if not start or not end:
            continue  # all-day events have no time to plan around
        if any(a.get("self") and a.get("responseStatus") == "declined" for a in item.get("attendees", []) if isinstance(a, dict)):
            continue  # they said they won't go
        events.append(
            CalendarEvent(
                title=item.get("summary", "Appointment"),
                location=item.get("location", ""),
                start=datetime.fromisoformat(start),
                end=datetime.fromisoformat(end),
            )
        )
    return events
