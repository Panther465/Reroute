"""The HTTP contract: idempotency, errors, auth, limits. No database needed."""

from __future__ import annotations

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from pydantic import BaseModel

from app.config import get_settings
from app.errors import install_error_handlers
from app.main import create_app
from app.middleware import BodyLimitAndIdempotencyMiddleware, RequestIdMiddleware
from app.redis_client import get_redis
from app.schemas import ApiModel, IdempotencyKey
from app.security import decode_access_token

from .conftest import make_token

# ---------- every POST is idempotent ----------


def test_every_post_requires_an_idempotency_key():
    spec = create_app().openapi()
    schemas = spec["components"]["schemas"]
    posts = [(path, op) for path, ops in spec["paths"].items() for method, op in ops.items() if method == "post"]
    assert posts, "expected POST routes"
    for path, op in posts:
        ref = op["requestBody"]["content"]["application/json"]["schema"]["$ref"].split("/")[-1]
        assert "idempotencyKey" in schemas[ref].get("required", []), f"{path} doesn't require idempotencyKey"


class Echo(BaseModel):
    idempotencyKey: str
    n: int


class EchoApi(ApiModel):
    """Like every Raasta body: camelCase, but the snake_case field names are accepted too."""

    idempotency_key: IdempotencyKey
    n: int


def _echo_app(calls: list[int]) -> FastAPI:
    app = FastAPI()
    install_error_handlers(app)

    @app.post("/echo", status_code=201)
    def echo(body: Echo) -> dict:
        calls.append(body.n)
        return {"n": body.n, "call": len(calls)}

    @app.post("/echo-api", status_code=201)
    def echo_api(body: EchoApi) -> dict:
        calls.append(body.n)
        return {"n": body.n, "call": len(calls)}

    @app.post("/boom")
    def boom(body: Echo) -> dict:
        calls.append(body.n)
        raise RuntimeError("fail")

    app.add_middleware(BodyLimitAndIdempotencyMiddleware, redis_getter=lambda: get_redis(), max_body_bytes=2048)
    app.add_middleware(RequestIdMiddleware)
    return app


def test_same_key_and_body_returns_the_first_response(redis):
    calls: list[int] = []
    client = TestClient(_echo_app(calls))
    body = {"idempotencyKey": "chk-00000001", "n": 7}
    first = client.post("/echo", json=body)
    second = client.post("/echo", json=body)
    assert first.status_code == second.status_code == 201
    assert first.json() == second.json() == {"n": 7, "call": 1}
    assert second.headers["idempotent-replayed"] == "true"
    assert calls == [7]


@pytest.mark.parametrize("field", ["idempotencyKey", "idempotency_key"])
def test_either_spelling_of_the_key_is_idempotent(redis, field):
    calls: list[int] = []
    client = TestClient(_echo_app(calls))
    body = {field: "chk-00000010", "n": 4}
    first = client.post("/echo-api", json=body)
    second = client.post("/echo-api", json=body)
    assert first.status_code == second.status_code == 201
    assert second.headers["idempotent-replayed"] == "true"
    assert calls == [4]
    assert client.post("/echo-api", json={field: "chk-00000010", "n": 5}).status_code == 409


def test_same_key_with_a_different_body_is_409(redis):
    client = TestClient(_echo_app([]))
    client.post("/echo", json={"idempotencyKey": "chk-00000002", "n": 1})
    r = client.post("/echo", json={"idempotencyKey": "chk-00000002", "n": 2})
    assert r.status_code == 409
    assert r.json()["error"]["code"] == "IDEMPOTENCY_CONFLICT"


def test_the_same_key_on_another_route_is_not_replayed(redis):
    """A fare report for route B with the key and body used for route A must not get A's answer."""
    client = TestClient(_echo_app([]))
    client.post("/echo", json={"idempotencyKey": "chk-00000009", "n": 1})
    r = client.post("/boom", json={"idempotencyKey": "chk-00000009", "n": 1})
    assert r.status_code == 409
    assert r.json()["error"]["code"] == "IDEMPOTENCY_CONFLICT"


def test_short_brief_style_keys_are_still_idempotent(redis):
    calls: list[int] = []
    client = TestClient(_echo_app(calls))
    client.post("/echo", json={"idempotencyKey": "acc-001", "n": 3})
    client.post("/echo", json={"idempotencyKey": "acc-001", "n": 3})
    assert calls == [3]


def test_keys_are_scoped_to_the_user(redis):
    calls: list[int] = []
    client = TestClient(_echo_app(calls))
    body = {"idempotencyKey": "chk-00000003", "n": 1}
    client.post("/echo", json=body, headers={"Authorization": f"Bearer {make_token('a')}"})
    client.post("/echo", json=body, headers={"Authorization": f"Bearer {make_token('b')}"})
    assert calls == [1, 1]


