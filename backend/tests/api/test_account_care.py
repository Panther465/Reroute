"""Looking after an account: confirming its email, resetting a forgotten password by email, changing the password
and the name, downloading a copy of the data, deleting the account; and changing a trip's dates or stay."""

from __future__ import annotations

import re
from datetime import UTC, datetime, timedelta

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select, update

from app.adapters import mail
from app.config import get_settings
from app.db import session_scope
from app.main import app
from app.models import EmailToken, Place, RefreshToken, Trip, User
from app.services import accounts

from .conftest import key
from .test_own_places import add, moderator

PASSWORD = "a long password"


class Outbox(list):
    def links(self, kind: str) -> list[str]:
        return [m for msg in self for m in re.findall(rf"/{kind}#token=([A-Za-z0-9_-]+)", msg["text"])]


@pytest.fixture
def outbox(monkeypatch) -> Outbox:
    """Email on, with every message kept here instead of sent."""
    sent = Outbox()
    monkeypatch.setattr(get_settings(), "smtp_host", "mailpit")
    monkeypatch.setattr(mail, "send", lambda to, subject, text, html=None: sent.append({"to": to, "subject": subject, "text": text, "html": html}))
    return sent


class _Collection:
    def __init__(self, rows: list[dict]):
        self.rows = rows

    def find(self, query, _projection=None):
        return _Cursor([dict(r) for r in self.rows if r["userId"] == query["userId"]])

    def delete_many(self, query):
        self.rows[:] = [r for r in self.rows if r["userId"] != query["userId"]]


class _Cursor(list):
    def limit(self, _n):
        return self


class FakeMongo:
    def __init__(self, rows: list[dict] | None = None, down: bool = False):
        self.rows, self.down = rows if rows is not None else [], down

    def get_default_database(self):
        if self.down:
            raise ConnectionError("Mongo is down")
        return {"location_timeline": _Collection(self.rows)}

    def close(self):
        pass


@pytest.fixture
def mongo(monkeypatch) -> FakeMongo:
    fake = FakeMongo()
    monkeypatch.setattr(accounts, "_mongo", lambda: fake)
    return fake


@pytest.fixture
def raasta(monkeypatch) -> list[str]:
    """Raasta's side of deleting an account, recorded: the Authorization header it was asked with."""
    calls: list[str] = []
    monkeypatch.setattr(accounts, "erase_from_raasta", calls.append)
    return calls


def guest() -> TestClient:
    return TestClient(app, base_url="https://testserver")


def sign_up(name: str = "Asha Rao", email: str = "asha@example.com", password: str = PASSWORD) -> tuple[TestClient, dict]:
    c = guest()
    res = c.post("/v1/auth/signup", json={"name": name, "email": email, "password": password})
    assert res.status_code == 201, res.text
    body = res.json()
    c.headers["Authorization"] = f"Bearer {body['accessToken']}"
    return c, body


def sign_in(email: str = "asha@example.com", password: str = PASSWORD):
    return guest().post("/v1/auth/login", json={"email": email, "password": password})


# ---------- confirming the email ----------


@pytest.mark.db
def test_without_email_the_server_offers_no_reset_and_says_so(client):
    assert client.get("/v1/auth/options").json()["passwordReset"] is False
    res = guest().post("/v1/auth/password/forgot", json={"email": "asha@example.com"})
    assert res.status_code == 503 and res.json()["error"]["code"] == "EMAIL_OFF"
    c, body = sign_up()
    assert body["user"]["emailVerified"] is False and body["user"]["hasPassword"] is True
    assert body["user"]["features"]["email"] is False
    assert c.post("/v1/me/verification-email", json={"idempotencyKey": key()}).status_code == 503


