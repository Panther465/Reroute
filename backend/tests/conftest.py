"""Test settings. API tests use in-memory Redis (fakeredis) and run jobs inline.

Tests marked `db` need PostgreSQL with PostGIS: set TEST_DATABASE_URL (CI does). Without it they skip.
"""

from __future__ import annotations

import os

os.environ.setdefault("APP_ENV", "test")
os.environ.setdefault("QUEUE_SYNC", "true")
os.environ.setdefault("DEMO_LOGIN", "true")
os.environ.setdefault("COOKIE_SECURE", "false")
os.environ.setdefault("CHECKIN_WAIT_SECONDS", "2")
os.environ.setdefault("RATE_LIMIT_PER_MINUTE", "100000")
os.environ.setdefault("AUTH_RATE_LIMIT_PER_MINUTE", "100000")
# Never the real routing servers: legs are drawn approximate unless a test gives the router an answer.
os.environ.setdefault("ROUTING_CAR_URL", "")
os.environ.setdefault("ROUTING_FOOT_URL", "")
if os.environ.get("TEST_DATABASE_URL"):
    os.environ["DATABASE_URL"] = os.environ["TEST_DATABASE_URL"]

import fakeredis  # noqa: E402
import pytest  # noqa: E402

from app.redis_client import use_clients  # noqa: E402


def pytest_configure(config):
    config.addinivalue_line("markers", "db: needs PostgreSQL with PostGIS (TEST_DATABASE_URL)")


def pytest_collection_modifyitems(config, items):
    if os.environ.get("TEST_DATABASE_URL"):
        return
    skip = pytest.mark.skip(reason="TEST_DATABASE_URL is not set")
    for item in items:
        if "db" in item.keywords:
            item.add_marker(skip)


@pytest.fixture(autouse=True)
def fake_redis():
    server = fakeredis.FakeServer()
    text = fakeredis.FakeRedis(server=server, decode_responses=True)
    raw = fakeredis.FakeRedis(server=server)
    use_clients(text, raw)
    yield text
    use_clients(None, None)
