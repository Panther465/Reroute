"""Talking to Roo: the day in words for the model, and the model's answer checked against the trip.

The model only proposes. An action that names a task the trip doesn't have, a time that isn't a real
time or a length out of range is dropped, and Roo's words stay. Nothing here changes the trip.
"""

from __future__ import annotations

from datetime import date, datetime, timedelta, timezone
from typing import Any

from app.adapters.llm import HHMM, ROO_ACTIONS
from app.clock import tz_for
from app.schemas import TripOut

_PRIORITY = {1: "must do", 2: "should do", 3: "if there's time"}
_TASK_ACTIONS = ("skip", "move", "duration", "time")


def _hm(at: datetime, tz: timezone) -> str:
    return at.astimezone(tz).strftime("%H:%M")


def day_context(trip: TripOut) -> str:
    """The trip and today's plan, in lines the model reads."""
    tz = tz_for(trip.utc_offset)
    now = trip.now.astimezone(tz)
    today = now.date()
    lines = [
        f"Now: {now.strftime('%A %d %B %Y, %H:%M')} in {trip.city_name} (UTC{trip.utc_offset}).",
        f"Trip: {trip.city_name}, {trip.start_date} to {trip.end_date}. Staying at {trip.stay_label}.",
        "Tasks:",
    ]
    planned = {leg.task_id: leg for leg in trip.active_plan.legs} if trip.active_plan else {}
    for t in trip.tasks:
        bits = [f'id={t.task_id} "{t.title}" at {t.place.area}', f"on {t.day}", f"{t.duration_min} min", _PRIORITY.get(t.priority, "")]
        if t.fixed_start:
            bits.append(f"fixed start {_hm(t.fixed_start, tz)}")
        if t.window:
            bits.append(f"open {t.window.opens_at} to {t.window.closes_at}")
        bits.append(f"state {t.state}")
        if (leg := planned.get(t.task_id)) is not None:
            bits.append(f"planned {_hm(leg.task_start, tz)} to {_hm(leg.task_end, tz)}")
        lines.append("- " + ", ".join(b for b in bits if b))
    plan = trip.active_plan
    if plan and plan.day == today and plan.legs:
        lines.append(f"Today's plan (version {plan.version}), legs still to travel:")
        names = {t.task_id: t.title for t in trip.tasks}
        for leg in plan.legs:
            to = names.get(leg.task_id, trip.stay_label) if leg.task_id else trip.stay_label
            lines.append(f"- leave {_hm(leg.leave_by, tz)} by {leg.label} to {to}, arrive {_hm(leg.arrive_at, tz)}, about {leg.fare_inr} rupees")
        lines.append(f"Fares today about {plan.totals.fare_inr} rupees; {plan.totals.travel_min} min travelling.")
    else:
        lines.append("Today has no plan yet.")
    if trip.open_options:
        lines.append("The later stops no longer fit: fixes are waiting for the traveller to choose.")
    return "\n".join(lines)


def clean_answer(raw: dict[str, Any], trip: TripOut, message: str) -> dict[str, Any] | None:
    """Roo's reply and at most one action the trip allows; None when there's no usable reply."""
    reply = raw.get("reply")
    if not isinstance(reply, str) or not reply.strip():
        return None
    kind = raw.get("action") if raw.get("action") in ROO_ACTIONS else "none"
    open_tasks = {t.task_id: t for t in trip.tasks if t.state not in ("done", "skipped")}
    task = open_tasks.get(raw.get("taskId")) if isinstance(raw.get("taskId"), str) else None
    minutes = raw.get("minutes") if isinstance(raw.get("minutes"), int) and not isinstance(raw.get("minutes"), bool) else None
    action: dict[str, Any] = {"type": kind}

    if kind in _TASK_ACTIONS:
        if task is None:
            kind = "none"
        else:
            action["task_id"] = task.task_id
    if kind == "late":
        action["minutes"] = minutes if minutes is not None and 5 <= minutes <= 240 else None
    elif kind == "duration":
        if minutes is None or not 15 <= minutes <= 720:
            kind = "none"
        action["minutes"] = minutes
    elif kind == "time":
        time = raw.get("time")
        if not (isinstance(time, str) and HHMM.match(time)):
            kind = "none"
        action["time"] = time
    elif kind == "move" and task is not None:
        day = _move_day(raw.get("day"), task.day, trip)
        if day is None:
            kind = "none"
        action["day"] = day
    elif kind == "add":
        text = raw.get("text")
        action["text"] = (text if isinstance(text, str) and text.strip() else message).strip()[:300]
    elif kind == "theme":
        theme = raw.get("theme")
        if theme not in ("light", "dark", "system"):
            kind = "none"
        action["theme"] = theme
    return {"reply": reply.strip()[:600], "action": None if kind == "none" else {**action, "type": kind}}


def _move_day(said: Any, current: date, trip: TripOut) -> date | None:
    """The trip day a task moves to: the one named, else the day after today, if the trip has one."""
    try:
        day = date.fromisoformat(said) if isinstance(said, str) else None
    except ValueError:
        day = None
    if day is None:
        day = trip.now.astimezone(tz_for(trip.utc_offset)).date() + timedelta(days=1)
    if not trip.start_date <= day <= trip.end_date or day == current:
        return None
    return day
