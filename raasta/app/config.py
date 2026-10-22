"""Settings. Every value comes from an environment variable documented in .env.example."""

from __future__ import annotations

from functools import lru_cache
from typing import Literal

from pydantic import Field, model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    #: Unset means production, so a forgotten setting fails closed.
    app_env: Literal["development", "test", "production"] = "production"
    database_url: str = "postgresql+psycopg://raasta_app:raasta_app@localhost:5432/reroute"
    redis_url: str = "redis://localhost:6379/1"
    mongo_url: str = "mongodb://localhost:27017"
    mongo_db: str = "reroute"
    jwt_secret: str = Field(default="dev-only-change-me", min_length=16)
    jwt_issuer: str = "reroute"
    jwt_audience: str = "reroute-api"
    osrm_url: str | None = None
    osrm_profile: str = "driving"
    osrm_timeout_s: float = 4.0
    max_body_bytes: int = 1024 * 1024
    city_utc_offset: str = "+05:30"
    walk_radius_m: int = 800
    walk_speed_m_per_min: int = 80
    stand_reuse_radius_m: int = 30
    rate_limit_per_minute: int = 60
    contributions_per_day: int = 10
    #: The Reroute API sends this as X-Service-Token; its reads then share one larger bucket. Empty turns it off.
    raasta_service_token: str = ""
    service_rate_limit_per_minute: int = 3000
    examples_dir: str = "../examples/bengaluru"
    log_level: str = "INFO"

    @model_validator(mode="after")
    def _no_dev_secret_in_production(self) -> Settings:
        if self.app_env == "production" and (self.jwt_secret.startswith(("dev-only", "change-me")) or len(self.jwt_secret.encode()) < 32):
            raise ValueError("Set a real JWT_SECRET (32 or more random bytes) in production")
        token = self.raasta_service_token
        if self.app_env == "production" and token and (token.startswith(("dev-only", "change-me")) or len(token) < 32):
            raise ValueError("Set a real RAASTA_SERVICE_TOKEN (32 or more random characters) in production, or leave it empty")
        return self


@lru_cache
def get_settings() -> Settings:
    return Settings()
