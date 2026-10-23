"""The card: kept 15 minutes for the traveller to confirm, run step by step when they tap Do all, and undone.

Kept in Redis, not the database: a card lives minutes, and what it did is recorded by the API calls it makes
(tasks, check-ins, bookings, plan versions and the Reroute log). Each step's call carries its own idempotency
key, so a run that is retried never does a step twice.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import secrets
import time
from dataclasses import asdict, dataclass, field
from datetime import UTC, datetime, timedelta
from typing import Any

from app.redis_client import get_redis
from app.services.roo_agent.internal import CallFailed, InternalApi
from app.services.roo_agent.tools import NEW_TRIP, Step, Turn

PROPOSAL_SECONDS = 15 * 60
#: After it runs, a card is kept a day for Undo.
KEPT_SECONDS = 24 * 3600
JOB_WAIT_SECONDS = 25.0
#: What Undo can't take back, said on the card before the tap.
_FINAL = {
    "top_up": "Money added to the wallet stays.",
    "create_trip": "The new trip stays.",
    "cancel_booking": "A cancelled booking stays cancelled.",
    "mark_done": "A task marked done stays done.",
}
#: Steps that change the plan; Undo brings back the plan from before them (as the app's own Undo does).
_PLAN_TOOLS = {"skip_task", "running_late", "plan_today", "choose_option", "undo_last_change", "change_task", "add_task", "remove_task"}


def _key(proposal_id: str) -> str:
    return f"roo:proposal:{proposal_id}"


def fingerprint(trip: dict[str, Any] | None) -> str | None:
    """The tasks and waiting fixes the card was made for: if they change before the tap, the card is stale."""
    if not trip:
        return None
    rows = sorted(
        [t["taskId"], t["state"], t["day"], t.get("fixedStart") or "", t["durationMin"], json.dumps(t.get("window"), sort_keys=True), t["placeId"]]
        for t in trip["tasks"]
    )
    return hashlib.sha256(json.dumps([rows, (trip.get("openOptions") or {}).get("optionSetId")]).encode()).hexdigest()


def _auto_plan(turn: Turn) -> None:
    """Tasks added to the day on screen (or a new trip's first day) get planned in: Roo adds that step itself."""
    for trip_id in dict.fromkeys(s.args["tripId"] for s in turn.steps if s.tool == "add_task"):
        if any(s.tool == "plan_today" and s.args["tripId"] == trip_id for s in turn.steps):
            continue
        day = turn.new_trip["startDate"] if trip_id == NEW_TRIP and turn.new_trip else (turn.trip or {}).get("day")
        if any(s.tool == "add_task" and s.args["tripId"] == trip_id and s.args["day"] == day for s in turn.steps):
            label = "Plan the first day" if trip_id == NEW_TRIP else "Plan the day again"
            turn.steps.append(
                Step(f"s{len(turn.steps) + 1}", "plan_today", "server", label, "plan", {"tripId": trip_id}, detail="So the new tasks fit in.", auto=True)
            )


def create(user_id: str, turn: Turn) -> dict[str, Any]:
    _auto_plan(turn)
    expires = datetime.now(UTC) + timedelta(seconds=PROPOSAL_SECONDS)
    stored = {
        "proposalId": "rp_" + secrets.token_urlsafe(12),
        "userId": user_id,
        "tripId": turn.trip["tripId"] if turn.trip else None,
        "fingerprint": fingerprint(turn.trip),
        "state": "ready",
        "expiresAt": expires.isoformat(),
        "steps": [asdict(s) for s in turn.steps],
        "final": list(dict.fromkeys(_FINAL[s.tool] for s in turn.steps if s.tool in _FINAL)),
    }
    save(stored, PROPOSAL_SECONDS)
    return view(stored)


def view(p: dict[str, Any]) -> dict[str, Any]:
    steps = [Step(**s) for s in p["steps"]]
    return {
        "proposalId": p["proposalId"],
        "tripId": p["tripId"],
        "steps": [s.view() for s in steps],
        "totalCostInr": sum(s.cost_inr or 0 for s in steps),
        "final": p["final"],
        "expiresAt": p["expiresAt"],
    }


def load(proposal_id: str, user_id: str) -> dict[str, Any] | None:
    """The card, if it's still kept and belongs to this traveller (anyone else gets nothing, as if it didn't exist)."""
    raw = get_redis().get(_key(proposal_id))
    proposal = json.loads(raw) if raw else None
    return proposal if proposal and proposal["userId"] == user_id else None


def save(p: dict[str, Any], seconds: int) -> None:
    get_redis().set(_key(p["proposalId"]), json.dumps(p), ex=seconds)


def claim(proposal_id: str) -> bool:
    """One run (or undo) at a time for a card."""
    return bool(get_redis().set(_key(proposal_id) + ":busy", "1", nx=True, ex=120))


def release(proposal_id: str) -> None:
    get_redis().delete(_key(proposal_id) + ":busy")


# ---------- running it ----------


@dataclass
class _Run:
    proposal_id: str
    trip_id: str | None
    new_trip_id: str | None = None
    #: How to take back each step that has an opposite, in the order they ran.
    undo: list[dict[str, Any]] = field(default_factory=list)
    #: Running late left fixes to choose from: the app opens them.
    options: bool = False

    def path(self, trip_id: str | None) -> str:
        if trip_id == NEW_TRIP:
            if not self.new_trip_id:
                raise CallFailed(409, "NO_TRIP", "The new trip wasn't started.")
            return f"/v1/trips/{self.new_trip_id}"
        return f"/v1/trips/{trip_id or self.trip_id}"


async def execute(api: InternalApi, p: dict[str, Any], trip: dict[str, Any] | None) -> dict[str, Any]:
    run = _Run(p["proposalId"], p["tripId"])
    plan = (trip or {}).get("activePlan")
    results: list[dict[str, Any]] = []
    phone: list[dict[str, Any]] = []
    stopped: dict[str, Any] | None = None
    for s in p["steps"]:
        if stopped:
            results.append({"stepId": s["step_id"], "status": "skipped", "message": "Not done: a step before it didn't work."})
        elif s["kind"] == "phone":
            results.append({"stepId": s["step_id"], "status": "phone", "message": ""})
            phone.append(Step(**s).view())
        else:
            try:
                results.append({"stepId": s["step_id"], "status": "done", "message": await _do(api, run, s)})
            except CallFailed as failed:
                stopped = {**s, "why": failed.message}
                results.append({"stepId": s["step_id"], "status": "failed", "message": failed.message})
    if run.options:
        phone.append(
            {"stepId": "options", "tool": "show_options", "kind": "phone", "label": "Choose how to fix the rest of the day", "icon": "option", "args": {}}
        )
    done = sum(1 for r in results if r["status"] in ("done", "phone"))
    ran = {s["tool"] for s, r in zip(p["steps"], results, strict=True) if r["status"] == "done"}
    # A task marked done stays done, so the plan from before it can't come back.
    restore = plan is not None and "mark_done" not in ran and bool(ran & _PLAN_TOOLS)
    p.update(
        state="done" if not stopped else "partial" if done else "failed",
        undo=run.undo,
        versionBefore=plan["version"] if restore and plan else None,
        newTripId=run.new_trip_id,
    )
    out = {
        "proposalId": p["proposalId"],
        "state": p["state"],
        "tripId": run.new_trip_id or p["tripId"],
        "steps": results,
        "phone": phone,
        "summary": _summary(p["steps"], done, stopped),
        "canUndo": bool(run.undo) or restore,
    }
    p["run"] = out
    save(p, KEPT_SECONDS)
    return out


def _summary(steps: list[dict[str, Any]], done: int, stopped: dict[str, Any] | None) -> str:
    if stopped is None:
        return "Done." if len(steps) == 1 else f"All {len(steps)} done."
    rest = f" I did {done} of {len(steps)} before it." if done else ""
    return f"I stopped at “{stopped['label']}”: {stopped['why']}{rest}"


async def _do(api: InternalApi, run: _Run, s: dict[str, Any]) -> str:
    tool, a = s["tool"], s["args"]
    key = f"roo-{run.proposal_id}-{s['step_id']}"
    if tool == "top_up":
        wallet = await api.post("/v1/wallet/topups", {"amountInr": a["amountInr"]}, key)
        return f"Your wallet has ₹{wallet['balanceInr']:,} now."
    if tool == "create_trip":
        run.new_trip_id = (await api.post("/v1/trips", a["body"], key))["tripId"]
        return "Trip started."
    base = run.path(a.get("tripId"))
    if tool == "add_task":
        task = await api.post(f"{base}/tasks", a["body"], key, replan=False)
        run.undo.append({"op": "delete", "path": f"{base}/tasks/{task['taskId']}"})
        return "Added."
    if tool == "change_task":
        edited = await api.patch(f"{base}/tasks/{a['taskId']}", a["patch"])
        run.undo.append({"op": "patch", "path": f"{base}/tasks/{a['taskId']}", "body": s["before"]})
        await _job(api, edited.get("jobId"))
        return "Changed."
    if tool in ("skip_task", "mark_done", "running_late"):
        kind = {"skip_task": "skipped", "mark_done": "done", "running_late": "delay"}[tool]
        body = {"taskId": a["taskId"], "kind": kind, **({"delayMin": a["minutes"]} if kind == "delay" else {})}
        out = await api.post(f"{base}/checkins", body, key)
        if out["result"] == "pending":
            await _job(api, out.get("jobId"))
        run.options = run.options or out["result"] == "options"
        return out.get("explanation") or "Done."
    if tool == "remove_task":
        await api.delete(f"{base}/tasks/{a['taskId']}")
        run.undo.append({"op": "add", "path": f"{base}/tasks", "body": a["restore"]})
        return "Removed."
    if tool == "plan_today":
        job = await api.post(f"{base}/plans", {}, key)
        await _job(api, job["jobId"], strict=True)
        return "Planned."
    if tool == "choose_option":
        await api.post(f"{base}/options/{a['optionId']}/accept", {"optionSetId": a["optionSetId"]}, key)
        return "Done."
    if tool == "undo_last_change":
        await api.post(f"{base}/plans/{a['version']}/activate", {}, key)
        return "Your earlier plan is back."
    if tool == "book_cab":
        # The fare follows the plan, which earlier steps may have changed: book only near what the card said.
        offered = await api.get(f"{base}/cab-options", toId=a["toId"])
        option = next((o for o in offered if o["optionId"] == a["optionId"]), None)
        if option is None:
            raise CallFailed(409, "GONE", "That ride isn't on offer any more. Ask me again.")
        if option["fareInr"] > s["cost_inr"] + max(20, s["cost_inr"] // 5):
            raise CallFailed(409, "FARE_UP", f"The fare is ₹{option['fareInr']:,} now, more than the ₹{s['cost_inr']:,} on the card. Ask me again.")
        booking = await api.post(f"{base}/bookings", {"kind": "cab", "toId": a["toId"], "optionId": a["optionId"]}, key)
        run.undo.append({"op": "cancel", "path": f"{base}/bookings/{booking['bookingId']}/cancel"})
        return f"Booked for ₹{booking['fareInr']:,}. Ride {booking['reference']}."
    if tool == "cancel_booking":
        booking = await api.post(f"{base}/bookings/{a['bookingId']}/cancel", {}, key)
        return f"Cancelled. ₹{booking['details'].get('refundInr', 0):,} is back in your wallet."
    raise CallFailed(400, "UNKNOWN_STEP", "Rico doesn't know how to do that.")


async def _job(api: InternalApi, job_id: str | None, strict: bool = False) -> None:
    """Wait for a planning job; with `strict`, a plan that didn't work fails the step."""
    if not job_id:
        return
    deadline = time.monotonic() + JOB_WAIT_SECONDS
    while True:
        job = await api.get(f"/v1/jobs/{job_id}")
        if job["status"] in ("finished", "failed"):
            break
        if time.monotonic() > deadline:
            if strict:
                raise CallFailed(504, "TIMEOUT", "Planning is taking longer than usual. Check your day in a minute.")
            return
        await asyncio.sleep(0.25)
    if strict and (job["status"] == "failed" or job.get("error")):
        raise CallFailed(409, "NO_FEASIBLE_PLAN", job.get("error") or "The day couldn't be planned.")


async def undo(api: InternalApi, p: dict[str, Any]) -> dict[str, Any]:
    """Take the card back: each step that has an opposite, last first, then the plan from before the card."""
    problems: list[str] = []
    for i, op in enumerate(reversed(p.get("undo", []))):
        key = f"roo-{p['proposalId']}-undo-{i}"
        try:
            if op["op"] == "delete":
                await api.delete(op["path"])
            elif op["op"] == "patch":
                edited = await api.patch(op["path"], op["body"])
                await _job(api, edited.get("jobId"))
            elif op["op"] == "add":
                await api.post(op["path"], op["body"], key, replan=False)
            elif op["op"] == "cancel":
                await api.post(op["path"], {}, key)
        except CallFailed as failed:
            problems.append(failed.message)
    before = p.get("versionBefore")
    if before is not None and p["tripId"]:
        trip = await api.get(f"/v1/trips/{p['tripId']}")
        if (trip.get("activePlan") or {}).get("version") != before:
            try:
                await api.post(f"/v1/trips/{p['tripId']}/plans/{before}/activate", {}, f"roo-{p['proposalId']}-undo-plan")
            except CallFailed as failed:
                problems.append(failed.message)
    p["state"] = "undone"
    save(p, KEPT_SECONDS)
    kept = " ".join(p.get("final", []))
    summary = "Undone. Your day is back as it was." if not problems else f"I undid what I could. {problems[0]}"
    return {
        "proposalId": p["proposalId"],
        "state": "undone",
        "tripId": p.get("newTripId") or p["tripId"],
        "steps": [],
        "phone": [],
        "summary": f"{summary} {kept}".strip(),
        "canUndo": False,
    }
