"""The Raasta API. Runs and demos on its own; Reroute reaches it only over HTTP."""

from __future__ import annotations

import asyncio
import logging
from contextlib import asynccontextmanager, suppress

from fastapi import APIRouter, FastAPI

from app.config import get_settings
from app.errors import install_error_handlers
from app.jobs import freshness
from app.middleware import BodyLimitAndIdempotencyMiddleware, RequestIdMiddleware
from app.redis_client import get_redis
from app.routes import catalog, community, health

PREFIX = "/v1/raasta"

DESCRIPTION = """
Crowdsourced shared-auto, e-rickshaw and tempo routes: stands, fares, how often vehicles come
and when the last one leaves.

- Reads are open data and need no sign-in. Writes need a Reroute access token.
- Every POST takes an `idempotencyKey` in the body. The same key with the same body returns the
  first response again; with a different body it returns 409.
- Errors always look like `{"error": {"code", "message", "traceId"}}`.
- Sample routes are labelled `sample: true`.
"""


FRESHNESS_EVERY_S = 6 * 3600


def _freshness_once() -> None:
    """Mark stale routes. A Redis lock keeps several Raasta copies from running it at once."""
    try:
        if not get_redis().set("raasta:freshness:lock", "1", nx=True, ex=FRESHNESS_EVERY_S - 60):
            return
    except Exception:  # Redis down: running twice is harmless (mark_stale is idempotent)
        pass
    freshness.main()


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Section 12: routes unconfirmed for 90 days go stale. Checked every 6 hours in the background."""
    stop = asyncio.Event()

    async def loop() -> None:
        await asyncio.sleep(60)
        while not stop.is_set():
            try:
                await asyncio.to_thread(_freshness_once)
            except Exception:
                logging.getLogger("raasta.freshness").exception("Freshness check failed; retrying later")
            with suppress(TimeoutError):
                await asyncio.wait_for(stop.wait(), timeout=FRESHNESS_EVERY_S)

    task = asyncio.create_task(loop()) if get_settings().app_env != "test" else None
    yield
    stop.set()
    if task is not None:
        task.cancel()


def create_app() -> FastAPI:
    settings = get_settings()
    logging.basicConfig(level=settings.log_level, format="%(asctime)s %(levelname)s %(name)s %(message)s")
    app = FastAPI(
        title="Raasta API",
        version="1.0.0",
        description=DESCRIPTION,
        docs_url=f"{PREFIX}/docs",
        openapi_url=f"{PREFIX}/openapi.json",
        redoc_url=None,
        lifespan=lifespan,
    )
    install_error_handlers(app)
    api = APIRouter(prefix=PREFIX)
    api.include_router(health.router)
    api.include_router(catalog.router)
    api.include_router(community.router)
    app.include_router(api)
    # Added last runs first: request IDs wrap everything, so every error carries a traceId.
    app.add_middleware(BodyLimitAndIdempotencyMiddleware, redis_getter=lambda: get_redis(), namespace="raasta")
    app.add_middleware(RequestIdMiddleware)
    return app


app = create_app()
