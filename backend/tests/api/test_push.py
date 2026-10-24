"""Push notifications to the Android app: Firebase Cloud Messaging (HTTP v1), the phones a traveller registers,
and the alerts that go out as pushes (leave-by, and the morning plan)."""

from __future__ import annotations

import json
from datetime import UTC, datetime, timedelta

import httpx
import jwt
import pytest
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from fastapi.testclient import TestClient
from sqlalchemy import update

from app.adapters import fcm
from app.config import Settings, get_settings
from app.db import session_scope
from app.main import app
from app.models import PushDevice, RefreshToken
from app.security import decode_access_token, sha256
from app.services import push
from app.workers.scheduler import tick

from .conftest import key

KEY = rsa.generate_private_key(public_exponent=65537, key_size=2048)
PEM = KEY.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8, serialization.NoEncryption()).decode()
ACCOUNT = fcm.ServiceAccount(
    project_id="reroute-test", client_email="push@reroute-test.iam.gserviceaccount.com", private_key=PEM, private_key_id="k1", token_uri=fcm.TOKEN_URI
)
PHONE = "phone-token-" + "a" * 40


def firebase(answers: list[httpx.Response] | None = None, seen: list[httpx.Request] | None = None) -> fcm.Fcm:
    """Google's token endpoint and Firebase's send endpoint, answering from `answers` in turn (200 when empty)."""
    queue = list(answers or [])

    def handler(request: httpx.Request) -> httpx.Response:
        if seen is not None:
            seen.append(request)
        if request.url == fcm.TOKEN_URI:
            form = dict(x.split("=", 1) for x in request.content.decode().split("&"))
            claims = jwt.decode(form["assertion"], KEY.public_key(), algorithms=["RS256"], audience=fcm.TOKEN_URI)
            assert claims["iss"] == ACCOUNT.client_email and claims["scope"] == fcm.SCOPE
            return httpx.Response(200, json={"access_token": f"at-{len(seen or [])}", "expires_in": 3600})
        return queue.pop(0) if queue else httpx.Response(200, json={"name": "projects/reroute-test/messages/1"})

    return fcm.Fcm(ACCOUNT, client=httpx.Client(transport=httpx.MockTransport(handler)))


def gone(code: str, status: int = 404) -> httpx.Response:
    details = [{"@type": "type.googleapis.com/google.firebase.fcm.v1.FcmError", "errorCode": code}]
    return httpx.Response(status, json={"error": {"code": status, "status": "NOT_FOUND", "details": details}})


# ---------- Firebase itself ----------


def test_signs_in_as_the_service_account_once_and_sends_a_data_message(fake_redis):
    seen: list[httpx.Request] = []
    sender = firebase(seen=seen)
    assert sender.send(PHONE, {"kind": "leave_now", "body": "Leave now."}, 300) == "sent"
    assert sender.send(PHONE, {"kind": "leave_now", "body": "Leave now."}, 300) == "sent"
    sign_ins = [r for r in seen if r.url == fcm.TOKEN_URI]
    sends = [r for r in seen if r.url != fcm.TOKEN_URI]
    assert len(sign_ins) == 1 and len(sends) == 2  # the access token is kept (in Redis) for the next one
    assert str(sends[0].url) == "https://fcm.googleapis.com/v1/projects/reroute-test/messages:send"
    assert sends[0].headers["Authorization"].startswith("Bearer at-")
    message = json.loads(sends[0].content)["message"]
    # Data only, at high priority: the app shows it itself, so it replaces the app's own alert for that moment.
    assert message == {"token": PHONE, "data": {"kind": "leave_now", "body": "Leave now."}, "android": {"priority": "HIGH", "ttl": "300s"}}


def test_each_service_account_keeps_its_own_access_token(fake_redis):
    seen: list[httpx.Request] = []
    firebase(seen=seen).send(PHONE, {}, 60)
    # A new key (or another project) signs in for itself instead of borrowing the old key's token.
    other = fcm.Fcm(
        fcm.ServiceAccount(**{**ACCOUNT.__dict__, "private_key_id": "k2"}),
        client=firebase(seen=seen).http,
    )
    other.send(PHONE, {}, 60)
    assert len([r for r in seen if r.url == fcm.TOKEN_URI]) == 2


def test_an_access_token_refused_before_its_time_is_renewed_once(fake_redis):
    seen: list[httpx.Request] = []
    assert firebase([httpx.Response(401)], seen).send(PHONE, {"kind": "morning"}, 60) == "sent"
    assert len([r for r in seen if r.url == fcm.TOKEN_URI]) == 2


