"""The Reroute API."""

from __future__ import annotations

import logging

from fastapi import FastAPI
from fastapi.responses import JSONResponse
from rq import Worker
from sqlalchemy import text

from app import errors
from app.config import get_settings
from app.db import engine
from app.middleware import GuardMiddleware, TraceIdMiddleware
from app.redis_client import get_redis, get_redis_bytes
from app.routes import auth, bookings, live, me, places, roads, share, speech, trips

log = logging.getLogger("reroute")


def create_app() -> FastAPI:
    get_settings()  # validates: DEMO_LOGIN is refused in production
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s %(message)s")
    app = FastAPI(
        title="Reroute API",
        version="1.0.0",
        description="Plans a work day in a new city and re-plans it when the traveller runs late. Every time and fare is an estimate.",
        docs_url="/v1/docs",
        redoc_url=None,
        openapi_url="/v1/openapi.json",
    )
    errors.install(app)
    # Order matters: the trace ID wraps everything, so even guard errors carry it.
    app.add_middleware(GuardMiddleware)
    app.add_middleware(TraceIdMiddleware)
    for module in (auth, me, places, roads, speech, trips, bookings, share, live):
        app.include_router(module.router)

    @app.get("/v1/healthz", tags=["health"], include_in_schema=False)
    def healthz() -> JSONResponse:
        """Liveness: the process answers."""
        return JSONResponse({"status": "ok"})

    @app.get("/v1/readyz", tags=["health"], include_in_schema=False)
    def readyz() -> JSONResponse:
        """Readiness: the database and Redis answer."""
        checks: dict[str, str] = {}
        try:
            with engine().connect() as conn:
                conn.execute(text("SELECT 1"))
            checks["database"] = "ok"
        except Exception:
            checks["database"] = "down"
        try:
            get_redis().ping()
            checks["redis"] = "ok"
        except Exception:
            checks["redis"] = "down"
        try:
            # Planning only happens in a worker: with none alive, plans would wait forever.
            checks["workers"] = "ok" if Worker.count(connection=get_redis_bytes()) > 0 else "down"
        except Exception:
            checks["workers"] = "unknown"
        ready = checks["database"] == "ok" and checks["redis"] == "ok"
        if checks["workers"] != "ok":
            log.warning("No planning worker is running")
        return JSONResponse({"status": "ok" if ready else "degraded", "checks": checks}, status_code=200 if ready else 503)

    return app


app = create_app()
