"""The HTTP contract: idempotency, errors, auth, limits. No database needed."""

from __future__ import annotations

import logging

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from pydantic import BaseModel, ValidationError

from app.adapters.osrm import get_router
from app.adapters.rides import get_ride_store
from app.config import Settings, get_settings
from app.db import get_session
from app.errors import install_error_handlers
from app.main import create_app
from app.middleware import BodyLimitAndIdempotencyMiddleware, RequestIdMiddleware
from app.pagination import encode_cursor
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


def test_a_trace_id_that_could_forge_a_log_field_is_replaced(api):
    r = api.get("/v1/raasta/nope", headers={"X-Request-ID": "trace 1234 status=200"})
    assert r.headers["x-request-id"] != "trace 1234 status=200"
    assert r.json()["error"]["traceId"] == r.headers["x-request-id"]


def test_unhandled_errors_keep_their_trace_id(redis, caplog):
    client = TestClient(_echo_app([]))  # the middleware answers, so nothing is re-raised into the test
    with caplog.at_level(logging.ERROR, logger="raasta"):
        r = client.post("/boom", json={"idempotencyKey": "chk-00000011", "n": 1}, headers={"X-Request-ID": "trace-boom-0001"})
    assert r.status_code == 500
    assert r.headers["x-request-id"] == "trace-boom-0001"
    assert r.json()["error"] == {"code": "INTERNAL", "message": "Something went wrong on our side. Try again.", "traceId": "trace-boom-0001"}
    assert any("trace-boom-0001" in rec.getMessage() and rec.exc_info for rec in caplog.records)


def test_the_access_log_has_no_query_string(api, caplog):
    with caplog.at_level(logging.INFO, logger="raasta.access"):
        api.get("/v1/raasta/stands", params={"near": "12.97;77.59"}, headers={"X-Request-ID": "trace-log-00001"})
    [line] = [rec.getMessage() for rec in caplog.records if rec.name == "raasta.access"]
    assert line.startswith("GET /v1/raasta/stands 400 ") and line.endswith("ms trace=trace-log-00001")
    assert "12.97" not in line and "?" not in line


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


# ---------- validation that happens before the database ----------


class Offline:
    """Stands in for the database, OSRM and MongoDB: these requests must be refused before reaching them."""

    def __getattr__(self, name: str):
        raise AssertionError(f"the request used .{name}; it should have been refused first")


@pytest.fixture
def offline_api(redis):
    app = create_app()
    for dependency in (get_session, get_router, get_ride_store):
        app.dependency_overrides[dependency] = Offline
    return TestClient(app)


USER = {"Authorization": f"Bearer {make_token('rider-1')}"}
MODERATOR = {"Authorization": f"Bearer {make_token('mod-1', 'moderator')}"}


@pytest.mark.parametrize("cursor", [encode_cursor({"o": "ten"}), encode_cursor({"o": -1}), encode_cursor({"o": 10**30}), encode_cursor({"o": True}), "%%%"])
def test_malformed_stand_cursors_are_400(offline_api, cursor):
    r = offline_api.get("/v1/raasta/stands", params={"near": "77.6195,12.9352", "cursor": cursor})
    assert r.status_code == 400 and r.json()["error"]["code"] == "BAD_REQUEST"


@pytest.mark.parametrize("path", ["/v1/raasta/contributions", "/v1/raasta/fare-reports"])
@pytest.mark.parametrize(
    "position",
    [
        {"c": "yesterday", "i": "con-1"},
        {"c": "2026-10-14T10:00:00+05:30"},
        {"c": 5, "i": "con-1"},
        {"c": "2026-10-14T10:00:00", "i": "con-1"},
        {"c": "2026-10-14T10:00:00+05:30", "i": ["con-1"]},
    ],
)
def test_malformed_queue_cursors_are_400(offline_api, path, position):
    r = offline_api.get(path, params={"cursor": encode_cursor(position)}, headers=MODERATOR)
    assert r.status_code == 400 and r.json()["error"]["code"] == "BAD_REQUEST"


def _contribution(**changes) -> dict:  # noqa: ANN003
    body = {
        "idempotencyKey": "con-area0001",
        "kind": "stands_tapped",
        "vehicleType": "shared_auto",
        "fareInr": 20,
        "frequencyMin": 10,
        "firstTrip": "07:00",
        "lastTrip": "21:00",
        "stands": [{"name": "Koramangala", "location": {"lat": 12.934, "lng": 77.6185}}, FORUM],
    }
    return {**body, **changes}


FORUM = {"name": "Forum", "location": {"lat": 12.9346, "lng": 77.6112}}
DELHI = {"name": "Connaught Place", "location": {"lat": 28.6315, "lng": 77.2167}}
RIDE_WITH_A_ZERO = [{"lat": 12.93, "lng": 77.61, "t": "2026-10-14T09:00:00+05:30"}, {"lat": 0, "lng": 0, "t": "2026-10-14T09:00:10+05:30"}]


