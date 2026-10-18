"""Settings. Every value comes from an environment variable documented in backend/.env.example."""

from __future__ import annotations

from functools import lru_cache
from pathlib import Path
from typing import Literal

from pydantic import Field, field_validator, model_validator
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

    #: The demo account, its Simulate panel and reset. Off unless switched on (and refused in production).
    demo_login: bool = False
    #: Simulated bookings, the wallet and connected partners, for every account: nothing real is booked
    #: or charged. Turn off where only real services should appear.
    simulated_services: bool = True

    google_client_id: str = ""
    google_client_secret: str = ""
    google_redirect_uri: str = "postmessage"
    #: Google Maps Platform (README, "Google Maps"): the server's key, for place search, Rico's guide (Places API
    #: (New)) and the map's tile sessions (Map Tiles API). Empty keeps OpenStreetMap's map, search and guide.
    google_maps_api_key: str = ""
    #: The key the app itself fetches Google's map tiles with: best a key of its own, restricted to the Map Tiles
    #: API and your sites. Empty uses GOOGLE_MAPS_API_KEY.
    google_maps_browser_key: str = ""
    #: Push notifications to the Android app through Firebase Cloud Messaging: the path of a Google service
    #: account key (JSON) with the "Firebase Cloud Messaging API Admin" role. Empty, or a file without a key,
    #: sends no pushes; alerts still come over the live stream while the app is open.
    fcm_credentials_file: str = ""
    #: This deployment sends pushes, though this process may not hold the key: Docker Compose gives it to the
    #: worker alone and sets this on every service from FCM_SERVICE_ACCOUNT, so the API can tell the app.
    #: Blank means no.
    fcm_push: bool = False

    raasta_base_url: str = "http://raasta:8001"
    #: Sent to Raasta as X-Service-Token, so the worker gets Raasta's service rate limit rather than a
    #: visitor's per-IP one. Raasta must have the same value. Empty sends none (development only).
    raasta_service_token: str = ""
    osrm_car_url: str = "http://osrm-car:5000"
    osrm_foot_url: str = "http://osrm-foot:5000"
    nominatim_url: str = "https://nominatim.openstreetmap.org"
    #: Real roads for the map and the directions (not for planning): FOSSGIS's public OSRM servers, car and
    #: foot, with turn-by-turn steps. Empty turns routing off, and legs are drawn as approximate straight lines.
    routing_car_url: str = "https://routing.openstreetmap.de/routed-car"
    routing_foot_url: str = "https://routing.openstreetmap.de/routed-foot"
    #: FOSSGIS's usage policy: name the app and a way to reach its makers.
    routing_user_agent: str = "Reroute student project (https://github.com/Panther465/Reroute)"
    #: At most one request a second to each routing server, and this many a day, across every API copy.
    routing_min_interval_ms: int = 1000
    routing_daily_limit: int = 5000
    #: Natural voices for Roo's alerts (Microsoft's neural voices). Off: the app uses the browser's voice.
    tts_enabled: bool = True
    #: Azure AI Speech, Microsoft's official service for those voices: with both set, it reads each line (its free
    #: F0 tier gives 0.5 million characters a month). Unset, or when Azure fails, Edge's free read-aloud service does.
    azure_speech_key: str = ""
    azure_speech_region: str = ""
    nominatim_user_agent: str = "Reroute student project (contact via repository)"
    travel_times_source: Literal["sample", "osrm"] = "sample"
    #: Rico's word about busy roads: "usual" is typical traffic by city, hour and weekday (services/traffic.py),
    #: guidance and never live data; "off" says nothing about traffic. A live provider would be another value here.
    traffic_source: Literal["usual", "off"] = "usual"
    examples_dir: Path = Path(__file__).resolve().parents[2] / "examples"

    max_body_bytes: int = 64 * 1024
    rate_limit_per_minute: int = 60
    #: Sign-in (Google and demo), per IP.
    auth_rate_limit_per_minute: int = 10
    #: Token refresh and sign-out, per IP: a page with several tabs refreshes often, so not the sign-in limit.
    session_rate_limit_per_minute: int = 60
    idempotency_ttl_seconds: int = 24 * 3600
    checkin_wait_seconds: float = 8.0
    public_base_url: str = "https://localhost"
    #: Origins allowed to call the API from another origin, comma-separated. The Android app runs at
    #: https://localhost inside the phone and calls the API's own host. Empty keeps CORS closed (one origin).
    cors_origins: str = ""
    #: Local time (minutes after midnight) from which the scheduler plans a trip day on its own.
    morning_plan_from_min: int = Field(default=6 * 60, ge=0, lt=24 * 60)

    ai_helper_enabled: bool = False
    gemini_api_key: str = ""
    #: Flash-Lite answers in a few seconds; full Flash spends ~30 s thinking first, too slow for a waiting traveller.
    gemini_model: str = "gemini-3.5-flash-lite"
    #: Roo as an agent (with AI_HELPER_ENABLED and a key): it reads the trip through tools and puts every change
    #: it would make on one card. Flash-Lite answers a step in three or four seconds and its free tier lasts a
    #: day of use; Flash reasons better but its free tier allows 20 requests a day. When this model's quota runs
    #: out, Roo uses GEMINI_MODEL until it's back.
    roo_agent_model: str = "gemini-3.5-flash-lite"
    #: Per traveller: messages to the agent a minute and a day (each may call the model several times).
    roo_agent_per_minute: int = 8
    roo_agent_per_day: int = 200
    #: Talking with Rico out loud (with the AI helper and a key): the realtime audio model. A session counts as one
    #: agent message.
    roo_live_model: str = "gemini-3.8-live"
    #: Set only to try another voice for him, or another pitch in semitones; left out, Rico's own.
    roo_live_voice: str = ""
    roo_live_pitch: float | None = Field(default=None, ge=-12, le=12)
    #: Tests and browser tests only: a JSON file of scripted model answers in place of Gemini.
    roo_fake_llm: str = ""
    #: Rico as a local guide (the agent's city_guide and places_near): Wikivoyage's city guides through the
    #: MediaWiki API, and OpenStreetMap's places near a point through Overpass. Free, no key; empty turns one off.
    #: Its web look-ups go through Gemini with Google Search, with the AI helper's key.
    wikivoyage_url: str = "https://en.wikivoyage.org/w/api.php"
    overpass_url: str = "https://overpass-api.de/api/interpreter"
    #: Tests run jobs inline. Never set in a deployment: planning must stay in the worker.
    queue_sync: bool = False

    @field_validator("fcm_push", mode="before")
    @classmethod
    def _blank_is_off(cls, value: object) -> object:
        return value if value not in ("", None) else False

    @field_validator("google_client_id", "google_client_secret", "google_maps_api_key", "google_maps_browser_key")
    @classmethod
    def _without_template_brackets(cls, value: str) -> str:
        """A value pasted into the guide's `GOOGLE_CLIENT_SECRET=<your client secret>` with its < > kept: Google's own
        IDs and secrets never have them, and with them Google refuses every sign-in."""
        value = value.strip()
        return value[1:-1].strip() if len(value) > 2 and value[0] == "<" and value[-1] == ">" else value

    @model_validator(mode="after")
    def _guard_production(self) -> Settings:
        if self.app_env == "production":
            if self.demo_login:
                raise ValueError("DEMO_LOGIN=true is refused when APP_ENV=production.")
            if self.jwt_secret.startswith(("dev-only", "change-me")) or len(self.jwt_secret.encode()) < 32:
                raise ValueError("Set a real JWT_SECRET (32 or more random bytes) in production.")
            if self.raasta_service_token.startswith(("dev-only", "change-me")) or len(self.raasta_service_token.encode()) < 32:
                raise ValueError("Set a real RAASTA_SERVICE_TOKEN (32 or more random characters) in production.")
            if self.queue_sync:
                raise ValueError("QUEUE_SYNC is for tests only.")
            if self.roo_fake_llm:
                raise ValueError("ROO_FAKE_LLM is for tests only.")
        if "*" in self.cors_origin_list:
            raise ValueError("CORS_ORIGINS lists origins one by one; '*' would let any site call the API.")
        return self

    @property
    def cors_origin_list(self) -> list[str]:
        return [o.strip().rstrip("/") for o in self.cors_origins.split(",") if o.strip()]


@lru_cache
def get_settings() -> Settings:
    return Settings()