def test_only_a_phone_firebase_no_longer_knows_is_gone(fake_redis):
    assert firebase([gone("UNREGISTERED")]).send(PHONE, {}, 60) == "gone"
    assert firebase([gone("SENDER_ID_MISMATCH", 403)]).send(PHONE, {}, 60) == "gone"
    # A busy server or a message Firebase didn't like leaves the phone registered.
    assert firebase([httpx.Response(503)]).send(PHONE, {}, 60) == "failed"
    assert firebase([gone("INVALID_ARGUMENT", 400)]).send(PHONE, {}, 60) == "failed"


def test_no_key_no_push(tmp_path, caplog):
    assert fcm.load_account("") is None
    assert fcm.load_account(str(tmp_path / "missing.json")) is None
    placeholder = tmp_path / "none.json"
    placeholder.write_text("{}")
    assert fcm.load_account(str(placeholder)) is None
    assert "service account" not in caplog.text
    # The app's google-services.json in place of the server's key: said out loud, since nothing else would.
    app_file = tmp_path / "google-services.json"
    app_file.write_text(json.dumps({"project_info": {"project_id": "p"}, "client": []}))
    assert fcm.load_account(str(app_file)) is None
    assert "isn't a service account key" in caplog.text
    real = tmp_path / "key.json"
    real.write_text(json.dumps({"type": "service_account", "project_id": "p", "client_email": "e@p.iam", "private_key": PEM, "private_key_id": "k"}))
    assert fcm.load_account(str(real)) == fcm.ServiceAccount("p", "e@p.iam", PEM, "k", fcm.TOKEN_URI)


def test_the_leave_by_words_are_the_apps():
    assert push.leave_text(9, "Metro, then shared auto") == "Leave in 9 min. Metro, then shared auto."
    assert push.leave_text(0, "Cab to the bank") == "Leave now. Cab to the bank."


# ---------- the phones, and the alerts that reach them ----------


class Recorder:
    """Firebase, as far as the push job sees it."""

    def __init__(self, outcome: fcm.Outcome = "sent") -> None:
        self.outcome = outcome
        self.sent: list[tuple[str, dict, int]] = []

    def __call__(self, account: fcm.ServiceAccount) -> Recorder:
        return self

    def send(self, token: str, data: dict[str, str], ttl_seconds: int) -> fcm.Outcome:
        self.sent.append((token, data, ttl_seconds))
        return self.outcome


@pytest.fixture(autouse=True)
def push_offered(monkeypatch, fake_redis):
    """A deployment that offers push: FCM_PUSH on, and the worker started with a usable key."""
    monkeypatch.setattr(get_settings(), "fcm_push", True)
    fake_redis.set(push.READY_KEY, "reroute-test")


@pytest.fixture
def firebase_on(monkeypatch):
    recorder = Recorder()
    monkeypatch.setattr(fcm, "configured_account", lambda: ACCOUNT)
    monkeypatch.setattr(push, "sender_factory", recorder)
    return recorder


def register(c, token: str = PHONE):
    res = c.post("/v1/me/push-devices", json={"token": token, "platform": "android", "idempotencyKey": key()})
    assert res.status_code == 200, res.text
    return res.json()["deviceId"]


def phones() -> dict[str, str]:
    with session_scope() as db:
        return {d.device_id: d.user_id for d in db.query(PushDevice)}


def someone_else():
    c = TestClient(app, base_url="https://testserver")
    body = {"name": "Asha Rao", "email": f"asha.{key()}@example.com", "password": "rerouting-is-fun", "idempotencyKey": key()}
    c.headers["Authorization"] = f"Bearer {c.post('/v1/auth/signup', json=body).json()['accessToken']}"
    return c


@pytest.mark.db
def test_the_app_is_told_when_alerts_come_as_pushes(client, monkeypatch, fake_redis):
    # Under Docker Compose the API never holds the key: FCM_PUSH says one is set, and the worker says it loaded.
    assert client.get("/v1/me").json()["features"]["push"] is True
    fake_redis.delete(push.READY_KEY)
    assert client.get("/v1/me").json()["features"]["push"] is False
    monkeypatch.setattr(get_settings(), "fcm_push", False)
    assert client.get("/v1/me").json()["features"]["push"] is False
    # A process that holds the key itself.
    monkeypatch.setattr(fcm, "configured_account", lambda: ACCOUNT)
    assert client.get("/v1/me").json()["features"]["push"] is True


def test_the_worker_says_whether_its_key_loaded(monkeypatch, fake_redis, caplog):
    monkeypatch.setattr(fcm, "configured_account", lambda: ACCOUNT)
    assert push.announce() is True
    assert fake_redis.get(push.READY_KEY) == "reroute-test"
    # Started again without a usable key (a wrong file, or one it may not read): no pushes, and the log says so.
    monkeypatch.setattr(fcm, "configured_account", lambda: None)
    assert push.announce() is False
    assert not fake_redis.exists(push.READY_KEY)
    assert "no usable Firebase key" in caplog.text


