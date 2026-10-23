"""LLM adapter for the AI day-planner helper.

When GEMINI_API_KEY is set, asks Google's Gemini API. Without a key, or when Gemini fails or the
free-tier quota is used up, a pattern-based parser handles common day descriptions.
"""

from __future__ import annotations

import json
import logging
import re
from typing import Any

import httpx

from app.config import get_settings

log = logging.getLogger("reroute.llm")

GEMINI_URL = "https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent"
GEMINI_TIMEOUT_SECONDS = 20.0
#: A fixed time the model gives must be a real 24-hour "HH:MM"; anything else ("25:99", "10am") is dropped.
HHMM = re.compile(r"^([01]\d|2[0-3]):[0-5]\d$")

_TASKS_SCHEMA: dict[str, Any] = {
    "type": "ARRAY",
    "items": {
        "type": "OBJECT",
        "properties": {
            "title": {"type": "STRING"},
            "placeText": {"type": "STRING"},
            "durationMin": {"type": "INTEGER"},
            "fixedStart": {"type": "STRING", "nullable": True},
            "priority": {"type": "INTEGER"},
        },
        "required": ["title", "placeText", "durationMin", "priority"],
    },
}

SYSTEM_PROMPT = """\
You are Rico, the travel planner inside Reroute. The traveller describes their \
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
- Respond with the JSON array only, no explanation.
"""


async def extract_tasks_llm(text: str, city: str, trip_date: str, client: httpx.AsyncClient | None = None) -> list[dict[str, Any]]:
    settings = get_settings()
    if not settings.gemini_api_key:
        return _extract_tasks_pattern(text, city, trip_date)

    try:
        raw = await _ask_gemini(f"City: {city}. Date: {trip_date}.\n\n{text}", settings.gemini_api_key, settings.gemini_model, client)
        tasks = json.loads(raw)
    except httpx.HTTPStatusError as err:
        # 429 means the free tier's per-minute or per-day quota is used up.
        log.warning("Gemini answered %s; using the pattern parser", err.response.status_code)
        return _extract_tasks_pattern(text, city, trip_date)
    except (httpx.HTTPError, ValueError, LookupError, TypeError):
        log.warning("Gemini call failed; using the pattern parser", exc_info=True)
        return _extract_tasks_pattern(text, city, trip_date)
    if not isinstance(tasks, list):
        log.warning("Gemini returned %s, not a list; using the pattern parser", type(tasks).__name__)
        return _extract_tasks_pattern(text, city, trip_date)
    return [v for t in tasks if isinstance(t, dict) and (v := _validate_task(t))]


async def _ask_gemini(prompt: str, api_key: str, model: str, client: httpx.AsyncClient | None) -> str:
    return await _generate(SYSTEM_PROMPT, prompt, _TASKS_SCHEMA, 0.2, api_key, model, client)


# ---------- talking to Roo ----------

#: What Roo may offer to do. The app shows a card for each change; nothing happens until the traveller taps it.
ROO_ACTIONS = ("none", "late", "done", "left", "skip", "move", "duration", "time", "add", "replan", "undo", "why", "summary", "theme")

_ROO_SCHEMA: dict[str, Any] = {
    "type": "OBJECT",
    "properties": {
        "reply": {"type": "STRING"},
        "action": {"type": "STRING", "enum": list(ROO_ACTIONS)},
        "taskId": {"type": "STRING", "nullable": True},
        "minutes": {"type": "INTEGER", "nullable": True},
        "time": {"type": "STRING", "nullable": True},
        "day": {"type": "STRING", "nullable": True},
        "text": {"type": "STRING", "nullable": True},
        "theme": {"type": "STRING", "nullable": True},
    },
    "required": ["reply", "action"],
}

