"""Natural speech for Roo's alerts, in Microsoft's neural voices.

With an Azure AI Speech key and its region (AZURE_SPEECH_KEY, AZURE_SPEECH_REGION), Microsoft's official service
reads each line. Without them, or when Azure doesn't answer (a wrong key, the free tier's limits), Microsoft Edge's
read-aloud service does, through the edge-tts library: it needs no key, but promises nothing. Each clip is cached
for 7 days, so a repeated alert costs nothing. When neither answers, the app falls back to the browser's own voice.

Each clip also comes with when each word is spoken (the services' WordBoundary events), so Roo's mouth can
follow the words: offsets and durations arrive in 100-nanosecond ticks.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import re
import uuid
from dataclasses import dataclass, field
from datetime import UTC, datetime
from xml.sax.saxutils import escape

from app.config import get_settings

#: The voices travellers can choose, by Microsoft's short name. The first is the default: Ana, a child's voice, is
#: Rico's own. It speaks as it is, with no pitch change, which Azure would bill as extra characters.
VOICES: dict[str, str] = {
    "en-US-AnaNeural": "Ana, Rico’s own voice",
    "en-IN-NeerjaNeural": "Neerja, Indian English",
    "en-IN-PrabhatNeural": "Prabhat, Indian English",
    "hi-IN-SwaraNeural": "Swara, Hindi accent",
    "hi-IN-MadhurNeural": "Madhur, Hindi accent",
    "en-GB-SoniaNeural": "Sonia, British English",
    "en-US-AriaNeural": "Aria, American English",
}
DEFAULT_VOICE = next(iter(VOICES))
#: Speaking speeds, as rate offsets.
RATES: dict[str, str] = {"slow": "-15%", "normal": "+0%", "fast": "+15%"}
CACHE_SECONDS = 7 * 24 * 3600
TICKS_PER_MS = 10_000
#: Both services send 48 kbps constant-bitrate MP3: 6 bytes a millisecond.
BYTES_PER_MS = 6
AZURE_FORMAT = "audio-24khz-48kbitrate-mono-mp3"
AZURE_TIMEOUT_SECONDS = 15
_SPOKEN = re.compile(r"[^\W_]")
log = logging.getLogger("reroute.speech")


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


def ssml(text: str, voice: str, rate: str) -> str:
    """The line as Azure reads it. Azure bills markup inside <voice> as characters, so the speed is set only when
    it isn't normal."""
    body = escape(text)
    if RATES[rate] != "+0%":
        body = f"<prosody rate='{RATES[rate]}'>{body}</prosody>"
    lang = "-".join(voice.split("-")[:2])
    return f"<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='{lang}'><voice name='{voice}'>{body}</voice></speak>"


def _headers(head: str) -> dict[str, str]:
    """A message's headers ("Path:audio" and the like), by lower-case name."""
    pairs = (line.partition(":") for line in head.split("\r\n"))
    return {name.strip().lower(): value.strip() for name, _, value in pairs}


def azure_audio(frame: bytes) -> bytes:
    """The audio in one of Azure's binary messages: two bytes giving the headers' length, the headers, the audio."""
    n = int.from_bytes(frame[:2], "big")
    return frame[2 + n :] if _headers(frame[2 : 2 + n].decode()).get("path") == "audio" else b""


def azure_marks(body: str) -> list[dict]:
    """Word timings from Azure's audio.metadata message, shaped as edge-tts gives them."""
    out = []
    for item in json.loads(body)["Metadata"]:
        if item["Type"] == "WordBoundary":
            d = item["Data"]
            out.append({"type": "WordBoundary", "offset": d["Offset"], "duration": d["Duration"], "text": d["text"]["Text"]})
    return out


def _azure_message(path: str, request_id: str, content_type: str, body: str) -> str:
    stamp = datetime.now(UTC).isoformat(timespec="milliseconds").replace("+00:00", "Z")
    return f"Path:{path}\r\nX-RequestId:{request_id}\r\nX-Timestamp:{stamp}\r\nContent-Type:{content_type}\r\n\r\n{body}"