@pytest.mark.db
def test_a_server_without_push_keeps_no_phones(client, fake_redis):
    fake_redis.delete(push.READY_KEY)
    res = client.post("/v1/me/push-devices", json={"token": PHONE, "platform": "android", "idempotencyKey": key()})
    assert res.status_code == 409 and res.json()["error"]["code"] == "PUSH_OFF"
    assert phones() == {}


def test_fcm_push_is_off_when_compose_leaves_it_blank(monkeypatch):
    monkeypatch.setenv("FCM_PUSH", "")
    assert Settings().fcm_push is False
    monkeypatch.setenv("FCM_PUSH", "true")
    assert Settings().fcm_push is True


@pytest.mark.db
def test_a_phone_belongs_to_whoever_registered_it_last(client):
    device = register(client)
    assert device == sha256(PHONE)
    owner = phones()[device]
    other = someone_else()
    assert register(other) == device
    assert phones()[device] != owner  # the earlier traveller's alerts stop coming to this phone
    # Only its owner can take it off.
    assert client.delete(f"/v1/me/push-devices/{device}").status_code == 204
    assert device in phones()
    assert other.delete(f"/v1/me/push-devices/{device}").status_code == 204
    assert device not in phones()
    assert client.delete("/v1/me/push-devices/not-a-device").status_code == 422


@pytest.mark.db
def test_a_traveller_keeps_ten_phones_at_most(client):
    for n in range(11):
        register(client, f"{PHONE}-{n:02d}")
    assert len(phones()) == 10 and sha256(f"{PHONE}-00") not in phones()


def plan_and_set_clock(c, when: str):
    assert c.post("/v1/trips/trip-001/plans", json={"idempotencyKey": key()}).status_code == 202
    assert c.post("/v1/trips/trip-001/demo/clock", json={"now": when, "idempotencyKey": key()}).status_code == 200


@pytest.mark.db
def test_a_leave_by_alert_goes_to_the_phones_as_a_push(client, firebase_on):
    register(client)
    plan_and_set_clock(client, "2026-10-14T08:41:00+05:30")  # 9 minutes before the 08:50 departure
    assert client.post("/v1/trips/trip-001/demo/check", json={"idempotencyKey": key()}).status_code == 200
    [(token, data, ttl)] = firebase_on.sent
    assert token == PHONE and 9 * 60 - 5 <= ttl <= 9 * 60
    assert data["kind"] == "leave_now" and data["tag"] == "leave-1" and data["seq"] == "1" and data["tripId"] == "trip-001"
    assert data["title"] == "Reroute" and data["body"].startswith("Leave in 9 min. ")
    # Each alert goes out once.
    client.post("/v1/trips/trip-001/demo/check", json={"idempotencyKey": key()})
    assert len(firebase_on.sent) == 1


@pytest.mark.db
def test_a_phone_firebase_no_longer_knows_is_forgotten(client, firebase_on):
    register(client)
    firebase_on.outcome = "gone"
    plan_and_set_clock(client, "2026-10-14T08:50:00+05:30")
    client.post("/v1/trips/trip-001/demo/check", json={"idempotencyKey": key()})
    assert firebase_on.sent and firebase_on.sent[0][1]["body"].startswith("Leave now. ")
    assert phones() == {}


@pytest.mark.db
def test_no_push_without_firebase(client, monkeypatch):
    recorder = Recorder()
    monkeypatch.setattr(push, "sender_factory", recorder)
    register(client)
    plan_and_set_clock(client, "2026-10-14T08:41:00+05:30")
    client.post("/v1/trips/trip-001/demo/check", json={"idempotencyKey": key()})
    assert recorder.sent == []


@pytest.mark.db
def test_the_morning_plan_goes_out_as_a_push(client, firebase_on):
    register(client)
    plan_and_set_clock(client, "2026-10-15T06:30:00+05:30")
    assert tick(datetime(2026, 10, 15, 0, 30, tzinfo=UTC)) == 1
    morning = [(data, ttl) for _, data, ttl in firebase_on.sent if data["kind"] == "morning"]
    assert len(morning) == 1
    data, ttl = morning[0]
    # The tag the web app gives the same alert, so the two replace each other on the phone.
    assert data == {
        "kind": "morning",
        "title": "Reroute",
        "body": "Your day is planned. Open Today to see when to leave.",
        "tag": "morning-trip-001-2",
        "tripId": "trip-001",
    }
    assert 3 * 3600 - 5 <= ttl <= 3 * 3600


ANDROID = {"X-Reroute-Client": "android"}


