"""LLM adapter for the AI day-planner helper.

When ANTHROPIC_API_KEY is set, uses Claude. Otherwise, a simple pattern-based
parser handles common day descriptions for the demo.
"""

from __future__ import annotations

import json
import logging
import re
from datetime import datetime, time as dtime, timedelta
from typing import Any

from app.config import get_settings

log = logging.getLogger("reroute.llm")

SYSTEM_PROMPT = """\
You are Roo, the travel planner inside Reroute. The traveller describes their \
day in a city and you extract structured tasks.

Return ONLY a JSON array. Each element is an object with these fields:
- "title": string, 1-120 chars, what the traveller needs to do.
- "placeText": string, the place or area name as they said it.
- "durationMin": integer, estimated minutes (minimum 15, maximum 720).
- "fixedStart": string or null. If the traveller gives an exact time, format as \
  "HH:MM" (24h). Otherwise null.
- "priority": 1 (must do), 2 (should do), or 3 (if time allows). Default 2.

Rules:
- Never invent a place or route the traveller didn't mention.
- Never include personal data beyond what was typed.
- If a time like "10am" or "10:00" is given, set fixedStart.
- If a window like "before 3pm" or "between 12 and 2" is given, do NOT set \
  fixedStart. Just set the duration.
- If no duration is mentioned, estimate reasonably (meeting 60, bank 45, lunch 60, \
  shopping 90, office 120).
- Respond with the JSON array only, no markdown fencing, no explanation.
"""


async def extract_tasks_llm(text: str, city: str, trip_date: str) -> list[dict[str, Any]]:
    settings = get_settings()
    if not settings.anthropic_api_key:
        return _extract_tasks_pattern(text, city, trip_date)

    try:
        import anthropic

        client = anthropic.AsyncAnthropic(api_key=settings.anthropic_api_key)
        response = await client.messages.create(
            model="claude-sonnet-4-20250514",
            max_tokens=2048,
            system=SYSTEM_PROMPT,
            messages=[{"role": "user", "content": f"City: {city}. Date: {trip_date}.\n\n{text}"}],
        )
        raw = response.content[0].text.strip()
        if raw.startswith("```"):
            raw = re.sub(r"^```\w*\n?", "", raw)
            raw = re.sub(r"\n?```$", "", raw)
        tasks = json.loads(raw)
        if not isinstance(tasks, list):
            log.warning("LLM returned non-list: %s", type(tasks))
            return []
        return [_validate_task(t) for t in tasks if isinstance(t, dict) and _validate_task(t)]
    except Exception:
        log.exception("LLM call failed, falling back to pattern parser")
        return _extract_tasks_pattern(text, city, trip_date)


def _validate_task(t: dict[str, Any]) -> dict[str, Any] | None:
    title = str(t.get("title", "")).strip()[:120]
    if not title:
        return None
    place = str(t.get("placeText", "")).strip()
    dur = t.get("durationMin", 60)
    if not isinstance(dur, (int, float)):
        dur = 60
    dur = max(15, min(720, int(dur)))
    fixed = t.get("fixedStart")
    if isinstance(fixed, str) and re.match(r"^\d{2}:\d{2}$", fixed):
        pass
    else:
        fixed = None
    pri = t.get("priority", 2)
    if pri not in (1, 2, 3):
        pri = 2
    return {"title": title, "placeText": place, "durationMin": dur, "fixedStart": fixed, "priority": pri}


# ---------------------------------------------------------------------------
# Fallback: simple pattern-based parser for common day descriptions
# ---------------------------------------------------------------------------

_TIME_RE = re.compile(
    r"(?:at\s+|from\s+|by\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm|AM|PM)?",
)

_DURATION_RE = re.compile(
    r"(?:for\s+)?(\d+)\s*(?:hours?|hrs?|h)\b"
    r"|(?:for\s+)?(\d+)\s*(?:minutes?|mins?|m)\b"
    r"|(?:for\s+)?(\d+(?:\.\d+)?)\s*(?:hours?|hrs?|h)\s*(?:and\s+)?(\d+)\s*(?:minutes?|mins?|m)?",
    re.IGNORECASE,
)