@pytest.mark.db
def test_a_new_account_is_emailed_a_link_that_confirms_its_address_once(client, outbox):
    assert client.get("/v1/auth/options").json()["passwordReset"] is True
    c, body = sign_up()
    assert [m["to"] for m in outbox] == ["asha@example.com"] and outbox[0]["subject"] == "Confirm your email for Reroute"
    assert "Hi Asha," in outbox[0]["text"] and "Confirm my email" in outbox[0]["html"]
    [token] = outbox.links("verify-email")
    # Only the link's hash is kept.
    with session_scope() as db:
        assert db.scalar(select(EmailToken.token_hash).where(EmailToken.user_id == body["user"]["userId"])) != token

    assert c.get("/v1/me").json()["emailVerified"] is False
    assert guest().post("/v1/auth/email/verify", json={"token": token}).status_code == 204
    assert c.get("/v1/me").json()["emailVerified"] is True
    again = guest().post("/v1/auth/email/verify", json={"token": token})
    assert again.status_code == 400 and again.json()["error"]["code"] == "LINK_INVALID"
    assert c.post("/v1/me/verification-email", json={"idempotencyKey": key()}).json()["error"]["code"] == "ALREADY_VERIFIED"


@pytest.mark.db
def test_asking_for_the_link_again_waits_a_minute_and_only_the_newest_link_works(client, outbox):
    c, _ = sign_up()
    first = outbox.links("verify-email")[0]
    res = c.post("/v1/me/verification-email", json={"idempotencyKey": key()})
    assert res.status_code == 429 and res.headers["Retry-After"] == "60" and len(outbox) == 1
    from app.redis_client import get_redis

    for k in get_redis().scan_iter("mail:verify:*:minute"):
        get_redis().delete(k)
    assert c.post("/v1/me/verification-email", json={"idempotencyKey": key()}).status_code == 202
    second = outbox.links("verify-email")[1]
    assert guest().post("/v1/auth/email/verify", json={"token": first}).status_code == 400
    assert guest().post("/v1/auth/email/verify", json={"token": second}).status_code == 204


# ---------- a forgotten password ----------


@pytest.mark.db
def test_a_forgotten_password_is_reset_by_email_and_signs_out_everywhere(client, outbox):
    c, body = sign_up()
    other = sign_in().json()["accessToken"]
    outbox.clear()

    # The same answer for an email no account has, and nothing sent.
    assert guest().post("/v1/auth/password/forgot", json={"email": "nobody@example.com"}).status_code == 202
    assert outbox == []
    assert guest().post("/v1/auth/password/forgot", json={"email": "ASHA@example.com"}).status_code == 202
    assert outbox[0]["subject"] == "Reset your Reroute password" and "works for an hour" in outbox[0]["text"]
    [token] = outbox.links("reset-password")

    short = guest().post("/v1/auth/password/reset", json={"token": token, "password": "short"})
    assert short.status_code == 422
    assert guest().post("/v1/auth/password/reset", json={"token": token, "password": "a brand new password"}).status_code == 204

    assert sign_in().status_code == 401
    assert sign_in(password="a brand new password").status_code == 200
    # Every earlier sign-in ends: access tokens at once, refresh tokens too.
    assert c.get("/v1/me").status_code == 401
    assert guest().get("/v1/me", headers={"Authorization": f"Bearer {other}"}).status_code == 401
    with session_scope() as db:
        live = db.scalars(select(RefreshToken).where(RefreshToken.user_id == body["user"]["userId"], RefreshToken.revoked_at.is_(None))).all()
        assert len(live) == 1  # the sign-in just made with the new password
        user = db.get(User, body["user"]["userId"])
        # The reset link reached their inbox: the address is theirs.
        assert user.email_verified_at is not None

    assert guest().post("/v1/auth/password/reset", json={"token": token, "password": "yet another password"}).status_code == 400


@pytest.mark.db
def test_a_reset_link_stops_working_after_an_hour(client, outbox):
    sign_up()
    guest().post("/v1/auth/password/forgot", json={"email": "asha@example.com"})
    [token] = outbox.links("reset-password")
    with session_scope() as db:
        db.execute(update(EmailToken).where(EmailToken.purpose == "reset").values(expires_at=datetime.now(UTC) - timedelta(seconds=1)))
    res = guest().post("/v1/auth/password/reset", json={"token": token, "password": "a brand new password"})
    assert res.status_code == 400 and "expired" in res.json()["error"]["message"]


