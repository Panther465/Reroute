"""Request guards that need no database: error shape, idempotency, body size, rate limits, settings."""

from __future__ import annotations

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from pydantic import BaseModel, ValidationError

from app import errors
from app.config import Settings, get_settings
from app.main import app as real_app
from app.middleware import GuardMiddleware, TraceIdMiddleware
from app.models import User
from app.schemas import CheckinIn, TaskIn, TripIn
from app.security import decode_access_token, issue_access_token


class Echo(BaseModel):
    idempotencyKey: str
    value: int


def make_app() -> FastAPI:
    app = FastAPI()
    errors.install(app)
    app.add_middleware(GuardMiddleware)
    app.add_middleware(TraceIdMiddleware)
    calls = {"n": 0}

    @app.post("/v1/echo")
    def echo(body: Echo):
        calls["n"] += 1
        return {"value": body.value, "calls": calls["n"]}

    @app.get("/v1/boom")
    def boom():
        raise errors.ApiError(404, "Trip not found.")

    return app


@pytest.fixture
def client():
    return TestClient(make_app())


def test_same_key_and_body_replays_the_first_response(client):
    first = client.post("/v1/echo", json={"idempotencyKey": "key-00000001", "value": 1})
    again = client.post("/v1/echo", json={"idempotencyKey": "key-00000001", "value": 1})
    assert first.status_code == again.status_code == 200
    assert first.json() == again.json() == {"value": 1, "calls": 1}
    assert again.headers["Idempotent-Replayed"] == "true"


def test_same_key_with_a_different_body_is_409(client):
    client.post("/v1/echo", json={"idempotencyKey": "key-00000002", "value": 1})
    res = client.post("/v1/echo", json={"idempotencyKey": "key-00000002", "value": 2})
    assert res.status_code == 409
    assert res.json()["error"]["code"] == "IDEMPOTENCY_CONFLICT"


def test_keys_are_scoped_to_the_caller(client):
    user_a = User(user_id="usr-a", email="a@x", name="A", role="traveller")
    user_b = User(user_id="usr-b", email="b@x", name="B", role="traveller")
    ta, _ = issue_access_token(user_a)
    tb, _ = issue_access_token(user_b)
    a = client.post("/v1/echo", json={"idempotencyKey": "key-00000003", "value": 1}, headers={"Authorization": f"Bearer {ta}"})
    b = client.post("/v1/echo", json={"idempotencyKey": "key-00000003", "value": 1}, headers={"Authorization": f"Bearer {tb}"})
    assert a.json()["calls"] == 1 and b.json()["calls"] == 2


def test_errors_use_one_shape_with_a_trace_id(client):
    res = client.get("/v1/boom", headers={"X-Request-ID": "trace-12345678"})
    assert res.status_code == 404
    assert res.json() == {"error": {"code": "NOT_FOUND", "message": "Trip not found.", "traceId": "trace-12345678"}}
    assert res.headers["x-request-id"] == "trace-12345678"


def test_validation_errors_use_the_same_shape(client):
    res = client.post("/v1/echo", json={"idempotencyKey": "key-00000004", "value": "not a number"})
    assert res.status_code == 422
    body = res.json()["error"]
    assert body["code"] == "VALIDATION_ERROR" and body["traceId"]


def test_oversized_bodies_get_413(client, monkeypatch):
    res = client.post("/v1/echo", content=b"{" + b" " * (get_settings().max_body_bytes + 10) + b"}", headers={"content-type": "application/json"})
    assert res.status_code == 413
    assert res.json()["error"]["code"] == "PAYLOAD_TOO_LARGE"


def test_rate_limit_returns_429(monkeypatch):
    monkeypatch.setattr(get_settings(), "rate_limit_per_minute", 3)
    c = TestClient(make_app())
    codes = [c.get("/v1/boom").status_code for _ in range(5)]
    assert codes[:3] == [404, 404, 404] and codes[3:] == [429, 429]


def test_every_post_requires_an_idempotency_key():
    spec = real_app.openapi()
    schemas = spec["components"]["schemas"]
    for path, ops in spec["paths"].items():
        post = ops.get("post")
        if not post or path.startswith("/v1/auth/"):
            continue
        ref = post["requestBody"]["content"]["application/json"]["schema"]["$ref"].split("/")[-1]
        assert "idempotencyKey" in schemas[ref].get("required", []), f"POST {path} lacks a required idempotencyKey"


def test_demo_login_is_refused_in_production():
    with pytest.raises(ValidationError, match="DEMO_LOGIN"):
        Settings(app_env="production", demo_login=True, jwt_secret="x" * 40)


def test_access_tokens_round_trip_and_expire():
    from datetime import UTC, datetime, timedelta

    user = User(user_id="usr-x", email="x@x", name="X", role="moderator")
    token, ttl = issue_access_token(user)
    assert ttl == 15 * 60
    assert decode_access_token(token)["role"] == "moderator"
    old, _ = issue_access_token(user, now=datetime.now(UTC) - timedelta(hours=1))
    with pytest.raises(errors.ApiError) as exc:
        decode_access_token(old)
    assert exc.value.status == 401


@pytest.mark.parametrize(
    "body",
    [
        {"title": "Bank", "placeId": "p", "durationMin": 4, "idempotencyKey": "k-0000001"},
        {"title": "Bank", "placeId": "p", "durationMin": 800, "idempotencyKey": "k-0000001"},
        {"title": "Bank", "placeId": "p", "durationMin": 30, "fixedStart": "2026-10-14T10:00:00", "idempotencyKey": "k-0000001"},
        {
            "title": "Bank",
            "placeId": "p",
            "durationMin": 30,
            "fixedStart": "2026-10-14T10:00:00+05:30",
            "window": {"opensAt": "10:00", "closesAt": "16:00"},
            "idempotencyKey": "k-0000001",
        },
        {"title": "Bank", "placeId": "p", "durationMin": 30, "window": {"opensAt": "16:00", "closesAt": "10:00"}, "idempotencyKey": "k-0000001"},
        {"title": "Bank", "placeId": "p", "durationMin": 30, "idempotencyKey": "short"},
    ],
)
def test_task_validation(body):
    with pytest.raises(ValidationError):
        TaskIn.model_validate(body)


def test_checkin_delay_needs_minutes():
    with pytest.raises(ValidationError):
        CheckinIn.model_validate({"taskId": "t", "kind": "delay", "idempotencyKey": "chk-00001"})
    with pytest.raises(ValidationError):
        CheckinIn.model_validate({"taskId": "t", "kind": "done", "delayMin": 5, "idempotencyKey": "chk-00001"})


def test_trip_dates_are_checked():
    with pytest.raises(ValidationError):
        TripIn.model_validate(
            {
                "citySlug": "bengaluru",
                "cityName": "Bengaluru",
                "startDate": "2026-10-15",
                "endDate": "2026-10-14",
                "stayPlaceId": "h",
                "stayLabel": "Hotel",
                "idempotencyKey": "trip-0001",
            }
        )
