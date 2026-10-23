"""Roo's voice: an alert read aloud with a natural voice, and when each word is said."""

from __future__ import annotations

import base64
import logging
from typing import Annotated, Literal

from fastapi import APIRouter, Query, Response

from app.adapters import tts
from app.config import get_settings
from app.deps import CurrentUser
from app.errors import ApiError
from app.redis_client import get_redis_bytes
from app.schemas import SpeechTimedOut, SpeechWordOut, VoiceOut

router = APIRouter(prefix="/v1/speech", tags=["speech"])
log = logging.getLogger("reroute.speech")


@router.get("/voices", response_model=list[VoiceOut], response_model_by_alias=True, summary="The voices Rico can speak with")
def voices(user: CurrentUser) -> list[VoiceOut]:
    return [VoiceOut(voice_id=k, label=v) for k, v in tts.VOICES.items()]


def _check(voice: str) -> None:
    if not get_settings().tts_enabled:
        raise ApiError(404, "Natural voices are off on this server.")
    if voice not in tts.VOICES:
        raise ApiError(422, "Choose one of the listed voices.", code="VALIDATION_ERROR")


async def _clip(text: str, voice: str, rate: str, need_words: bool = False) -> tts.Clip:
    try:
        return await tts.synthesize(text.strip(), voice, rate, get_redis_bytes(), need_words=need_words)
    except Exception as exc:  # the voice service is outside our control; the app falls back to its own voice
        log.warning("speech failed: %s", exc)
        raise ApiError(502, "The voice service didn't answer. Your phone's own voice reads the alert instead.") from exc


@router.get("/timed", response_model=SpeechTimedOut, response_model_by_alias=True, summary="A line read aloud, with when each word is said")
async def speak_timed(
    user: CurrentUser,
    response: Response,
    text: Annotated[str, Query(min_length=1, max_length=300)],
    voice: Annotated[str, Query(max_length=40)] = tts.DEFAULT_VOICE,
    rate: Literal["slow", "normal", "fast"] = "normal",
) -> SpeechTimedOut:
    _check(voice)
    clip = await _clip(text, voice, rate, need_words=True)
    response.headers["Cache-Control"] = "private, max-age=604800"
    return SpeechTimedOut(
        audio=base64.b64encode(clip.audio).decode("ascii"),
        duration_ms=clip.duration_ms,
        words=[SpeechWordOut(text=w.text, offset_ms=w.offset_ms, duration_ms=w.duration_ms) for w in clip.words],
    )


@router.get(
    "",
    response_class=Response,
    responses={200: {"content": {"audio/mpeg": {}}, "description": "MP3 audio"}},
    summary="Read a short alert aloud (MP3)",
)
async def speak(
    user: CurrentUser,
    text: Annotated[str, Query(min_length=1, max_length=300)],
    voice: Annotated[str, Query(max_length=40)] = tts.DEFAULT_VOICE,
    rate: Literal["slow", "normal", "fast"] = "normal",
) -> Response:
    _check(voice)
    clip = await _clip(text, voice, rate)
    return Response(clip.audio, media_type="audio/mpeg", headers={"Cache-Control": "private, max-age=604800"})