@pytest.mark.db
def test_reset_emails_to_one_account_are_spaced_out(client, outbox):
    sign_up()
    outbox.clear()
    for _ in range(3):
        assert guest().post("/v1/auth/password/forgot", json={"email": "asha@example.com"}).status_code == 202
    assert len(outbox) == 1


# ---------- changing the password and the name ----------


@pytest.mark.db
def test_changing_the_password_keeps_this_sign_in_and_ends_the_others(client):
    c, _ = sign_up()
    other = sign_in().json()["accessToken"]
    wrong = c.post("/v1/me/password", json={"currentPassword": "not it", "newPassword": "a brand new password"})
    assert wrong.status_code == 403 and wrong.json()["error"]["code"] == "WRONG_PASSWORD"

    res = c.post("/v1/me/password", json={"currentPassword": PASSWORD, "newPassword": "a brand new password"})
    assert res.status_code == 200, res.text
    fresh = res.json()["accessToken"]
    assert guest().get("/v1/me", headers={"Authorization": f"Bearer {fresh}"}).status_code == 200
    assert c.get("/v1/me").status_code == 401  # this sign-in's old token
    assert guest().get("/v1/me", headers={"Authorization": f"Bearer {other}"}).status_code == 401
    # This sign-in's refresh token still works; the other's doesn't.
    assert c.post("/v1/auth/refresh", headers={"X-CSRF-Token": c.cookies.get("rr_csrf")}).status_code == 200
    assert sign_in(password="a brand new password").status_code == 200


@pytest.mark.db
def test_a_google_account_has_no_password_to_change(client):
    with session_scope() as db:
        db.add(User(user_id="usr-google", google_sub="g-1", email="g@example.com", name="Gita", role="traveller", email_verified_at=datetime.now(UTC)))
    from app.security import issue_access_token

    with session_scope() as db:
        token, _ = issue_access_token(db.get(User, "usr-google"))
    me = guest().get("/v1/me", headers={"Authorization": f"Bearer {token}"}).json()
    assert me["hasPassword"] is False and me["emailVerified"] is True
    res = guest().post("/v1/me/password", json={"currentPassword": "x", "newPassword": "a brand new password"}, headers={"Authorization": f"Bearer {token}"})
    assert res.status_code == 409 and res.json()["error"]["code"] == "NO_PASSWORD"


@pytest.mark.db
def test_the_name_can_change_but_not_the_demo_accounts(client):
    c, _ = sign_up()
    res = c.patch("/v1/me", json={"name": "  Asha R.  "})
    assert res.status_code == 200 and res.json()["name"] == "Asha R."
    assert c.patch("/v1/me", json={"name": ""}).status_code == 422
    assert client.patch("/v1/me", json={"name": "Someone"}).json()["error"]["code"] == "DEMO_ACCOUNT"


# ---------- a copy of the data ----------


@pytest.mark.db
def test_a_copy_of_the_data_has_trips_places_and_wallet_but_no_secrets(client, mongo):
    c, body = sign_up()
    mine = add(client, c.headers, name="Aunt's flat", note="Ring twice")
    trip = _trip(c, stay=mine["placeId"])
    c.post(f"/v1/trips/{trip['tripId']}/tasks", json={"title": "Meeting", "placeId": "whitefield-office", "durationMin": 60, "idempotencyKey": key()})
    mongo.rows.append({"userId": body["user"]["userId"], "at": "2030-01-15T09:00:00+05:30"})

    res = c.get("/v1/me/export")
    assert res.status_code == 200
    assert res.headers["content-disposition"].startswith('attachment; filename="reroute-data-') and res.headers["cache-control"] == "no-store"
    data = res.json()
    assert data["account"]["email"] == "asha@example.com" and "passwordHash" not in data["account"]
    assert [t["tripId"] for t in data["trips"]] == [trip["tripId"]]
    assert [t["title"] for t in data["trips"][0]["tasks"]] == ["Meeting"]
    assert [p["note"] for p in data["places"]] == ["Ring twice"]
    assert [w["kind"] for w in data["wallet"]] == ["welcome"]
    assert data["locationHistory"] == [{"userId": body["user"]["userId"], "at": "2030-01-15T09:00:00+05:30"}]
    assert len(data["signIns"]) == 1 and "tokenHash" not in data["signIns"][0]
    assert "a long password" not in res.text and "scrypt$" not in res.text


