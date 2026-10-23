"""Talking to Roo: Gemini's answer is only an offer, checked against the trip before the app sees it."""

from __future__ import annotations

import asyncio
import json

import httpx
import pytest

from app.adapters.llm import roo_chat
from app.config import get_settings

from .conftest import key


def _gemini(seen: list[httpx.Request], reply: object = None, status: int = 200) -> httpx.AsyncClient:
    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        if status != 200:
            return httpx.Response(status, json={"error": {"code": status}})
        return httpx.Response(200, json={"candidates": [{"content": {"parts": [{"text": json.dumps(reply)}]}}]})

    return httpx.AsyncClient(transport=httpx.MockTransport(handler))


def test_roo_sends_the_day_and_the_conversation_as_one_transcript(monkeypatch):
    monkeypatch.setattr(get_settings(), "gemini_api_key", "test-key")
    seen: list[httpx.Request] = []
    reply = {"reply": "Shall I move the bank to Thursday?", "action": "move", "taskId": "task-bank"}

    out = asyncio.run(roo_chat("can the bank wait", [("roo", "Hi Arjun!"), ("user", "hello")], "Tasks:\n- id=task-bank", client=_gemini(seen, reply)))

    assert out == reply
    (req,) = seen
    assert req.headers["x-goog-api-key"] == "test-key" and "test-key" not in str(req.url)
    body = json.loads(req.content)
    text = body["contents"][0]["parts"][0]["text"]
    assert "id=task-bank" in text and "Rico: Hi Arjun!\nTraveller: hello" in text and text.endswith("Traveller: can the bank wait")
    assert body["generationConfig"]["responseSchema"]["required"] == ["reply", "action"]


def test_without_a_key_or_with_gemini_down_roo_leaves_it_to_the_app(monkeypatch):
    monkeypatch.setattr(get_settings(), "gemini_api_key", "")
    assert asyncio.run(roo_chat("hi", [], "")) is None
    monkeypatch.setattr(get_settings(), "gemini_api_key", "test-key")
    assert asyncio.run(roo_chat("hi", [], "", client=_gemini([], status=429))) is None


# ---------- through the API (database) ----------


def _plan(client):
    res = client.post("/v1/trips/trip-001/plans", json={"idempotencyKey": key()})
    assert res.status_code == 202, res.text


def _talk(client, monkeypatch, answer: dict | None, message: str = "hello", seen: list | None = None):
    monkeypatch.setattr(get_settings(), "ai_helper_enabled", True)

    async def fake(msg, history, context):
        if seen is not None:
            seen.append((msg, history, context))
        return answer

    monkeypatch.setattr("app.adapters.llm.roo_chat", fake)
    return client.post("/v1/trips/trip-001/roo", json={"message": message, "history": [{"role": "roo", "text": "Hi!"}], "idempotencyKey": key()})


@pytest.mark.db
def test_roo_reads_the_planned_day_and_offers_a_checked_move(client, monkeypatch):
    _plan(client)
    seen: list = []
    offer = {"reply": "Shall I move the bank to tomorrow?", "action": "move", "taskId": "task-bank", "day": None}
    res = _talk(client, monkeypatch, offer, "move the bank", seen)
    assert res.status_code == 200, res.text
    action = {"type": "move", "taskId": "task-bank", "minutes": None, "time": None, "day": "2026-10-15", "text": None, "theme": None}
    assert res.json() == {"reply": "Shall I move the bank to tomorrow?", "action": action}
    (msg, history, context) = seen[0]
    assert msg == "move the bank" and history == [("roo", "Hi!")]
    assert 'id=task-bank "Bank" at Koramangala' in context and "planned 12:25 to 14:55" in context
    assert "leave 08:50 by Metro, then shared auto to Meeting" in context


@pytest.mark.db
@pytest.mark.parametrize(
    "answer",
    [
        {"reply": "Skipping it.", "action": "skip", "taskId": "task-nope"},
        {"reply": "Two days long!", "action": "duration", "taskId": "task-bank", "minutes": 5000},
        {"reply": "At 25:00.", "action": "time", "taskId": "task-bank", "time": "25:00"},
        {"reply": "Purple mode.", "action": "theme", "theme": "purple"},
        {"reply": "Sure.", "action": "explode"},
    ],
)
def test_an_action_the_trip_does_not_allow_is_dropped_and_the_words_kept(client, monkeypatch, answer):
    res = _talk(client, monkeypatch, answer)
    assert res.status_code == 200, res.text
    assert res.json() == {"reply": answer["reply"], "action": None}


@pytest.mark.db
def test_roo_is_off_with_the_ai_helper_and_says_when_it_cannot_think(client, monkeypatch):
    monkeypatch.setattr(get_settings(), "ai_helper_enabled", False)
    off = client.post("/v1/trips/trip-001/roo", json={"message": "hi", "idempotencyKey": key()})
    assert off.status_code == 404
    down = _talk(client, monkeypatch, None)
    assert down.status_code == 503 and down.json()["error"]["code"] == "UNAVAILABLE"
