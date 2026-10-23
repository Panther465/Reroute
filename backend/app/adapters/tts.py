"""Natural speech for Roo's alerts: Microsoft Edge's neural voices (the edge-tts library).

The service needs no key. Each clip is cached for 7 days, so a repeated alert costs nothing. When the
service can't be reached, the app falls back to the browser's own voice.

Each clip also comes with when each word is spoken (the service's WordBoundary events), so Roo's mouth can
follow the words: offsets and durations arrive in 100-nanosecond ticks.
"""

from __future__ import annotations

import hashlib
import json
import re
from dataclasses import dataclass, field

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
TICKS_PER_MS = 10_000
#: The service sends 48 kbps constant-bitrate MP3: 6 bytes a millisecond.
BYTES_PER_MS = 6
_SPOKEN = re.compile(r"[^\W_]")


@dataclass(frozen=True)
class Word:
    text: str
    offset_ms: int
    duration_ms: int


@dataclass(frozen=True)
class Clip:
    audio: bytes
    cached: bool
    words: tuple[Word, ...] = field(default=())

    @property
    def duration_ms(self) -> int:
        return len(self.audio) // BYTES_PER_MS


def cache_key(text: str, voice: str, rate: str) -> str:
    return "tts:" + hashlib.sha256(f"{voice}|{rate}|{text}".encode()).hexdigest()


def words_key(text: str, voice: str, rate: str) -> str:
    return "ttsw:" + cache_key(text, voice, rate).removeprefix("tts:")


def words_from_chunks(chunks: list[dict]) -> tuple[Word, ...]:
    """Word timings from the service's WordBoundary events, in milliseconds. Punctuation isn't a word."""
    out = []
    for c in chunks:
        if c.get("type") != "WordBoundary" or not _SPOKEN.search(c.get("text") or ""):
            continue
        out.append(Word(text=c["text"], offset_ms=round(c["offset"] / TICKS_PER_MS), duration_ms=max(1, round(c["duration"] / TICKS_PER_MS))))
    return tuple(out)


async def synthesize(text: str, voice: str, rate: str, redis_bytes, need_words: bool = False) -> Clip:
    """MP3 audio of `text`, and when each word is spoken. Raises on failure; the caller answers 502 and the
    app speaks it itself. Audio cached by an older version has no timings: asked for them, it's made again."""
    key, wkey = cache_key(text, voice, rate), words_key(text, voice, rate)
    hit = redis_bytes.get(key)
    if hit:
        timed = redis_bytes.get(wkey)
        if timed is not None:
            return Clip(audio=hit, cached=True, words=tuple(Word(**w) for w in json.loads(timed)))
        if not need_words:
            return Clip(audio=hit, cached=True)
    import edge_tts

    audio = bytearray()
    marks: list[dict] = []
    async for chunk in edge_tts.Communicate(text, voice, rate=RATES[rate], boundary="WordBoundary").stream():
        if chunk["type"] == "audio":
            audio.extend(chunk["data"])
        elif chunk["type"] == "WordBoundary":
            marks.append(chunk)
    if not audio:
        raise RuntimeError("No audio came back")
    words = words_from_chunks(marks)
    pipe = redis_bytes.pipeline()
    pipe.set(key, bytes(audio), ex=CACHE_SECONDS)
    pipe.set(wkey, json.dumps([w.__dict__ for w in words]), ex=CACHE_SECONDS)
    pipe.execute()
    return Clip(audio=bytes(audio), cached=False, words=words)
