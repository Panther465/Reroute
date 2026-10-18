"""Liveness and readiness."""

from __future__ import annotations

from fastapi import APIRouter
from sqlalchemy import text

from app.db import get_engine
from app.errors import ApiError
from app.redis_client import get_redis
from app.schemas import Health

router = APIRouter(tags=["Health"])


@router.get("/healthz", response_model=Health, summary="The process is up")
def healthz() -> Health:
    return Health(status="ok", service="raasta")


@router.get("/readyz", response_model=Health, summary="The database and Redis answer")
def readyz() -> Health:
    try:
        with get_engine().connect() as conn:
            conn.execute(text("SELECT 1"))
        get_redis().ping()
    except Exception as exc:
        raise ApiError(500, "INTERNAL", "A dependency isn't ready.") from exc
    return Health(status="ok", service="raasta")
