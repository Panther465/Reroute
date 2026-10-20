"""AI helper adapter: asks Gemini when a key is set, and falls back to the pattern parser otherwise."""

from __future__ import annotations

import asyncio
import json

import httpx

from app.adapters.llm import extract_tasks_llm
from app.config import get_settings

DAY = "2026-10-14"


def _gemini(seen: list[httpx.Request], reply: object = None, status: int = 200) -> httpx.AsyncClient:
    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        if status != 200:
            return httpx.Response(status, json={"error": {"code": status, "status": "RESOURCE_EXHAUSTED"}})
        return httpx.Response(200, json={"candidates": [{"content": {"parts": [{"text": json.dumps(reply)}]}}]})

    return httpx.AsyncClient(transport=httpx.MockTransport(handler))


def test_gemini_reply_becomes_validated_tasks(monkeypatch):
    monkeypatch.setattr(get_settings(), "gemini_api_key", "test-key")
    seen: list[httpx.Request] = []
    reply = [
        {"title": "Bank work", "placeText": "Koramangala", "durationMin": 45, "fixedStart": "10:00", "priority": 1},
        {"title": "Lunch", "placeText": "MG Road", "durationMin": 5000, "fixedStart": "noon", "priority": 7},
        {"title": "", "placeText": "Indiranagar", "durationMin": 30, "priority": 2},
    ]

    tasks = asyncio.run(extract_tasks_llm("bank at 10 in Koramangala, lunch on MG Road", "Bengaluru", DAY, client=_gemini(seen, reply)))

    assert tasks == [
        {"title": "Bank work", "placeText": "Koramangala", "durationMin": 45, "fixedStart": "10:00", "priority": 1},
        {"title": "Lunch", "placeText": "MG Road", "durationMin": 720, "fixedStart": None, "priority": 2},
    ]
    (req,) = seen
    assert req.headers["x-goog-api-key"] == "test-key"
    assert "test-key" not in str(req.url)
    assert req.url.path.endswith(f"/models/{get_settings().gemini_model}:generateContent")
    body = json.loads(req.content)
    assert body["generationConfig"]["responseMimeType"] == "application/json"
    assert "Bengaluru" in body["contents"][0]["parts"][0]["text"]


def test_used_up_free_quota_falls_back_to_the_pattern_parser(monkeypatch):
    monkeypatch.setattr(get_settings(), "gemini_api_key", "test-key")
    seen: list[httpx.Request] = []

    tasks = asyncio.run(extract_tasks_llm("meeting at 10am at Koramangala", "Bengaluru", DAY, client=_gemini(seen, status=429)))

    assert len(seen) == 1
    assert tasks[0]["placeText"] == "Koramangala"
    assert tasks[0]["fixedStart"] == "10:00"


def test_without_a_key_gemini_is_never_called(monkeypatch):
    monkeypatch.setattr(get_settings(), "gemini_api_key", "")
    seen: list[httpx.Request] = []

    tasks = asyncio.run(extract_tasks_llm("lunch at MG Road", "Bengaluru", DAY, client=_gemini(seen, [])))

    assert seen == []
    assert tasks[0]["placeText"] == "MG Road"