# ---------- deleting the account ----------


@pytest.mark.db
def test_deleting_an_account_takes_everything_but_what_others_still_use(client, mongo, raasta):
    c, body = sign_up()
    uid = body["user"]["userId"]
    private = add(client, c.headers, name="Aunt's flat")
    shared = add(client, c.headers, name="Chai stall", category="food", note="Ask for Ravi", share=True)
    used = add(client, c.headers, name="Tiffin centre", category="food", share=True)
    mod = moderator(client)
    for place in (shared, used):
        assert client.post(f"/v1/places/{place['placeId']}/approve", json={"idempotencyKey": key()}, headers=mod).status_code == 200
    trip = {"citySlug": "bengaluru", "cityName": "Bengaluru", "startDate": "2030-01-15", "endDate": "2030-01-15", "stayLabel": "Home"}
    mine = c.post("/v1/trips", json={**trip, "stayPlaceId": private["placeId"], "idempotencyKey": key()}).json()
    # Someone else's trip stays at one of Asha's places.
    theirs = client.post("/v1/trips", json={**trip, "stayPlaceId": used["placeId"], "idempotencyKey": key()})
    assert theirs.status_code == 201, theirs.text
    mongo.rows.append({"userId": uid, "at": "x"})
    mongo.rows.append({"userId": "usr-demo-traveller", "at": "y"})

    wrong = c.post("/v1/me/delete", json={"password": "not it"})
    assert wrong.status_code == 403 and wrong.json()["error"]["code"] == "WRONG_PASSWORD"
    assert c.post("/v1/me/delete", json={}).status_code == 403

    res = c.post("/v1/me/delete", json={"password": PASSWORD})
    assert res.status_code == 204, res.text
    assert raasta == [c.headers["Authorization"]]
    assert mongo.rows == [{"userId": "usr-demo-traveller", "at": "y"}]
    assert c.get("/v1/me").status_code == 401
    assert sign_in().status_code == 401
    with session_scope() as db:
        assert db.get(User, uid) is None
        assert db.get(Trip, mine["tripId"]) is None
        assert db.get(Place, private["placeId"]) is None
        # A place everyone can find, and one another trip goes to, stay without their owner or note.
        for place in (shared, used):
            kept = db.get(Place, place["placeId"])
            assert kept is not None and kept.owner_id is None and kept.note is None
    assert client.get(f"/v1/trips/{theirs.json()['tripId']}").status_code == 200


@pytest.mark.db
def test_nothing_is_deleted_when_raasta_or_mongo_cant_be_reached(client, monkeypatch, raasta):
    c, body = sign_up()

    def raasta_down(_auth):
        from app.errors import ApiError

        raise ApiError(503, "Couldn't reach Raasta to remove your routes, so nothing was deleted. Try again in a minute.", code="UNAVAILABLE")

    monkeypatch.setattr(accounts, "erase_from_raasta", raasta_down)
    assert c.post("/v1/me/delete", json={"password": PASSWORD}).status_code == 503
    monkeypatch.setattr(accounts, "erase_from_raasta", lambda _auth: None)
    monkeypatch.setattr(accounts, "_mongo", lambda: FakeMongo(down=True))
    assert c.post("/v1/me/delete", json={"password": PASSWORD}).status_code == 503
    with session_scope() as db:
        assert db.get(User, body["user"]["userId"]) is not None


@pytest.mark.db
def test_a_google_account_confirms_deletion_with_its_email_and_the_demo_cant_be_deleted(client, mongo, raasta):
    with session_scope() as db:
        db.add(User(user_id="usr-google", google_sub="g-1", email="g@example.com", name="Gita", role="traveller"))
    from app.security import issue_access_token

    with session_scope() as db:
        token, _ = issue_access_token(db.get(User, "usr-google"))
    g = guest()
    g.headers["Authorization"] = f"Bearer {token}"
    assert g.post("/v1/me/delete", json={"email": "other@example.com"}).json()["error"]["code"] == "WRONG_EMAIL"
    assert g.post("/v1/me/delete", json={"email": "G@Example.com"}).status_code == 204
    assert client.post("/v1/me/delete", json={"password": "x"}).json()["error"]["code"] == "DEMO_ACCOUNT"


