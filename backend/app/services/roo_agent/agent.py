"""One message to Roo: a few model steps with tools, then Roo's reply, with the card if it proposes changes.

At most 6 model calls, 12 tool calls and about 30 seconds a message; the last step must answer in words.
"""

from __future__ import annotations

import time
from typing import Any

from app.adapters.llm import AgentUnavailable, agent_model, gemini_step
from app.config import get_settings
from app.services.roo_agent import proposals
from app.services.roo_agent.internal import InternalApi
from app.services.roo_agent.prompt import SYSTEM, snapshot
from app.services.roo_agent.tools import Turn, call_tool, declarations

MAX_MODEL_CALLS = 6
MAX_TOOL_CALLS = 12
TURN_SECONDS = 30.0


async def run_turn(api: InternalApi, user_id: str, message: str, history: list[tuple[str, str]], trip_id: str | None) -> dict[str, Any]:
    settings = get_settings()
    model = agent_model() if not settings.roo_fake_llm else settings.roo_agent_model
    if model is None:
        raise AgentUnavailable("every model has used up its quota for now")
    trip = await api.get(f"/v1/trips/{trip_id}") if trip_id else None
    trips = (await api.get("/v1/trips", limit=20))["items"]
    turn = Turn(api=api, trip=trip, trips=trips, simulated=settings.simulated_services)
    # The conversation goes in as one transcript: a model turn first is refused by some Gemini models.
    said = "\n".join(f"{'Traveller' if role == 'user' else 'Roo'}: {text}" for role, text in history)
    prompt = f"{snapshot(trip, trips)}\n\nConversation so far:\n{said or '(none)'}\n\nTraveller: {message}"
    contents: list[dict[str, Any]] = [{"role": "user", "parts": [{"text": prompt}]}]
    tools = declarations(turn)
    deadline = time.monotonic() + TURN_SECONDS
    calls_made = 0
    reply = ""
    for n in range(MAX_MODEL_CALLS):
        final = n == MAX_MODEL_CALLS - 1 or calls_made >= MAX_TOOL_CALLS or time.monotonic() > deadline
        content = await gemini_step(SYSTEM, contents, tools, model=model, final=final)
        contents.append(content)
        parts = content["parts"]
        text = "".join(p["text"] for p in parts if isinstance(p.get("text"), str) and not p.get("thought")).strip()
        reply = text or reply
        calls = [p["functionCall"] for p in parts if isinstance(p.get("functionCall"), dict)]
        if not calls or final:
            break
        answers = []
        for call in calls:
            calls_made += 1
            name = str(call.get("name", ""))
            if calls_made > MAX_TOOL_CALLS:
                result: dict[str, Any] = {"ok": False, "error": "That's enough for one message: answer with what you have."}
            else:
                result = await call_tool(turn, name, call.get("args") or {})
            # Answers go back in the order of the calls, each with its call's id.
            answers.append({"functionResponse": {"name": name, "response": result, **({"id": call["id"]} if call.get("id") else {})}})
        contents.append({"role": "user", "parts": answers})
        if turn.ask:
            break
    if turn.ask:
        question = turn.ask["question"]
        reply = f"{reply} {question}" if reply and question not in reply else reply or question
    if not reply:
        reply = "Here's what I'll do. Tap Do all when you're ready." if turn.steps else "Sorry, I lost my thread there. Could you say that again?"
    return {
        "reply": reply[:800],
        "reads": list(dict.fromkeys(turn.reads)),
        "ask": turn.ask,
        "proposal": proposals.create(user_id, turn) if turn.steps else None,
    }
