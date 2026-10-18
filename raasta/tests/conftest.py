from __future__ import annotations

import os
import time

os.environ.setdefault("APP_ENV", "test")
os.environ.setdefault("JWT_SECRET", "test-secret-at-least-32-characters-long")

import fakeredis
import jwt
import pytest

from app.config import get_settings
from app.redis_client import set_redis


def make_token(sub: str = "user-1", role: str = "traveller", **overrides) -> str:
    s = get_settings()
    claims = {"sub": sub, "role": role, "typ": "access", "iss": s.jwt_issuer, "aud": s.jwt_audience, "exp": int(time.time()) + 900, **overrides}
    return jwt.encode(claims, s.jwt_secret, algorithm="HS256")


@pytest.fixture
def redis():
    client = fakeredis.FakeRedis(decode_responses=True)
    set_redis(client)
    yield client
    set_redis(None)


def pytest_collection_modifyitems(config, items):  # noqa: ANN001
    if os.environ.get("TEST_DATABASE_URL"):
        return
    skip = pytest.mark.skip(reason="set TEST_DATABASE_URL to run database tests")
    for item in items:
        if "db" in item.keywords:
            item.add_marker(skip)
