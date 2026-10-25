"""Google Calendar import: the code exchanged for a read-only token, the trip's timed appointments read, and plain
answers when Google's side isn't set up. Google itself is stood in for here."""

from __future__ import annotations

from datetime import UTC, datetime
from urllib.parse import parse_qs

import httpx
import pytest

from app.adapters import google
from app.config import Settings
from app.errors import ApiError

FROM = datetime(2026, 10, 14, tzinfo=UTC)
TO = datetime(2026, 10, 15, 23, 59, tzinfo=UTC)
TOKENS = {"access_token": "ya29.token", "scope": "openid email profile https://www.googleapis.com/auth/calendar.readonly"}


@pytest.fixture(autouse=True)
def configured(monkeypatch):
    monkeypatch.setattr(
        google, "get_settings", lambda: Settings(app_env="test", google_client_id="cid.apps.googleusercontent.com", google_client_secret="GOCSPX-secret")
    )


def _google(answer, seen: list[httpx.Request]) -> httpx.Client:
    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return answer(request)

    return httpx.Client(transport=httpx.MockTransport(handler))


def _form(request: httpx.Request) -> dict[str, str]:
    return {k: v[0] for k, v in parse_qs(request.content.decode(), keep_blank_values=True).items()}


def _event(summary: str, start: str | None, end: str | None, **more) -> dict:
    when = (lambda t: {"dateTime": t}) if start and "T" in start else (lambda t: {"date": t})
    return {"summary": summary, "start": when(start), "end": when(end), **more}


def test_the_trips_timed_appointments_come_back_and_not_those_declined_or_all_day():
    items = [
        _event("Dentist", "2026-10-14T10:00:00+05:30", "2026-10-14T10:45:00+05:30", location="Apollo Clinic, Jayanagar"),
        _event("Holiday", "2026-10-15", "2026-10-16"),
        _event("Team lunch", "2026-10-15T13:00:00+05:30", "2026-10-15T14:00:00+05:30", attendees=[{"self": True, "responseStatus": "declined"}]),
        _event("Client call", "2026-10-15T16:00:00+05:30", "2026-10-15T16:30:00+05:30", attendees=[{"self": True, "responseStatus": "accepted"}]),
    ]
    seen: list[httpx.Request] = []
    answers = {google.TOKEN_URL: httpx.Response(200, json=TOKENS), google.CALENDAR_EVENTS: httpx.Response(200, json={"items": items})}
    found = google.calendar_events("4/code", FROM, TO, _google(lambda r: answers[str(r.url).split("?")[0]], seen))
    assert [(e.title, e.location, e.start.hour, e.end.minute) for e in found] == [("Dentist", "Apollo Clinic, Jayanagar", 10, 45), ("Client call", "", 16, 30)]
    exchange, read = seen
    assert _form(exchange) == {
        "code": "4/code",
        "client_id": "cid.apps.googleusercontent.com",
        "client_secret": "GOCSPX-secret",
        "redirect_uri": "postmessage",
        "grant_type": "authorization_code",
    }
    assert read.headers["authorization"] == "Bearer ya29.token"
    assert read.url.params["timeMin"] == FROM.isoformat() and read.url.params["singleEvents"] == "true"


def test_an_android_code_is_tried_again_without_a_redirect_when_google_says_it_doesnt_match():
    seen: list[httpx.Request] = []

    def answer(request: httpx.Request) -> httpx.Response:
        if str(request.url) == google.TOKEN_URL:
            ok = _form(request)["redirect_uri"] == ""
            return httpx.Response(200, json=TOKENS) if ok else httpx.Response(400, json={"error": "redirect_uri_mismatch"})
        return httpx.Response(200, json={"items": []})

    assert google.calendar_events("4/android", FROM, TO, _google(answer, seen)) == []
    assert [_form(r)["redirect_uri"] for r in seen[:2]] == ["postmessage", ""]


@pytest.mark.parametrize(
    ("token", "events", "status", "code", "message"),
    [
        # The server's own client ID or secret is wrong: nothing the traveller can do.
        (httpx.Response(401, json={"error": "invalid_client"}), None, 503, "NOT_CONFIGURED", "Google sign-in isn't set up properly on this server."),
        # An old or used code.
        (httpx.Response(400, json={"error": "invalid_grant"}), None, 401, "UNAUTHENTICATED", "Google didn't accept that sign-in. Try again."),
        # Sign-in allowed, Calendar not.
        (httpx.Response(200, json={**TOKENS, "scope": "openid email"}), None, 403, "FORBIDDEN", "Allow read-only Calendar access to import appointments."),
        # The Google project hasn't switched the Calendar API on.
        (
            httpx.Response(200, json=TOKENS),
            httpx.Response(403, json={"error": {"code": 403, "errors": [{"reason": "accessNotConfigured"}]}}),
            503,
            "NOT_CONFIGURED",
            "Calendar import isn't switched on for this server's Google project yet.",
        ),
        (
            httpx.Response(200, json=TOKENS),
            httpx.Response(403, json={"error": {"code": 403, "status": "PERMISSION_DENIED", "details": [{"reason": "SERVICE_DISABLED"}]}}),
            503,
            "NOT_CONFIGURED",
            "Calendar import isn't switched on for this server's Google project yet.",
        ),
        (
            httpx.Response(200, json=TOKENS),
            httpx.Response(403, json={"error": {"errors": [{"reason": "insufficientPermissions"}]}}),
            403,
            "FORBIDDEN",
            "Allow read-only Calendar access to import appointments.",
        ),
        (httpx.Response(200, json=TOKENS), httpx.Response(500), 502, "UPSTREAM", "Couldn't read your calendar. Try again."),
    ],
)
def test_what_goes_wrong_is_said_plainly(token, events, status, code, message):
    def answer(request: httpx.Request) -> httpx.Response:
        return token if str(request.url) == google.TOKEN_URL else events

    with pytest.raises(ApiError) as caught:
        google.calendar_events("4/code", FROM, TO, _google(answer, []))
    assert (caught.value.status, caught.value.code, caught.value.message) == (status, code, message)


def test_google_out_of_reach_is_a_bad_gateway_not_a_crash():
    def down(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectTimeout("no answer")

    with pytest.raises(ApiError) as caught:
        google.calendar_events("4/code", FROM, TO, _google(down, []))
    assert (caught.value.status, caught.value.message) == (502, "Couldn't reach Google. Try again.")


def test_settings_copied_with_the_guides_brackets_still_work():
    s = Settings(app_env="test", google_client_id=" <cid.apps.googleusercontent.com> ", google_client_secret="<GOCSPX-secret>")
    assert (s.google_client_id, s.google_client_secret) == ("cid.apps.googleusercontent.com", "GOCSPX-secret")
    assert Settings(app_env="test", google_client_secret="GOCSPX-plain").google_client_secret == "GOCSPX-plain"
