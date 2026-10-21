"""Roo's voice: an alert read aloud with a natural voice."""

from __future__ import annotations

import logging
from typing import Annotated, Literal

from fastapi import APIRouter, Query, Response

from app.adapters import tts
from app.config import get_settings
from app.deps import CurrentUser
from app.errors import ApiError
from app.redis_client import get_redis_bytes
from app.schemas import VoiceOut

router = APIRouter(prefix="/v1/speech", tags=["speech"])
log = logging.getLogger("reroute.speech")


@router.get("/voices", response_model=list[VoiceOut], response_model_by_alias=True, summary="The voices Roo can speak with")
def voices(user: CurrentUser) -> list[VoiceOut]:
    return [VoiceOut(voice_id=k, label=v) for k, v in tts.VOICES.items()]


@router.get(
    "",
    response_class=Response,
    responses={200: {"content": {"audio/mpeg": {}}, "description": "MP3 audio"}},
    summary="Read a short alert aloud (MP3)",
)
async def speak(
    user: CurrentUser,
    text: Annotated[str, Query(min_length=1, max_length=300)],
    voice: Annotated[str, Query(max_length=40)] = "en-IN-NeerjaNeural",
    rate: Literal["slow", "normal", "fast"] = "normal",
) -> Response:
    if not get_settings().tts_enabled:
        raise ApiError(404, "Natural voices are off on this server.")
    if voice not in tts.VOICES:
        raise ApiError(422, "Choose one of the listed voices.", code="VALIDATION_ERROR")
    try:
        clip = await tts.synthesize(text.strip(), voice, rate, get_redis_bytes())
    except Exception as exc:  # the voice service is outside our control; the app falls back to its own voice
        log.warning("speech failed: %s", exc)
        raise ApiError(502, "The voice service didn't answer. Your phone's own voice reads the alert instead.") from exc
    return Response(clip.audio, media_type="audio/mpeg", headers={"Cache-Control": "private, max-age=604800"})
