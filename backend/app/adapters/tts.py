"""Natural speech for Roo's alerts: Microsoft Edge's neural voices (the edge-tts library).

The service needs no key. Each clip is cached for 7 days, so a repeated alert costs nothing. When the
service can't be reached, the app falls back to the browser's own voice.
"""

from __future__ import annotations

import hashlib
from dataclasses import dataclass

#: The voices travellers can choose, by Edge's short name. The first is the default.
VOICES: dict[str, str] = {
    "en-IN-NeerjaNeural": "Neerja, Indian English",
    "en-IN-PrabhatNeural": "Prabhat, Indian English",
    "hi-IN-SwaraNeural": "Swara, Hindi accent",
    "hi-IN-MadhurNeural": "Madhur, Hindi accent",
    "en-GB-SoniaNeural": "Sonia, British English",
    "en-US-AriaNeural": "Aria, American English",
}
#: Speaking speeds, as Edge's rate offsets.
RATES: dict[str, str] = {"slow": "-15%", "normal": "+0%", "fast": "+15%"}
CACHE_SECONDS = 7 * 24 * 3600


@dataclass(frozen=True)
class Clip:
    audio: bytes
    cached: bool


def cache_key(text: str, voice: str, rate: str) -> str:
    return "tts:" + hashlib.sha256(f"{voice}|{rate}|{text}".encode()).hexdigest()


async def synthesize(text: str, voice: str, rate: str, redis_bytes) -> Clip:
    """MP3 audio of `text`. Raises on failure; the caller answers 502 and the app speaks it itself."""
    key = cache_key(text, voice, rate)
    hit = redis_bytes.get(key)
    if hit:
        return Clip(audio=hit, cached=True)
    import edge_tts

    audio = bytearray()
    async for chunk in edge_tts.Communicate(text, voice, rate=RATES[rate]).stream():
        if chunk["type"] == "audio":
            audio.extend(chunk["data"])
    if not audio:
        raise RuntimeError("No audio came back")
    redis_bytes.set(key, bytes(audio), ex=CACHE_SECONDS)
    return Clip(audio=bytes(audio), cached=False)
