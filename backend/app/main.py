"""The Reroute API."""

from __future__ import annotations

import logging

from fastapi import FastAPI
from fastapi.responses import JSONResponse

from app import errors
from app.config import get_settings
from app.middleware import GuardMiddleware, TraceIdMiddleware
from app.routes import auth, live, me, places, share, trips


def create_app() -> FastAPI:
    settings = get_settings()  # validates: DEMO_LOGIN is refused in production
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
    for module in (auth, me, places, trips, share, live):
        app.include_router(module.router)

    @app.get("/v1/healthz", tags=["health"], include_in_schema=False)
    def healthz() -> JSONResponse:
        return JSONResponse({"status": "ok", "env": settings.app_env})

    return app


app = create_app()