_COMMON_DURATIONS: dict[str, int] = {
    "meeting": 60,
    "lunch": 60,
    "dinner": 90,
    "breakfast": 45,
    "bank": 45,
    "office": 120,
    "work": 120,
    "gym": 90,
    "doctor": 45,
    "hospital": 60,
    "shop": 90,
    "shopping": 90,
    "temple": 30,
    "church": 30,
    "mosque": 30,
    "salon": 60,
    "haircut": 45,
    "laundry": 30,
    "post office": 30,
    "pharmacy": 20,
    "cafe": 45,
    "coffee": 30,
    "movie": 180,
    "park": 60,
    "walk": 45,
    "class": 60,
    "lecture": 60,
    "interview": 90,
    "appointment": 60,
}


def _parse_time(text: str) -> str | None:
    m = _TIME_RE.search(text)
    if not m:
        return None
    h = int(m.group(1))
    mm = int(m.group(2) or 0)
    ampm = (m.group(3) or "").lower()
    if ampm == "pm" and h < 12:
        h += 12
    elif ampm == "am" and h == 12:
        h = 0
    elif not ampm and h < 7:
        h += 12
    if 0 <= h <= 23 and 0 <= mm <= 59:
        return f"{h:02d}:{mm:02d}"
    return None


def _parse_duration(text: str) -> int | None:
    m = _DURATION_RE.search(text)
    if not m:
        return None
    if m.group(3) and m.group(4):
        return int(float(m.group(3)) * 60 + int(m.group(4)))
    if m.group(1):
        return int(m.group(1)) * 60
    if m.group(2):
        return int(m.group(2))
    return None


def _guess_duration(text: str) -> int:
    lower = text.lower()
    for keyword, dur in _COMMON_DURATIONS.items():
        if keyword in lower:
            return dur
    return 60


def _extract_place(text: str) -> str:
    for prefix in ("at ", "in ", "near ", "to ", "@ "):
        search_from = 0
        while True:
            idx = text.lower().find(prefix, search_from)
            if idx < 0:
                break
            rest = text[idx + len(prefix) :].strip()
            end = len(rest)
            for delim in (",", " for ", " from ", " at ", " in ", " till ", " until ", " then "):
                pos = rest.lower().find(delim)
                if pos > 0:
                    end = min(end, pos)
            place = rest[:end].strip().rstrip(".,;")
            if place and not _TIME_LIKE.match(place):
                return place
            search_from = idx + len(prefix)
    return ""


_NOISE_WORDS = {"at", "from", "to", "for", "in", "near", "am", "pm", "around", "about", "by", "till", "until", "the", "my", "i", "have", "a", "an", "some", "go", "need", "want"}
_TIME_LIKE = re.compile(r"^\d{1,2}(?::\d{2})?(?:am|pm)?$", re.IGNORECASE)


def _clean_title(chunk: str, place: str) -> str:
    place_words = set(place.lower().split()) if place else set()
    words = []
    for word in chunk.split():
        low = word.lower().rstrip(".,;:")
        if _TIME_LIKE.match(low):
            continue
        if low in _NOISE_WORDS:
            continue
        if low in place_words:
            continue
        words.append(word)
    raw = " ".join(words).strip().rstrip(".,;:")
    if not raw:
        raw = chunk.split()[0] if chunk.split() else "Task"
    return (raw[0].upper() + raw[1:])[:120]


def _extract_tasks_pattern(text: str, city: str, trip_date: str) -> list[dict[str, Any]]:
    chunks = re.split(r"\bthen\b|,\s*(?:and\s+)?|\band\b(?:\s+then)?|\n+|;\s*", text, flags=re.IGNORECASE)
    tasks: list[dict[str, Any]] = []
    for chunk in chunks:
        chunk = chunk.strip()
        if len(chunk) < 3:
            continue
        place = _extract_place(chunk)
        title = _clean_title(chunk, place)
        fixed = _parse_time(chunk)
        dur = _parse_duration(chunk) or _guess_duration(chunk)
        dur = max(15, min(720, dur))

        pri = 2
        lower = chunk.lower()
        if any(w in lower for w in ("must", "important", "critical", "urgent")):
            pri = 1
        elif any(w in lower for w in ("if time", "optional", "maybe", "possibly")):
            pri = 3

        tasks.append({"title": title, "placeText": place, "durationMin": dur, "fixedStart": fixed, "priority": pri})
    return tasks
