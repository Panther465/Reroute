"""Roo, the agent: a message in, Roo's reply out, with at most one card of changes. The card changes nothing
until the traveller taps Do all; Undo takes it back. On only with AI_HELPER_ENABLED and a Gemini key."""

from __future__ import annotations

import time

from fastapi import APIRouter, Request
from fastapi.concurrency import run_in_threadpool

from app.adapters.llm import AgentUnavailable
from app.config import get_settings
from app.deps import CurrentUser
from app.errors import ApiError
from app.redis_client import get_redis
from app.schemas import PostBody, RooAgentIn, RooAgentOut, RooProposalOut, RooRunOut
from app.services.roo_agent import proposals
from app.services.roo_agent.agent import run_turn
from app.services.roo_agent.internal import CallFailed, InternalApi

router = APIRouter(prefix="/v1/roo", tags=["roo"])


def _agent_on() -> None:
    s = get_settings()
    if not (s.ai_helper_enabled and (s.gemini_api_key or s.roo_fake_llm)):
        raise ApiError(404, "Roo's agent isn't switched on for this server.")


def _within_limits(user_id: str) -> None:
    """Each message may call the model several times, so the agent has its own limits per traveller."""
    s = get_settings()
    r = get_redis()
    minute, day = f"roo:agent:m:{user_id}:{int(time.time() // 60)}", f"roo:agent:d:{user_id}:{time.strftime('%Y-%m-%d')}"
    used_minute, used_day = r.incr(minute), r.incr(day)
    if used_minute == 1:
        r.expire(minute, 70)
    if used_day == 1:
        r.expire(day, 25 * 3600)
    if used_minute > s.roo_agent_per_minute or used_day > s.roo_agent_per_day:
        raise ApiError(429, "Roo needs a breather. Try again in a minute.", code="RATE_LIMITED", headers={"Retry-After": "60"})


def _api(request: Request) -> InternalApi:
    return InternalApi(request.app, request.headers.get("authorization", ""))


def _mine(proposal_id: str, user_id: str) -> dict:
    proposal = proposals.load(proposal_id, user_id)
    if proposal is None:
        raise ApiError(404, "That suggestion has expired. Ask Roo again.")
    return proposal


@router.post(
    "/turns", response_model=RooAgentOut, response_model_by_alias=True, summary="Talk to Roo: it reads your trip and puts any changes on one card (AI helper)"
)
async def turn(body: RooAgentIn, request: Request, user: CurrentUser) -> RooAgentOut:
    _agent_on()
    await run_in_threadpool(_within_limits, user.user_id)
    async with _api(request) as api:
        try:
            out = await run_turn(api, user.user_id, body.message, [(t.role, t.text) for t in body.history], body.trip_id)
        except AgentUnavailable as exc:
            raise ApiError(503, "Roo can't think that through right now. Try again in a moment.", code="UNAVAILABLE") from exc
        except CallFailed as exc:
            raise ApiError(exc.status if exc.status in (404, 409) else 502, exc.message, code=exc.code) from exc
    return RooAgentOut.model_validate(out)


@router.get("/proposals/{proposal_id}", response_model=RooProposalOut, response_model_by_alias=True, summary="A card Roo made, while it's kept")
def get_proposal(proposal_id: str, user: CurrentUser) -> RooProposalOut:
    return RooProposalOut.model_validate(proposals.view(_mine(proposal_id, user.user_id)))


@router.post("/proposals/{proposal_id}/execute", response_model=RooRunOut, response_model_by_alias=True, summary="Do everything on Roo's card, in order")
async def execute(proposal_id: str, body: PostBody, request: Request, user: CurrentUser) -> RooRunOut:
    _agent_on()
    proposal = await run_in_threadpool(_mine, proposal_id, user.user_id)
    if proposal["state"] != "ready":
        raise ApiError(409, "Roo has already done this.", code="ALREADY_DONE")
    if not await run_in_threadpool(proposals.claim, proposal_id):
        raise ApiError(409, "Roo is already on it.", code="IN_PROGRESS")
    try:
        async with _api(request) as api:
            trip = await api.get(f"/v1/trips/{proposal['tripId']}") if proposal["tripId"] else None
            # Made for the day as it was: if a task or the fixes on offer changed since, ask again.
            if proposals.fingerprint(trip) != proposal["fingerprint"]:
                raise ApiError(409, "Your day changed since Roo suggested this. Ask again and Roo will look at it as it is now.", code="STALE")
            out = await proposals.execute(api, proposal, trip)
    except CallFailed as exc:
        raise ApiError(exc.status if exc.status in (404, 409) else 502, exc.message, code=exc.code) from exc
    finally:
        await run_in_threadpool(proposals.release, proposal_id)
    return RooRunOut.model_validate(out)


@router.post("/proposals/{proposal_id}/undo", response_model=RooRunOut, response_model_by_alias=True, summary="Take back what Roo's card did")
async def undo(proposal_id: str, body: PostBody, request: Request, user: CurrentUser) -> RooRunOut:
    _agent_on()
    proposal = await run_in_threadpool(_mine, proposal_id, user.user_id)
    if proposal["state"] not in ("done", "partial") or not proposal.get("run", {}).get("canUndo"):
        raise ApiError(409, "There's nothing of this to undo.", code="NOTHING_TO_UNDO")
    if not await run_in_threadpool(proposals.claim, proposal_id):
        raise ApiError(409, "Roo is already on it.", code="IN_PROGRESS")
    try:
        async with _api(request) as api:
            out = await proposals.undo(api, proposal)
    except CallFailed as exc:
        raise ApiError(exc.status if exc.status in (404, 409) else 502, exc.message, code=exc.code) from exc
    finally:
        await run_in_threadpool(proposals.release, proposal_id)
    return RooRunOut.model_validate(out)