def test_raasta_is_asked_as_the_traveller_and_a_failure_stops_the_deletion(monkeypatch):
    import httpx

    from app.errors import ApiError

    seen = {}

    def answer(status):
        def delete(url, headers, timeout):
            seen.update(url=url, headers=headers)
            return httpx.Response(status)

        return delete

    monkeypatch.setattr(httpx, "delete", answer(204))
    accounts.erase_from_raasta("Bearer abc")
    assert seen["url"].endswith("/v1/raasta/me") and seen["headers"] == {"Authorization": "Bearer abc"}
    monkeypatch.setattr(httpx, "delete", answer(500))
    with pytest.raises(ApiError) as err:
        accounts.erase_from_raasta("Bearer abc")
    assert err.value.status == 503


# ---------- changing a trip ----------


def _trip(c, start="2030-01-15", end="2030-01-16", stay="hotel-majestic") -> dict:
    trip = {"citySlug": "bengaluru", "cityName": "Bengaluru", "startDate": start, "endDate": end, "stayPlaceId": stay, "stayLabel": "Hotel"}
    res = c.post("/v1/trips", json={**trip, "idempotencyKey": key()})
    assert res.status_code == 201, res.text
    return res.json()


@pytest.mark.db
def test_a_trips_dates_and_stay_can_change_but_not_past_its_tasks(client):
    c, _ = sign_up()
    trip = _trip(c)
    url = f"/v1/trips/{trip['tripId']}"
    c.post(f"{url}/tasks", json={"title": "Meeting", "placeId": "whitefield-office", "durationMin": 60, "day": "2030-01-16", "idempotencyKey": key()})

    res = c.patch(url, json={"endDate": "2030-01-18"})
    assert res.status_code == 200, res.text
    assert (res.json()["trip"]["startDate"], res.json()["trip"]["endDate"]) == ("2030-01-15", "2030-01-18")

    blocked = c.patch(url, json={"startDate": "2030-01-17"})
    assert blocked.status_code == 409 and blocked.json()["error"]["code"] == "TASKS_OUTSIDE_DATES"
    assert blocked.json()["error"]["message"] == "You have a task on days outside those dates. Move or remove them first."
    assert c.patch(url, json={"endDate": "2030-02-15"}).status_code == 422
    assert c.patch(url, json={"startDate": "2030-01-19"}).status_code == 422

    mine = add(client, c.headers, name="Aunt's flat")
    res = c.patch(url, json={"stayPlaceId": mine["placeId"], "stayLabel": "Aunt's flat"})
    assert res.status_code == 200 and res.json()["trip"]["stayLabel"] == "Aunt's flat"
    assert c.patch(url, json={"stayPlaceId": "hotel-majestic"}).status_code == 422  # without its label
    # Someone else's private place is as good as missing.
    other = add(client, name="Demo's flat")
    assert c.patch(url, json={"stayPlaceId": other["placeId"], "stayLabel": "x"}).status_code == 422
    assert c.patch(url, json={"stayPlaceId": "hotel-majestic", "stayLabel": "Hotel"}).status_code == 200
    # Nobody else's to change.
    assert client.patch(url, json={"endDate": "2030-01-17"}).status_code == 404


@pytest.mark.db
def test_the_sample_trip_stays_as_it_is(client):
    res = client.patch("/v1/trips/trip-001", json={"endDate": "2026-10-16"})
    assert res.status_code == 409 and res.json()["error"]["code"] == "SAMPLE_TRIP"