ROO_PROMPT = """\
You are Rico, a small, warm travel companion inside Reroute, an app that plans a traveller's work day \
in an Indian city and re-plans it when they run late. You talk with the traveller about their day.

Answer with ONE JSON object:
- "reply": what you say. Friendly, plain English, at most two short sentences. No emoji, no markdown.
- "action": one of none, late, done, left, skip, move, duration, time, add, replan, undo, why, summary, theme.
- "taskId": for skip, move, duration and time, the id of the task from the day below. Otherwise null.
- "minutes": for late, how late (5 to 240); for duration, the task's new length (15 to 720). Otherwise null.
- "time": for time, the new fixed start as "HH:MM" (24-hour). Otherwise null.
- "day": for move, the trip day to move the task to as "YYYY-MM-DD". Otherwise null.
- "text": for add, the new task in the traveller's words. Otherwise null.
- "theme": for theme, "light", "dark" or "system". Otherwise null.

Actions: late = the traveller is running late; done = the current task is finished; left = they have \
left for the next stop; skip = drop a task today; move = do a task on another trip day; duration = change \
how long a task takes; time = give a task a fixed start; add = a new task; replan = plan the rest of the \
day again; undo = bring back the earlier plan; why = they ask why the plan is like this; summary = how the \
day is going or what it cost; theme = light or dark mode.

Rules:
- Use only the tasks, places, times and fares listed below. Never invent a place, a route, a fare or a time.
- You never change anything yourself. For a change, say what you'd do and ask; the app asks the \
traveller to confirm. Don't say it's done.
- If the traveller asks something you can't do, say so kindly and suggest what you can do.
- For anything unrelated to the trip, answer in one friendly sentence and bring them back to their day.
- Answer questions about the day (what's next, when to leave, when they'll be back) from the day below, \
with action none.
"""


async def roo_chat(message: str, history: list[tuple[str, str]], context: str, client: httpx.AsyncClient | None = None) -> dict[str, Any] | None:
    """Roo's answer to one message, from Gemini; None without a key or when Gemini fails (the app answers itself)."""
    settings = get_settings()
    if not settings.gemini_api_key:
        return None
    # The conversation goes in as one transcript: a model turn first is rejected by some Gemini models.
    lines = [f"{'Traveller' if role == 'user' else 'Rico'}: {text}" for role, text in history]
    prompt = f"{context}\n\nConversation so far:\n{chr(10).join(lines) or '(none)'}\n\nTraveller: {message}"
    try:
        raw = json.loads(await _generate(ROO_PROMPT, prompt, _ROO_SCHEMA, 0.4, settings.gemini_api_key, settings.gemini_model, client))
    except httpx.HTTPStatusError as err:
        log.warning("Gemini answered %s for Roo", err.response.status_code)
        return None
    except (httpx.HTTPError, ValueError, LookupError, TypeError):
        log.warning("Gemini call for Roo failed", exc_info=True)
        return None
    return raw if isinstance(raw, dict) else None


async def _generate(system: str, prompt: str, schema: dict[str, Any], temperature: float, api_key: str, model: str, client: httpx.AsyncClient | None) -> str:
    body = {
        "systemInstruction": {"parts": [{"text": system}]},
        "contents": [{"role": "user", "parts": [{"text": prompt}]}],
        "generationConfig": {"temperature": temperature, "responseMimeType": "application/json", "responseSchema": schema},
    }
    # The key goes in a header, not the URL, so it never lands in access or error logs.
    url = GEMINI_URL.format(model=model)
    headers = {"x-goog-api-key": api_key}
    if client is None:
        async with httpx.AsyncClient(timeout=GEMINI_TIMEOUT_SECONDS) as own:
            res = await own.post(url, json=body, headers=headers)
    else:
        res = await client.post(url, json=body, headers=headers)
    res.raise_for_status()
    parts = res.json()["candidates"][0]["content"]["parts"]
    return "".join(p.get("text", "") for p in parts if not p.get("thought"))


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
    if not (isinstance(fixed, str) and HHMM.match(fixed)):
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


_NOISE_WORDS = {
    "at", "from", "to", "for", "in", "near", "am", "pm", "around", "about", "by", "till", "until",
    "the", "my", "i", "have", "a", "an", "some", "go", "need", "want",
}  # fmt: skip
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