async def _azure(text: str, voice: str, rate: str, key: str, region: str) -> tuple[bytes, list[dict]]:
    """Azure AI Speech, over the WebSocket its Speech SDK uses: its REST API sends no word timings."""
    import aiohttp

    request_id = uuid.uuid4().hex
    options = {"wordBoundaryEnabled": True, "sentenceBoundaryEnabled": False, "punctuationBoundaryEnabled": False}
    context = {"synthesis": {"audio": {"metadataOptions": options, "outputFormat": AZURE_FORMAT}, "language": {"autoDetection": False}}}
    url = f"wss://{region}.tts.speech.microsoft.com/cognitiveservices/websocket/v1"
    headers = {"Ocp-Apim-Subscription-Key": key, "X-ConnectionId": uuid.uuid4().hex}
    audio, marks = bytearray(), []
    async with aiohttp.ClientSession() as session, session.ws_connect(url, headers=headers) as ws:
        await ws.send_str(_azure_message("synthesis.context", request_id, "application/json", json.dumps(context)))
        await ws.send_str(_azure_message("ssml", request_id, "application/ssml+xml", ssml(text, voice, rate)))
        async for msg in ws:
            if msg.type == aiohttp.WSMsgType.BINARY:
                audio.extend(azure_audio(msg.data))
                continue
            if msg.type != aiohttp.WSMsgType.TEXT:
                break
            head, _, body = msg.data.partition("\r\n\r\n")
            path = _headers(head).get("path")
            if path == "audio.metadata":
                marks.extend(azure_marks(body))
            elif path == "turn.end":
                return bytes(audio), marks
        raise RuntimeError(f"Azure closed the connection before the end of the line (code {ws.close_code})")


async def _edge(text: str, voice: str, rate: str) -> tuple[bytes, list[dict]]:
    """Microsoft Edge's read-aloud service, through edge-tts."""
    import edge_tts

    audio, marks = bytearray(), []
    async for chunk in edge_tts.Communicate(text, voice, rate=RATES[rate], boundary="WordBoundary").stream():
        if chunk["type"] == "audio":
            audio.extend(chunk["data"])
        elif chunk["type"] == "WordBoundary":
            marks.append(chunk)
    return bytes(audio), marks


async def synthesize(text: str, voice: str, rate: str, redis_bytes, need_words: bool = False) -> Clip:
    """MP3 audio of `text`, and when each word is spoken: from Azure when it's set up, otherwise (or when Azure
    fails) from Edge. Raises when neither answers; the caller answers 502 and the app speaks it itself. Audio
    cached by an older version has no timings: asked for them, it's made again."""
    key, wkey = cache_key(text, voice, rate), words_key(text, voice, rate)
    hit = redis_bytes.get(key)
    if hit:
        timed = redis_bytes.get(wkey)
        if timed is not None:
            return Clip(audio=hit, cached=True, words=tuple(Word(**w) for w in json.loads(timed)))
        if not need_words:
            return Clip(audio=hit, cached=True)
    s = get_settings()
    audio, marks = b"", []
    if s.azure_speech_key and s.azure_speech_region:
        try:
            audio, marks = await asyncio.wait_for(_azure(text, voice, rate, s.azure_speech_key, s.azure_speech_region), AZURE_TIMEOUT_SECONDS)
        except Exception as exc:  # Azure is outside our control (a wrong key, the free tier's limits): Edge reads it instead
            log.warning("Azure speech failed, so Edge reads it: %s", exc)
    if not audio:
        audio, marks = await _edge(text, voice, rate)
    if not audio:
        raise RuntimeError("No audio came back")
    words = words_from_chunks(marks)
    pipe = redis_bytes.pipeline()
    pipe.set(key, audio, ex=CACHE_SECONDS)
    pipe.set(wkey, json.dumps([w.__dict__ for w in words]), ex=CACHE_SECONDS)
    pipe.execute()
    return Clip(audio=audio, cached=False, words=words)