@pytest.mark.db
def test_a_new_stay_re_plans_a_day_that_has_a_plan(client):
    c, _ = sign_up()
    trip = _trip(c, end="2030-01-15")
    url = f"/v1/trips/{trip['tripId']}"
    c.post(f"{url}/tasks", json={"title": "Meeting", "placeId": "whitefield-office", "durationMin": 60, "idempotencyKey": key()})
    planned = c.post(f"{url}/plans", json={"idempotencyKey": key()})
    assert planned.status_code == 202, planned.text
    res = c.patch(url, json={"stayPlaceId": "jayanagar-office", "stayLabel": "Friend's office"})
    assert res.status_code == 200 and res.json()["jobId"]
    assert c.patch(url, json={"endDate": "2030-01-16"}).json()["jobId"] is None


# ---------- the email itself ----------


def test_an_email_goes_over_starttls_with_a_login(monkeypatch):
    s = get_settings()
    for name, value in {"smtp_host": "smtp.example.com", "smtp_port": 587, "smtp_security": "starttls", "smtp_user": "u", "smtp_password": "p"}.items():
        monkeypatch.setattr(s, name, value)
    calls = []

    class FakeSmtp:
        def __init__(self, host, port, timeout):
            calls.append(("connect", host, port))

        def __enter__(self):
            return self

        def __exit__(self, *exc):
            return False

        def starttls(self, context):
            calls.append(("starttls",))

        def login(self, user, password):
            calls.append(("login", user))

        def send_message(self, msg):
            calls.append(("send", msg["To"], msg["Subject"], msg.get_content_type()))

    monkeypatch.setattr(mail.smtplib, "SMTP", FakeSmtp)
    mail.send("asha@example.com", "Hello", "Text", "<p>Text</p>")
    assert calls == [("connect", "smtp.example.com", 587), ("starttls",), ("login", "u"), ("send", "asha@example.com", "Hello", "multipart/alternative")]
    monkeypatch.setattr(s, "smtp_host", "")
    with pytest.raises(mail.MailOff):
        mail.send("asha@example.com", "Hello", "Text")


def test_the_link_travels_in_the_fragment_and_names_only_the_first_name():
    user = User(user_id="u", email="asha@example.com", name="Asha Rao", role="traveller")
    subject, text, page = accounts.link_email(user, "reset", "TOKEN123")
    assert subject == "Reset your Reroute password"
    assert "/reset-password#token=TOKEN123" in text and "?" not in text.split("#")[0].rsplit("/", 1)[-1]
    assert "Hi Asha," in text and "Rao" not in text and "/reset-password#token=TOKEN123" in page


def test_an_unchecked_address_is_left_out_of_an_email_link():
    # A message link built from a user's name can't inject markup.
    user = User(user_id="u", email="a@example.com", name="<b>Asha</b>", role="traveller")
    _, _, page = accounts.link_email(user, "verify", "T")
    assert "<b>Asha</b>" not in page and "&lt;b&gt;Asha&lt;/b&gt;" in page


# ---------- error reports ----------


def test_error_reports_are_off_without_a_dsn_and_never_carry_secrets(monkeypatch):
    from app import monitoring

    assert monitoring.start("api") is False
    event = {
        "request": {
            "url": "https://reroute.example/v1/shared/SECRET123/trip?q=bank",
            "query_string": "q=bank",
            "cookies": {"rr_refresh": "x"},
            "data": {"password": "hunter22"},
            "headers": {"Authorization": "Bearer abc", "User-Agent": "Phone", "X-CSRF-Token": "c", "X-Request-ID": "t1"},
        },
        "user": {"id": "usr-1", "email": "asha@example.com", "ip_address": "1.2.3.4"},
    }
    out = monitoring.scrub(event)
    assert out["request"] == {"url": "https://reroute.example/v1/shared/***/trip", "headers": {"User-Agent": "Phone", "X-Request-ID": "t1"}}
    assert out["user"] == {"id": "usr-1"}

    started = {}
    import sentry_sdk

    monkeypatch.setattr(get_settings(), "sentry_dsn", "https://key@o1.ingest.sentry.io/1")
    monkeypatch.setattr(sentry_sdk, "init", lambda **kw: started.update(kw))
    monkeypatch.setattr(sentry_sdk, "set_tag", lambda k, v: started.update(tag=(k, v)))
    assert monitoring.start("worker") is True
    assert started["send_default_pii"] is False and started["include_local_variables"] is False and started["tag"] == ("component", "worker")