@pytest.mark.parametrize("changes", [{"citySlug": "mumbai"}, {"stands": [DELHI, FORUM]}, {"kind": "gps_ride", "stands": None, "points": RIDE_WITH_A_ZERO}])
def test_contributions_outside_a_served_city_are_422(offline_api, changes):
    r = offline_api.post("/v1/raasta/contributions", json=_contribution(**changes), headers=USER)
    assert r.status_code == 422 and r.json()["error"]["code"] == "VALIDATION_ERROR"


def test_gtfs_only_for_served_cities(offline_api):
    r = offline_api.get("/v1/raasta/cities/mumbai/gtfs.zip")
    assert r.status_code == 404 and r.json()["error"]["code"] == "NOT_FOUND"


# ---------- the Reroute API's service token ----------

SERVICE_TOKEN = "test-service-token-0123456789abcdef"


@pytest.fixture
def service_api(redis):
    app = create_app()
    settings = Settings(raasta_service_token=SERVICE_TOKEN, service_rate_limit_per_minute=65)
    app.dependency_overrides[get_settings] = lambda: settings
    for dependency in (get_session, get_router, get_ride_store):
        app.dependency_overrides[dependency] = Offline
    return TestClient(app)


def test_the_service_token_gets_the_service_limit(service_api, redis):
    headers = {"X-Service-Token": SERVICE_TOKEN}
    statuses = [service_api.get("/v1/raasta/stands", params={"near": "bad"}, headers=headers).status_code for _ in range(66)]
    assert statuses[:65] == [400] * 65 and statuses[65] == 429
    assert redis.keys("rl:raasta:svc:reroute:*")
    # Everyone else keeps their own bucket.
    assert service_api.get("/v1/raasta/stands", params={"near": "bad"}).status_code == 400


def test_the_service_token_cannot_write(service_api):
    headers = {"X-Service-Token": SERVICE_TOKEN}
    r = service_api.post("/v1/raasta/routes/sample-kor-jay/confirmations", json={"idempotencyKey": "conf-svc00001"}, headers=headers)
    assert r.status_code == 403 and r.json()["error"]["code"] == "FORBIDDEN"
    assert service_api.patch("/v1/raasta/contributions/con-1", json={"action": "approve"}, headers=headers).status_code == 403
    # With a signed-in user the request is that user's write (refused here only for its city).
    r = service_api.post("/v1/raasta/contributions", json=_contribution(citySlug="mumbai"), headers={**headers, **USER})
    assert r.status_code == 422


def test_a_wrong_service_token_is_anonymous(service_api, redis):
    headers = {"X-Service-Token": SERVICE_TOKEN[:-1] + "x"}
    r = service_api.post("/v1/raasta/routes/sample-kor-jay/confirmations", json={"idempotencyKey": "conf-svc00002"}, headers=headers)
    assert r.status_code == 401
    statuses = [service_api.get("/v1/raasta/stands", params={"near": "bad"}, headers=headers).status_code for _ in range(60)]
    assert statuses[:59] == [400] * 59 and statuses[59] == 429  # the IP's 60 a minute, counting the POST
    assert not redis.keys("rl:raasta:svc:*")


def test_an_empty_service_token_setting_turns_it_off(api, redis):
    api.get("/v1/raasta/stands", params={"near": "bad"}, headers={"X-Service-Token": ""})
    assert not redis.keys("rl:raasta:svc:*")


def test_production_refuses_a_weak_service_token():
    secret = "a-real-jwt-secret-with-at-least-32-bytes"
    for weak in ("dev-only-service-token-0123456789abcdef", "too-short"):
        with pytest.raises(ValidationError, match="RAASTA_SERVICE_TOKEN"):
            Settings(app_env="production", jwt_secret=secret, raasta_service_token=weak)
    assert Settings(app_env="production", jwt_secret=secret, raasta_service_token="").raasta_service_token == ""
    assert Settings(app_env="production", jwt_secret=secret, raasta_service_token="s" * 32)
    assert Settings(app_env="development", raasta_service_token="dev-only")


# ---------- tokens ----------


def test_tokens_must_be_access_tokens_for_reroute():
    s = get_settings()
    assert decode_access_token(make_token("u1", "moderator"), s).is_moderator
    assert decode_access_token(make_token(typ="refresh"), s) is None
    assert decode_access_token(make_token(aud="someone-else"), s) is None
    assert decode_access_token(make_token(role="root"), s) is None
    assert decode_access_token(make_token(exp=1), s) is None
    assert decode_access_token("not-a-jwt", s) is None