def test_keys_are_kept_for_24_hours(redis):
    client = TestClient(_echo_app([]))
    client.post("/echo", json={"idempotencyKey": "chk-00000004", "n": 1})
    ttl = redis.ttl("idem:raasta:anon:chk-00000004")
    assert 23 * 3600 < ttl <= 24 * 3600


def test_server_errors_are_not_stored_so_a_retry_runs_again(redis):
    calls: list[int] = []
    client = TestClient(_echo_app(calls), raise_server_exceptions=False)
    body = {"idempotencyKey": "chk-00000005", "n": 3}
    assert client.post("/boom", json=body).status_code == 500
    assert client.post("/boom", json=body).status_code == 500
    assert calls == [3, 3]


def test_missing_key_falls_through_to_validation(redis):
    r = TestClient(_echo_app([])).post("/echo", json={"n": 1})
    assert r.status_code == 422
    assert r.json()["error"]["code"] == "VALIDATION_ERROR"


def test_oversized_bodies_get_413(redis):
    r = TestClient(_echo_app([])).post(
        "/echo", content=b'{"idempotencyKey":"chk-00000006","n":1,"pad":"' + b"x" * 4096 + b'"}', headers={"content-type": "application/json"}
    )
    assert r.status_code == 413
    assert r.json()["error"]["code"] == "PAYLOAD_TOO_LARGE"


# ---------- errors and trace IDs ----------


@pytest.fixture
def api(redis):
    return TestClient(create_app())


def test_unknown_path_uses_the_error_shape(api):
    r = api.get("/v1/raasta/nope")
    assert r.status_code == 404
    err = r.json()["error"]
    assert err["code"] == "NOT_FOUND" and err["message"] and len(err["traceId"]) >= 8


def test_trace_id_follows_x_request_id(api):
    r = api.get("/v1/raasta/nope", headers={"X-Request-ID": "trace-12345678"})
    assert r.headers["x-request-id"] == "trace-12345678"
    assert r.json()["error"]["traceId"] == "trace-12345678"


def test_bad_coordinates_are_400(api):
    r = api.get("/v1/raasta/stands", params={"near": "not-a-point"})
    assert r.status_code == 400
    assert r.json()["error"]["code"] == "BAD_REQUEST"


def test_writes_need_sign_in(api):
    r = api.post("/v1/raasta/routes/sample-kor-jay/confirmations", json={"idempotencyKey": "conf-00000001"})
    assert r.status_code == 401
    assert r.json()["error"]["code"] == "UNAUTHENTICATED"


def test_moderation_needs_the_moderator_role(api):
    r = api.get("/v1/raasta/contributions", headers={"Authorization": f"Bearer {make_token(role='traveller')}"})
    assert r.status_code == 403
    assert r.json()["error"]["code"] == "FORBIDDEN"


def test_invalid_contribution_is_422(api):
    body = {
        "idempotencyKey": "con-00000001",
        "kind": "stands_tapped",
        "vehicleType": "shared_auto",
        "fareInr": 3000,
        "frequencyMin": 10,
        "firstTrip": "07:00",
        "lastTrip": "21:00",
        "stands": [],
    }
    r = api.post("/v1/raasta/contributions", json=body, headers={"Authorization": f"Bearer {make_token()}"})
    assert r.status_code == 422
    assert r.json()["error"]["code"] == "VALIDATION_ERROR"


def test_per_minute_rate_limit(api):
    headers = {"Authorization": f"Bearer {make_token('busy')}"}
    statuses = [api.get("/v1/raasta/stands", params={"near": "bad"}, headers=headers).status_code for _ in range(61)]
    assert statuses[:60] == [400] * 60
    r = api.get("/v1/raasta/stands", params={"near": "bad"}, headers=headers)
    assert r.status_code == 429 and r.json()["error"]["code"] == "RATE_LIMITED"


def test_health(api):
    assert api.get("/v1/raasta/healthz").json() == {"status": "ok", "service": "raasta"}


# ---------- tokens ----------


def test_tokens_must_be_access_tokens_for_reroute():
    s = get_settings()
    assert decode_access_token(make_token("u1", "moderator"), s).is_moderator
    assert decode_access_token(make_token(typ="refresh"), s) is None
    assert decode_access_token(make_token(aud="someone-else"), s) is None
    assert decode_access_token(make_token(role="root"), s) is None
    assert decode_access_token(make_token(exp=1), s) is None
    assert decode_access_token("not-a-jwt", s) is None
