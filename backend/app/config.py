"""Settings. Every value comes from an environment variable documented in backend/.env.example."""

from __future__ import annotations

from functools import lru_cache
from pathlib import Path
from typing import Literal

from pydantic import Field, model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    #: Unset means production, so a forgotten setting fails closed (no demo login, real secrets only).
    app_env: Literal["development", "test", "production"] = "production"
    database_url: str = "postgresql+psycopg://reroute_app:reroute_app@localhost:5432/reroute"
    redis_url: str = "redis://localhost:6379/0"
    mongo_url: str = "mongodb://localhost:27017/reroute"

    jwt_secret: str = Field(default="dev-only-change-me-dev-only-change-me", min_length=32)
    access_token_minutes: int = 15
    refresh_token_days: int = 30
    cookie_secure: bool = True

    demo_login: bool = False

    google_client_id: str = ""
    google_client_secret: str = ""
    google_redirect_uri: str = "postmessage"

    raasta_base_url: str = "http://raasta:8001"
    osrm_car_url: str = "http://osrm-car:5000"
    osrm_foot_url: str = "http://osrm-foot:5000"
    nominatim_url: str = "https://nominatim.openstreetmap.org"
    #: OSRM server for drawing legs along roads on the map (not for planning). Empty draws straight lines.
    road_path_url: str = "https://router.project-osrm.org"
    nominatim_user_agent: str = "Reroute student project (contact via repository)"
    travel_times_source: Literal["sample", "osrm"] = "sample"
    examples_dir: Path = Path(__file__).resolve().parents[2] / "examples"

    max_body_bytes: int = 64 * 1024
    rate_limit_per_minute: int = 60
    auth_rate_limit_per_minute: int = 10
    idempotency_ttl_seconds: int = 24 * 3600
    checkin_wait_seconds: float = 8.0
    public_base_url: str = "https://localhost"

    ai_helper_enabled: bool = False
    gemini_api_key: str = ""
    #: Flash-Lite answers in a few seconds; full Flash spends ~30 s thinking first, too slow for a waiting traveller.
    gemini_model: str = "gemini-3.5-flash-lite"
    #: Tests run jobs inline. Never set in a deployment: planning must stay in the worker.
    queue_sync: bool = False

    @model_validator(mode="after")
    def _guard_production(self) -> Settings:
        if self.app_env == "production":
            if self.demo_login:
                raise ValueError("DEMO_LOGIN=true is refused when APP_ENV=production.")
            if self.jwt_secret.startswith(("dev-only", "change-me")) or len(self.jwt_secret.encode()) < 32:
                raise ValueError("Set a real JWT_SECRET (32 or more random bytes) in production.")
            if self.queue_sync:
                raise ValueError("QUEUE_SYNC is for tests only.")
        return self


@lru_cache
def get_settings() -> Settings:
    return Settings()
