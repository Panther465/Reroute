"""The Android app's session and CORS.

The app runs at https://localhost inside the phone and calls the API's own host, so the API's cookies never
reach it: it signs in with X-Reroute-Client: android, keeps the refresh token it gets in the body, and sends
it back in the body. Browsers keep their cookies, unchanged.
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

import pytest
from fastapi.testclient import TestClient
from pydantic import ValidationError
from sqlalchemy import update

from app.config import Settings, get_settings
from app.db import session_scope
from app.main import app, create_app
from app.models import RefreshToken
from app.security import sha256

ANDROID = {"X-Reroute-Client": "android"}


def app_sign_in(c: TestClient) -> dict:
    res = c.post("/v1/auth/demo", json={"as": "traveller"}, headers=ANDROID)
    assert res.status_code == 200, res.text
    return res.json()


@pytest.mark.db
def test_the_app_gets_its_refresh_token_in_the_body_and_no_cookies(client):
    c = TestClient(app, base_url="https://testserver")
    body = app_sign_in(c)
    assert len(body["refreshToken"]) >= 40 and body["accessToken"]
    assert "rr_refresh" not in c.cookies and "rr_csrf" not in c.cookies


@pytest.mark.db
def test_a_browser_sign_in_still_uses_cookies(client):
    c = TestClient(app, base_url="https://testserver")
    res = c.post("/v1/auth/demo", json={"as": "traveller"})
    assert res.status_code == 200 and res.json()["refreshToken"] is None
    assert c.cookies.get("rr_refresh") and c.cookies.get("rr_csrf")


@pytest.mark.db
def test_the_app_refreshes_with_its_token_and_needs_no_csrf(client):
    c = TestClient(app, base_url="https://testserver")
    first = app_sign_in(c)["refreshToken"]
    res = c.post("/v1/auth/refresh", json={"refreshToken": first})
    assert res.status_code == 200, res.text
    second = res.json()["refreshToken"]
    assert second and second != first
    assert "rr_refresh" not in c.cookies
    me = c.get("/v1/me", headers={"Authorization": f"Bearer {res.json()['accessToken']}"})
    assert me.status_code == 200 and me.json()["isDemo"] is True
    # The new token works in turn.
    assert c.post("/v1/auth/refresh", json={"refreshToken": second}).status_code == 200


@pytest.mark.db
def test_a_lost_refresh_response_in_the_app_is_forgiven(client):
    """The app sent its token and lost the answer (a dropped connection): it sends the same token again."""
    c = TestClient(app, base_url="https://testserver")
    first = app_sign_in(c)["refreshToken"]
    assert c.post("/v1/auth/refresh", json={"refreshToken": first}).status_code == 200
    assert c.post("/v1/auth/refresh", json={"refreshToken": first}).status_code == 200


@pytest.mark.db
def test_an_old_app_token_used_late_ends_the_whole_session(client):
    c = TestClient(app, base_url="https://testserver")
    first = app_sign_in(c)["refreshToken"]
    second = c.post("/v1/auth/refresh", json={"refreshToken": first}).json()["refreshToken"]
    # The first token was rotated long ago: whoever holds it now may have copied it.
    with session_scope() as db:
        db.execute(update(RefreshToken).where(RefreshToken.token_hash == sha256(first)).values(revoked_at=datetime.now(UTC) - timedelta(minutes=5)))
        db.commit()
    assert c.post("/v1/auth/refresh", json={"refreshToken": first}).status_code == 401
    assert c.post("/v1/auth/refresh", json={"refreshToken": second}).status_code == 401


@pytest.mark.db
def test_the_app_signs_out_with_its_token(client):
    c = TestClient(app, base_url="https://testserver")
    token = app_sign_in(c)["refreshToken"]
    assert c.post("/v1/auth/logout", json={"refreshToken": token}).status_code == 204
    assert c.post("/v1/auth/refresh", json={"refreshToken": token}).status_code == 401


@pytest.mark.db
def test_a_made_up_app_token_is_refused(client):
    c = TestClient(app, base_url="https://testserver")
    assert c.post("/v1/auth/refresh", json={"refreshToken": "not-a-token-we-ever-gave-out"}).status_code == 401
    assert c.post("/v1/auth/refresh", json={"refreshToken": "short"}).status_code == 422


@pytest.mark.db
def test_only_the_android_client_is_known(client):
    c = TestClient(app, base_url="https://testserver")
    assert c.post("/v1/auth/demo", json={"as": "traveller"}, headers={"X-Reroute-Client": "ios"}).status_code == 422


# ---------- CORS (no database) ----------


def test_cors_stays_closed_without_origins():
    c = TestClient(create_app())
    pre = c.options("/v1/auth/demo", headers={"Origin": "https://localhost", "Access-Control-Request-Method": "POST"})
    assert "access-control-allow-origin" not in pre.headers


def test_the_android_app_origin_may_call_the_api(monkeypatch):
    monkeypatch.setattr(get_settings(), "cors_origins", "https://localhost")
    c = TestClient(create_app())
    pre = c.options(
        "/v1/trips/trip-001/checkins",
        headers={
            "Origin": "https://localhost",
            "Access-Control-Request-Method": "POST",
            "Access-Control-Request-Headers": "authorization,content-type,x-request-id,x-reroute-client",
        },
    )
    assert pre.status_code == 200 and pre.headers["access-control-allow-origin"] == "https://localhost"
    # No cookies cross: the app sends its tokens itself.
    assert "access-control-allow-credentials" not in pre.headers
    res = c.get("/v1/auth/options", headers={"Origin": "https://localhost", "X-Request-ID": "trace-12345678"})
    assert res.status_code == 200 and res.headers["access-control-allow-origin"] == "https://localhost"
    exposed = res.headers["access-control-expose-headers"].lower()
    assert "x-request-id" in exposed and "retry-after" in exposed
    other = c.options("/v1/auth/demo", headers={"Origin": "https://evil.example", "Access-Control-Request-Method": "POST"})
    assert "access-control-allow-origin" not in other.headers


def test_a_rate_limited_answer_is_readable_by_the_app(monkeypatch):
    monkeypatch.setattr(get_settings(), "cors_origins", "https://localhost")
    monkeypatch.setattr(get_settings(), "rate_limit_per_minute", 1)
    c = TestClient(create_app())
    for _ in range(2):
        res = c.get("/v1/auth/options", headers={"Origin": "https://localhost"})
    assert res.status_code == 429 and res.headers["access-control-allow-origin"] == "https://localhost"


def test_cors_origins_are_listed_one_by_one():
    with pytest.raises(ValidationError, match="CORS_ORIGINS"):
        Settings(app_env="development", cors_origins="https://localhost,*")
    assert Settings(app_env="development", cors_origins=" https://localhost/ , ").cors_origin_list == ["https://localhost"]