def app_signed_in() -> tuple[TestClient, str]:
    """The Android app, signed in: its client, and the refresh token it keeps."""
    c = TestClient(app, base_url="https://testserver")
    body = c.post("/v1/auth/demo", json={"as": "traveller"}, headers=ANDROID).json()
    c.headers["Authorization"] = f"Bearer {body['accessToken']}"
    return c, body["refreshToken"]


@pytest.mark.db
def test_signing_out_forgets_the_phone(client):
    c, refresh = app_signed_in()
    register(c)
    assert c.post("/v1/auth/logout", json={"refreshToken": refresh}).status_code == 204
    assert phones() == {}


@pytest.mark.db
def test_the_theft_check_forgets_the_phone(client):
    c, first = app_signed_in()
    register(c)
    assert c.post("/v1/auth/refresh", json={"refreshToken": first}).status_code == 200
    with session_scope() as db:
        db.execute(update(RefreshToken).where(RefreshToken.token_hash == sha256(first)).values(revoked_at=datetime.now(UTC) - timedelta(minutes=5)))
        db.commit()
    # The rotated token came back long after: the whole sign-in ends, and with it this phone's alerts.
    assert c.post("/v1/auth/refresh", json={"refreshToken": first}).status_code == 401
    assert phones() == {}


@pytest.mark.db
def test_a_phone_whose_sign_in_expired_gets_no_push(client, firebase_on):
    register(client)
    with session_scope() as db:
        db.execute(update(RefreshToken).values(expires_at=datetime.now(UTC) - timedelta(minutes=1)))
        db.commit()
    plan_and_set_clock(client, "2026-10-14T08:41:00+05:30")
    client.post("/v1/trips/trip-001/demo/check", json={"idempotencyKey": key()})
    assert firebase_on.sent == []
    assert phones() == {}


@pytest.mark.db
def test_a_push_that_waited_past_its_time_is_dropped(client, firebase_on):
    register(client)
    user_id = next(iter(phones().values()))
    item = {"kind": "leave_now", "title": "Reroute", "body": "Leave now. Metro.", "tag": "leave-3", "trip_id": "trip-001", "ttl_seconds": 300, "seq": 3}
    now = datetime.now(UTC)
    # The queue fell behind: the alert's time ran out before its job ran.
    late = int((now - timedelta(seconds=1)).timestamp() * 1000)
    assert push.deliver(user_id, {**item, "expires_ms": late}, now=now) == {"sent": 0, "gone": 0}
    assert firebase_on.sent == []
    # Running late but still in time: Firebase keeps it for what's left, and the phone shows it until then.
    soon = int((now + timedelta(seconds=100)).timestamp() * 1000)
    assert push.deliver(user_id, {**item, "expires_ms": soon}, now=now) == {"sent": 1, "gone": 0}
    [(_, data, ttl)] = firebase_on.sent
    assert ttl == 100 and data["tag"] == "leave-3"


@pytest.mark.db
def test_a_refreshed_sign_in_still_names_its_session(client):
    """The app registers its phone with whatever access token it has, most often a refreshed one."""
    c, first = app_signed_in()
    refreshed = c.post("/v1/auth/refresh", json={"refreshToken": first}).json()
    with session_scope() as db:
        family = db.query(RefreshToken).filter(RefreshToken.token_hash == sha256(first)).one().family_id
    assert decode_access_token(refreshed["accessToken"])["sid"] == family
    c.headers["Authorization"] = f"Bearer {refreshed['accessToken']}"
    register(c)
    with session_scope() as db:
        assert [d.family_id for d in db.query(PushDevice)] == [family]
    assert c.post("/v1/auth/logout", json={"refreshToken": refreshed["refreshToken"]}).status_code == 204
    assert phones() == {}


@pytest.mark.db
def test_phones_of_ended_sign_ins_are_forgotten_within_the_hour(client):
    """Not only when a push goes out: a sign-in that expires takes its phone's token with it."""
    register(client)
    c, _ = app_signed_in()
    register(c, f"{PHONE}-app")
    assert push.forget_signed_out() == 0
    # The browser's sign-in (the client fixture's) expires; the app's is still live.
    with session_scope() as db:
        browser = db.get(PushDevice, sha256(PHONE)).family_id
        db.execute(update(RefreshToken).where(RefreshToken.family_id == browser).values(expires_at=datetime.now(UTC) - timedelta(minutes=1)))
        db.commit()
    assert push.forget_signed_out() == 1
    assert list(phones()) == [sha256(f"{PHONE}-app")]
    # The scheduler does it once an hour.
    register(client)
    tick(datetime(2026, 10, 15, 0, 0, tzinfo=UTC))
    assert list(phones()) == [sha256(f"{PHONE}-app")]
