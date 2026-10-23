"""What Roo can do. Read tools answer at once. Change tools only add a step to the card the traveller confirms,
and each is checked here as strictly as the API will check it again when it runs; a refusal goes back to the
model in words, so it can fix the step or explain.
"""

from __future__ import annotations

import logging
import re
from dataclasses import asdict, dataclass, field
from datetime import date, datetime
from typing import Any
from zoneinfo import ZoneInfo

from app.clock import tz_for
from app.services.roo_agent.internal import CallFailed, InternalApi

log = logging.getLogger("reroute.roo")

HHMM = re.compile(r"^([01]\d|2[0-3]):[0-5]\d$")
MAX_STEPS = 12
MAX_BOOKINGS = 3
MAX_SPEND_INR = 50_000
#: tripId for the trip create_trip starts on the same card.
NEW_TRIP = "new"
SCREENS = {
    "today": "Today",
    "plan": "your trip's tasks",
    "summary": "the day's summary",
    "why": "why this plan",
    "raasta": "Raasta",
    "me": "Me (settings and wallet)",
    "add_task": "Add a task",
    "book_flight": "flights",
}
_PRIORITY = {1: "must do", 2: "should do", 3: "if there's time"}


class Refused(Exception):
    """A change that can't go on the card, and why."""


@dataclass
class Step:
    step_id: str
    tool: str
    #: "server" changes the trip through the API; "phone" is done by the app.
    kind: str
    label: str
    icon: str
    args: dict[str, Any]
    detail: str | None = None
    cost_inr: int | None = None
    refund_inr: int | None = None
    top_up_inr: int | None = None
    auto: bool = False
    #: The task as it was, for Undo.
    before: dict[str, Any] | None = None

    def view(self) -> dict[str, Any]:
        """The step as the app shows it: no server arguments, only what a phone step needs."""
        out = {k: v for k, v in asdict(self).items() if k not in ("args", "before")}
        return {**out, "args": self.args if self.kind == "phone" else {}}


@dataclass
class Turn:
    api: InternalApi
    trip: dict[str, Any] | None
    trips: list[dict[str, Any]]
    simulated: bool
    steps: list[Step] = field(default_factory=list)
    reads: list[str] = field(default_factory=list)
    places: dict[str, dict[str, Any]] = field(default_factory=dict)
    cities: dict[str, str] = field(default_factory=dict)
    cabs: dict[tuple[str, str], dict[str, Any]] = field(default_factory=dict)
    bookings: list[dict[str, Any]] | None = None
    wallet: int | None = None
    new_trip: dict[str, Any] | None = None
    ask: dict[str, Any] | None = None

    def add(self, tool: str, kind: str, label: str, icon: str, args: dict[str, Any], **extra: Any) -> Step:
        if len(self.steps) >= MAX_STEPS:
            raise Refused(f"One card holds at most {MAX_STEPS} steps, and this one is full.")
        step = Step(step_id=f"s{len(self.steps) + 1}", tool=tool, kind=kind, label=label, icon=icon, args=args, **extra)
        self.steps.append(step)
        return step


# ---------- declarations (Gemini's schema) ----------


def _s(description: str, enum: tuple[str, ...] | None = None) -> dict[str, Any]:
    return {"type": "STRING", "description": description, **({"enum": list(enum)} if enum else {})}


def _i(description: str) -> dict[str, Any]:
    return {"type": "INTEGER", "description": description}


def _fn(name: str, description: str, props: dict[str, Any] | None = None, required: tuple[str, ...] = ()) -> dict[str, Any]:
    out: dict[str, Any] = {"name": name, "description": description}
    if props:
        out["parameters"] = {"type": "OBJECT", "properties": props, "required": list(required)}
    return out


_TASK_ID = _s("A taskId from the day.")
_TRIP_ID = _s('Leave out for the trip on screen; "new" for the trip create_trip starts on this card.')
_DAY = _s("YYYY-MM-DD, a day of the trip. Leave out for today.")

DECLARATIONS = [
    # Reading
    _fn(
        "get_day",
        "The trip's tasks with their ids, today's plan (each leg with the toId of its stop), fixes waiting to be chosen, and what Undo would bring back.",
        {"day": _DAY},
    ),
    _fn(
        "search_places",
        'Find places in a city ("SBI bank", "coffee near MG Road"). Use a placeId from the results; never invent one.',
        {"query": _s("What to look for."), "citySlug": _s("Leave out for the trip's city.")},
        ("query",),
    ),
    _fn("find_city", "Find a city or town in India by name, to start a trip there.", {"query": _s("The city's name.")}, ("query",)),
    _fn("list_trips", "The traveller's trips."),
    _fn(
        "cab_options",
        "Simulated cab, auto and bike rides for one leg of today's plan, with fares.",
        {"toId": _s('The stop the leg goes to: a taskId from the plan, or "end" for the way back to the stay.')},
        ("toId",),
    ),
    _fn("get_wallet", "The simulated wallet: its balance and latest entries."),
    _fn("list_bookings", "The simulated tickets and rides booked on this trip."),
    _fn("get_summary", "How a day went: the tasks, travel time and fares.", {"day": _DAY}),
    _fn("why_this_plan", "Why today's plan is like this: the other orders and ways the planner weighed."),
    # Changing (each adds a step to the card)
    _fn(
        "add_task",
        "Add a task. Find its place with search_places first.",
        {
            "title": _s('Short, in the traveller\'s words ("Lunch with Priya").'),
            "placeId": _s("From search_places."),
            "durationMin": _i("Minutes it takes there, 5 to 720."),
            "day": _DAY,
            "fixedTime": _s("HH:MM when it must start: a meeting, an appointment."),
            "opensAt": _s("HH:MM, the earliest it can start (with closesAt): a shop, an office."),
            "closesAt": _s("HH:MM, when it must be finished."),
            "priority": _i("1 must do, 2 should do (the default), 3 if there's time."),
            "tripId": _TRIP_ID,
        },
        ("title", "placeId", "durationMin"),
    ),
    _fn(
        "change_task",
        "Change a task: when it starts, how long it takes, its day, place, title or priority.",
        {
            "taskId": _TASK_ID,
            "title": _s("A new title."),
            "placeId": _s("A new place, from search_places."),
            "durationMin": _i("A new length in minutes, 5 to 720."),
            "fixedTime": _s("HH:MM: make it start at this time."),
            "anytime": {"type": "BOOLEAN", "description": "true: no fixed time or opening hours any more."},
            "day": _s("YYYY-MM-DD: move it to this day of the trip."),
            "priority": _i("1 must do, 2 should do, 3 if there's time."),
        },
        ("taskId",),
    ),
    _fn("skip_task", "Skip a task today; the later stops move up.", {"taskId": _TASK_ID}, ("taskId",)),
    _fn("remove_task", "Delete a task added by mistake (one already done stays; skip it instead).", {"taskId": _TASK_ID}, ("taskId",)),
    _fn(
        "running_late",
        "Tell Reroute the traveller is running late: the rest of today re-plans (it may offer fixes to choose from). A fixed meeting stays at its time.",
        {"minutes": _i("How late, 5 to 240.")},
        ("minutes",),
    ),
    _fn("mark_done", "Mark a task done: the one the traveller is at, or another.", {"taskId": _s("Leave out for the current task.")}),
    _fn("plan_today", "Plan the day: the order, when to leave and how to get there. For a day that has no plan yet.", {"tripId": _TRIP_ID}),
    _fn(
        "choose_option",
        "Choose one of the fixes waiting after the traveller ran late (from get_day).",
        {"optionId": _s("From get_day's openOptions.")},
        ("optionId",),
    ),
    _fn("undo_last_change", "Bring back the plan from before the last change."),
    _fn(
        "book_cab",
        "Book a simulated cab, auto or bike ride for a leg of today's plan, paid from the wallet.",
        {"toId": _s("The leg's stop, as in cab_options."), "optionId": _s("From cab_options.")},
        ("toId", "optionId"),
    ),
    _fn(
        "cancel_booking",
        "Cancel a simulated booking (from list_bookings). Trains and flights keep a small fee.",
        {"bookingId": _s("From list_bookings.")},
        ("bookingId",),
    ),
    _fn("top_up", "Add simulated money to the wallet.", {"amountInr": _i("Rupees, 100 to 50000.")}, ("amountInr",)),
    _fn(
        "create_trip",
        "Start a new trip. Find the city with find_city, and where they're staying with search_places in that city, first.",
        {
            "citySlug": _s("From find_city."),
            "startDate": _s("YYYY-MM-DD."),
            "endDate": _s("YYYY-MM-DD, at most 14 days after the start."),
            "stayPlaceId": _s("Where they're staying, from search_places in that city."),
            "stayLabel": _s('What they call it ("Hotel near the station").'),
        },
        ("citySlug", "startDate", "endDate", "stayPlaceId", "stayLabel"),
    ),
    # Done by the app itself
    _fn("set_theme", "Light or dark mode.", {"theme": _s("light, dark, or system to follow the phone.", ("light", "dark", "system"))}, ("theme",)),
    _fn("set_voice", "Turn Rico reading its replies aloud on or off.", {"on": {"type": "BOOLEAN", "description": "true to read aloud."}}, ("on",)),
    _fn("tell_them_late", "Draft a message for the people at the next fixed meeting saying when the traveller will arrive; they send it themselves."),
    _fn("open_screen", "Open a screen of the app.", {"screen": _s("Which screen.", tuple(SCREENS))}, ("screen",)),
    _fn(
        "ask_choice",
        "Ask one question with 2 to 4 short answers to tap, when a detail you can't look up is missing. It ends your turn.",
        {"question": _s("The question."), "options": {"type": "ARRAY", "items": {"type": "STRING"}, "description": "2 to 4 short answers."}},
        ("question", "options"),
    ),
]

_NEEDS_TRIP = {
    "get_day", "cab_options", "list_bookings", "get_summary", "why_this_plan", "change_task", "skip_task", "remove_task",
    "running_late", "mark_done", "choose_option", "undo_last_change", "book_cab", "cancel_booking", "tell_them_late",
}  # fmt: skip
_SIMULATED = {"cab_options", "book_cab", "cancel_booking", "list_bookings", "get_wallet", "top_up"}


def declarations(turn: Turn) -> list[dict[str, Any]]:
    """Only the tools that can apply: nothing about a trip without one, no rides without simulated services."""
    hidden = set()
    if not turn.trip:
        hidden |= _NEEDS_TRIP
    if not turn.simulated:
        hidden |= _SIMULATED
    if not (turn.trip and turn.trip.get("openOptions")):
        hidden.add("choose_option")
    return [d for d in DECLARATIONS if d["name"] not in hidden]


# ---------- helpers ----------


def _need_trip(turn: Turn) -> dict[str, Any]:
    if not turn.trip:
        raise Refused("There's no trip on screen. Start one with create_trip.")
    return turn.trip


def _local(iso: str, trip: dict[str, Any]) -> datetime:
    return datetime.fromisoformat(iso).astimezone(tz_for(trip["utcOffset"]))


def _hm(iso: str, trip: dict[str, Any]) -> str:
    return _local(iso, trip).strftime("%H:%M")


def _weekday(day: str) -> str:
    return date.fromisoformat(day).strftime("%A")


def _day_month(day: date) -> str:
    return f"{day.strftime('%a')} {day.day} {day.strftime('%b')}"


def _text(a: dict[str, Any], key: str, most: int) -> str:
    value = a.get(key)
    if not isinstance(value, str) or not value.strip():
        raise Refused(f"Give the {key}.")
    return value.strip()[:most]


def _int(a: dict[str, Any], key: str, low: int, high: int) -> int:
    value = a.get(key)
    if isinstance(value, float) and value.is_integer():
        value = int(value)
    if not isinstance(value, int) or isinstance(value, bool) or not low <= value <= high:
        raise Refused(f"{key} must be a whole number from {low} to {high}.")
    return value


def _hhmm(value: Any, key: str) -> str:
    if not isinstance(value, str) or not HHMM.match(value.strip()):
        raise Refused(f'{key} must be a 24-hour time like "16:30".')
    return value.strip()


def _priority(a: dict[str, Any]) -> int:
    return _int(a, "priority", 1, 3) if a.get("priority") is not None else 2


@dataclass
class _Target:
    """The trip a step changes: the one on screen, or the new one on this card."""

    trip_id: str
    city: str
    start: str
    end: str
    utc_offset: str
    #: Today where the trip is, and the time now, so a time that has passed is refused.
    today: str
    now: str
    default_day: str


def _target(turn: Turn, trip_id: Any) -> _Target:
    if trip_id == NEW_TRIP:
        if not turn.new_trip:
            raise Refused('There\'s no new trip on this card: call create_trip first, then use tripId "new".')
        n = turn.new_trip
        now = datetime.now(ZoneInfo("Asia/Kolkata"))
        return _Target(NEW_TRIP, n["citySlug"], n["startDate"], n["endDate"], "+05:30", now.date().isoformat(), now.strftime("%H:%M"), n["startDate"])
    trip = _need_trip(turn)
    if trip_id and trip_id != trip["tripId"]:
        raise Refused("Rico changes only the trip on screen, or a new trip on this card.")
    now_local = _local(trip["now"], trip)
    return _Target(
        trip["tripId"],
        trip["citySlug"],
        trip["startDate"],
        trip["endDate"],
        trip["utcOffset"],
        now_local.date().isoformat(),
        now_local.strftime("%H:%M"),
        trip["day"],
    )


def _day(value: Any, t: _Target) -> str:
    try:
        day = date.fromisoformat(value) if isinstance(value, str) else None
    except ValueError:
        day = None
    if day is None:
        raise Refused('A day must look like "2026-10-14".')
    if not t.start <= day.isoformat() <= t.end:
        raise Refused(f"That's outside the trip ({t.start} to {t.end}).")
    return day.isoformat()


def _not_past(hm: str, day: str, t: _Target) -> None:
    if day == t.today and hm <= t.now:
        raise Refused(f"{hm} has passed: it's {t.now} now. Choose a later time.")


def _place(turn: Turn, place_id: Any, city: str) -> dict[str, Any]:
    if not isinstance(place_id, str) or not place_id:
        raise Refused("Find the place with search_places and use its placeId.")
    known = turn.places.get(place_id)
    if known is None and turn.trip:
        trip = turn.trip
        mine = [trip["stayPlace"], *(x["place"] for x in trip["tasks"])]
        known = next(({**p, "city": trip["citySlug"]} for p in mine if p["placeId"] == place_id), None)
    if known is None:
        raise Refused(f"{place_id} didn't come from search_places. Search for the place first.")
    if known["city"] != city:
        raise Refused(f"{known['name']} isn't in the trip's city; search in {city}.")
    return known


def _task(turn: Turn, task_id: Any) -> dict[str, Any]:
    trip = _need_trip(turn)
    task = next((x for x in trip["tasks"] if x["taskId"] == task_id), None)
    if task is None:
        raise Refused("Use a taskId from the day (get_day).")
    return task


def _open_task(turn: Turn, task_id: Any) -> dict[str, Any]:
    task = _task(turn, task_id)
    if task["state"] in ("done", "skipped"):
        raise Refused(f"“{task['title']}” is already {task['state']}.")
    return task


def _once(turn: Turn, task: dict[str, Any]) -> None:
    if any(s.args.get("taskId") == task["taskId"] for s in turn.steps):
        raise Refused(f"There's already a step for “{task['title']}” on the card.")


def _today_plan(trip: dict[str, Any]) -> dict[str, Any] | None:
    plan = trip.get("activePlan")
    return plan if plan and plan["day"] == trip["day"] else None


def _stop(trip: dict[str, Any], to_id: Any) -> str:
    plan = _today_plan(trip)
    if plan is None:
        raise Refused("Today has no plan yet, so there's no leg to ride. Plan the day first.")
    for leg in plan["legs"]:
        if (leg["taskId"] or "end") == to_id:
            return next((x["title"] for x in trip["tasks"] if x["taskId"] == leg["taskId"]), trip["stayLabel"])
    raise Refused("That isn't a stop still ahead in today's plan; use a toId from get_day.")


def _ok(step: Step) -> dict[str, Any]:
    return {"ok": True, "step": step.step_id, "onCard": step.label, "note": "On the card only: nothing changes until the traveller taps Do all."}


def _what(b: dict[str, Any]) -> str:
    d = b.get("details") or {}
    if b["kind"] == "flight":
        return f"flight {d.get('flightNo', '')}, {d.get('originCity', '')} to {d.get('destinationCity', '')}"
    if b["kind"] == "train":
        return f"train {d.get('trainNo', '')} to {d.get('destination', '')}"
    return f"{d.get('providerLabel', '')} {str(d.get('vehicleLabel', 'cab')).lower()} ride"


async def _afford(turn: Turn, more: int) -> None:
    """Bookings are paid as they run, so the money must be there by then: top-ups count only if they come first."""
    if turn.wallet is None:
        turn.wallet = (await turn.api.get("/v1/wallet"))["balanceInr"]
    spend = sum(s.cost_inr or 0 for s in turn.steps) + more
    if spend > MAX_SPEND_INR:
        raise Refused(f"That's more than ₹{MAX_SPEND_INR:,} on one card.")
    have = turn.wallet + sum(s.top_up_inr or 0 for s in turn.steps)
    if spend > have:
        need = max(100, -(-(spend - have) // 100) * 100)
        raise Refused(f"The wallet has ₹{have:,} and this needs ₹{spend:,}. Put a top_up of at least ₹{need:,} on the card first, or leave the ride out.")


# ---------- reading ----------


def _brief(task: dict[str, Any], trip: dict[str, Any]) -> dict[str, Any]:
    out = {
        "taskId": task["taskId"],
        "title": task["title"],
        "place": task["place"]["name"],
        "area": task["place"]["area"],
        "day": task["day"],
        "durationMin": task["durationMin"],
        "priority": task["priority"],
        "state": task["state"],
    }
    if task.get("fixedStart"):
        out["fixedTime"] = _hm(task["fixedStart"], trip)
    if task.get("window"):
        out["opensAt"], out["closesAt"] = task["window"]["opensAt"], task["window"]["closesAt"]
    return out


async def get_day(turn: Turn, a: dict[str, Any]) -> dict[str, Any]:
    trip = turn.trip = await turn.api.get(f"/v1/trips/{_need_trip(turn)['tripId']}")
    day = _day(a["day"], _target(turn, None)) if a.get("day") else None
    turn.reads.append("Read your day")
    out: dict[str, Any] = {"today": trip["day"], "now": _hm(trip["now"], trip), "tasks": [_brief(x, trip) for x in trip["tasks"] if not day or x["day"] == day]}
    plan = trip.get("activePlan")
    if plan and (not day or plan["day"] == day):
        names = {x["taskId"]: x["title"] for x in trip["tasks"]}
        out["plan"] = {
            "day": plan["day"],
            "version": plan["version"],
            "legs": [
                {
                    "toId": leg["taskId"] or "end",
                    "to": names.get(leg["taskId"], trip["stayLabel"]),
                    "leaveBy": _hm(leg["leaveBy"], trip),
                    "arriveAt": _hm(leg["arriveAt"], trip),
                    "how": leg["label"],
                    "fareInr": leg["fareInr"],
                }
                for leg in plan["legs"]
            ],
            "fareInr": plan["totals"]["fareInr"],
            "travelMin": plan["totals"]["travelMin"],
        }
    if trip.get("openOptions"):
        out["openOptions"] = [
            {
                "optionId": o["optionId"],
                "label": o["label"],
                "consequence": o["consequence"],
                "extraFareInr": o["extraFareInr"],
                "timeSavedMin": o["timeSavedMin"],
            }
            for o in trip["openOptions"]["options"]
        ]
    undo = next((e for e in trip["log"] if e.get("canUndo")), None)
    if undo:
        out["undo"] = {"what": undo["text"], "bringsBackVersion": undo["previousVersion"]}
    return out


async def search_places(turn: Turn, a: dict[str, Any]) -> dict[str, Any]:
    query = _text(a, "query", 80)
    city = a.get("citySlug") or (turn.new_trip or {}).get("citySlug") or (turn.trip or {}).get("citySlug")
    if not city:
        raise Refused("Say which city: find it with find_city first.")
    rows = await turn.api.get("/v1/places", q=query, city=city)
    turn.reads.append(f"Looked up “{query}”")
    for p in rows[:6]:
        turn.places[p["placeId"]] = {**p, "city": city}
    return {"places": [{"placeId": p["placeId"], "name": p["name"], "area": p["area"]} for p in rows[:6]]}


async def find_city(turn: Turn, a: dict[str, Any]) -> dict[str, Any]:
    query = _text(a, "query", 120)
    rows = await turn.api.get("/v1/cities", q=query)
    turn.reads.append(f"Looked up “{query}”")
    for c in rows[:5]:
        turn.cities[c["slug"]] = c["name"]
    return {"cities": [{"citySlug": c["slug"], "name": c["name"], "state": c.get("state")} for c in rows[:5]]}


async def list_trips(turn: Turn, a: dict[str, Any]) -> dict[str, Any]:
    turn.reads.append("Checked your trips")
    on_screen = (turn.trip or {}).get("tripId")
    return {
        "trips": [
            {"tripId": t["tripId"], "city": t["cityName"], "startDate": t["startDate"], "endDate": t["endDate"], "onScreen": t["tripId"] == on_screen}
            for t in turn.trips
        ]
    }


async def cab_options(turn: Turn, a: dict[str, Any]) -> dict[str, Any]:
    trip = _need_trip(turn)
    to_id = a.get("toId")
    name = _stop(trip, to_id)
    rows = await turn.api.get(f"/v1/trips/{trip['tripId']}/cab-options", toId=to_id)
    turn.reads.append(f"Checked rides to {name}")
    for o in rows:
        turn.cabs[(str(to_id), o["optionId"])] = o
    return {
        "to": name,
        "options": [
            {
                "optionId": o["optionId"],
                "vehicle": o["vehicleLabel"],
                "provider": o["providerLabel"],
                "seats": o["seats"],
                "etaMin": o["etaMin"],
                "fareInr": o["fareInr"],
            }
            for o in rows
        ],
    }


async def get_wallet(turn: Turn, a: dict[str, Any]) -> dict[str, Any]:
    w = await turn.api.get("/v1/wallet")
    turn.wallet = w["balanceInr"]
    turn.reads.append("Checked your wallet")
    return {"balanceInr": w["balanceInr"], "recent": [{"label": e["label"], "amountInr": e["amountInr"]} for e in w["entries"][:5]], "simulated": True}


async def list_bookings(turn: Turn, a: dict[str, Any]) -> dict[str, Any]:
    trip = _need_trip(turn)
    turn.bookings = await turn.api.get(f"/v1/trips/{trip['tripId']}/bookings")
    turn.reads.append("Checked your bookings")
    return {
        "bookings": [
            {"bookingId": b["bookingId"], "what": _what(b), "status": b["status"], "fareInr": b["fareInr"], "reference": b["reference"]} for b in turn.bookings
        ]
    }


async def get_summary(turn: Turn, a: dict[str, Any]) -> dict[str, Any]:
    trip = _need_trip(turn)
    day = _day(a["day"], _target(turn, None)) if a.get("day") else None
    s = await turn.api.get(f"/v1/trips/{trip['tripId']}/summary", day=day)
    turn.reads.append("Read the day's summary")
    tasks = [{"title": x["title"], "state": x["state"], **({"start": _hm(x["start"], trip)} if x.get("start") else {})} for x in s["tasks"]]
    return {
        "day": s["day"],
        "headline": s["headline"],
        "tasks": tasks,
        "travelMin": s["totals"]["travelMin"],
        "fareInr": s["totals"]["fareInr"],
        "reroutes": len(s["reroutes"]),
    }


async def why_this_plan(turn: Turn, a: dict[str, Any]) -> dict[str, Any]:
    trip = _need_trip(turn)
    plan = _today_plan(trip)
    if plan is None:
        raise Refused("Today has no plan yet.")
    insight = await turn.api.get(f"/v1/trips/{trip['tripId']}/plans/{plan['version']}/insight")
    turn.reads.append("Read why the plan is like this")
    days = [
        {"label": d["label"], "feasible": d["feasible"], "travelMin": d["travelMin"], "fareInr": d["fareInr"], "leftOut": d["leftOut"]} for d in insight["days"]
    ]
    legs = [
        {
            "to": leg["toPlace"],
            "chosen": next((c["label"] for c in leg["choices"] if c["chosen"]), ""),
            "others": [c["label"] for c in leg["choices"] if not c["chosen"]][:3],
        }
        for leg in insight["legs"]
    ]
    return {"dayAlternatives": days, "legs": legs}


# ---------- changing (each adds a step to the card) ----------


async def add_task(turn: Turn, a: dict[str, Any]) -> dict[str, Any]:
    t = _target(turn, a.get("tripId"))
    title = _text(a, "title", 120)
    place = _place(turn, a.get("placeId"), t.city)
    minutes = _int(a, "durationMin", 5, 720)
    day = _day(a["day"], t) if a.get("day") else t.default_day
    fixed, window = _timing(a, day, t)
    body = {
        "title": title,
        "placeId": place["placeId"],
        "durationMin": minutes,
        "day": day,
        "priority": _priority(a),
        "hoursUnknown": False,
        "fixedStart": f"{day}T{fixed}:00{t.utc_offset}" if fixed else None,
        "window": {"opensAt": window[0], "closesAt": window[1]} if window else None,
    }
    when = f"at {fixed}" if fixed else f"between {window[0]} and {window[1]}" if window else "any time"
    step = turn.add(
        "add_task",
        "server",
        f"Add “{title}”",
        "add",
        {"tripId": t.trip_id, "day": day, "body": body},
        detail=f"{place['name']}, {_weekday(day)} {when}, {minutes} min",
    )
    return _ok(step)


def _timing(a: dict[str, Any], day: str, t: _Target) -> tuple[str | None, tuple[str, str] | None]:
    opens, closes = a.get("opensAt"), a.get("closesAt")
    if a.get("fixedTime"):
        if opens or closes:
            raise Refused("A task has a fixed time or opening hours, not both.")
        fixed = _hhmm(a["fixedTime"], "fixedTime")
        _not_past(fixed, day, t)
        return fixed, None
    if opens or closes:
        if not (opens and closes):
            raise Refused("Give both opensAt and closesAt, or neither.")
        o, c = _hhmm(opens, "opensAt"), _hhmm(closes, "closesAt")
        if c <= o:
            raise Refused("closesAt must be after opensAt.")
        _not_past(c, day, t)
        return None, (o, c)
    return None, None


async def change_task(turn: Turn, a: dict[str, Any]) -> dict[str, Any]:
    trip = _need_trip(turn)
    task = _open_task(turn, a.get("taskId"))
    _once(turn, task)
    t = _target(turn, None)
    patch: dict[str, Any] = {}
    said: list[str] = []
    if a.get("title"):
        patch["title"] = _text(a, "title", 120)
        said.append(f"renamed “{patch['title']}”")
    if a.get("placeId"):
        place = _place(turn, a["placeId"], t.city)
        patch["placeId"] = place["placeId"]
        said.append(f"at {place['name']}")
    if a.get("durationMin") is not None:
        patch["durationMin"] = _int(a, "durationMin", 5, 720)
        said.append(f"{patch['durationMin']} min")
    day = task["day"]
    if a.get("day"):
        day = _day(a["day"], t)
        if day != task["day"]:
            patch["day"] = day
            said.append(f"on {_weekday(day)}")
    if a.get("fixedTime"):
        hm = _hhmm(a["fixedTime"], "fixedTime")
        _not_past(hm, day, t)
        patch["timing"], patch["fixedStart"] = "fixed", f"{day}T{hm}:00{t.utc_offset}"
        said.append(f"starts at {hm}")
    elif a.get("anytime") is True:
        patch["timing"] = "anytime"
        said.append("any time of day")
    if a.get("priority") is not None:
        patch["priority"] = _priority(a)
        said.append(_PRIORITY[patch["priority"]])
    if not patch:
        raise Refused("Say what to change: a time, a length, a day, a place, a title or a priority.")
    timing: dict[str, Any] = (
        {"timing": "fixed", "fixedStart": task["fixedStart"]}
        if task.get("fixedStart")
        else {"timing": "window", "window": task["window"]}
        if task.get("window")
        else {"timing": "anytime"}
    )
    before = {
        "title": task["title"],
        "placeId": task["placeId"],
        "durationMin": task["durationMin"],
        "priority": task["priority"],
        "day": task["day"],
        **timing,
    }
    detail = "; ".join(said)
    step = turn.add(
        "change_task",
        "server",
        f"Change “{task['title']}”",
        "edit",
        {"tripId": trip["tripId"], "taskId": task["taskId"], "patch": patch},
        detail=detail[:1].upper() + detail[1:],
        before=before,
    )
    return _ok(step)


async def skip_task(turn: Turn, a: dict[str, Any]) -> dict[str, Any]:
    trip = _need_trip(turn)
    task = _open_task(turn, a.get("taskId"))
    _once(turn, task)
    step = turn.add(
        "skip_task", "server", f"Skip “{task['title']}”", "skip", {"tripId": trip["tripId"], "taskId": task["taskId"]}, detail="Your later stops move up."
    )
    return _ok(step)


async def remove_task(turn: Turn, a: dict[str, Any]) -> dict[str, Any]:
    trip = _need_trip(turn)
    task = _task(turn, a.get("taskId"))
    if task["state"] == "done":
        raise Refused(f"“{task['title']}” is done, so it stays in the day's record.")
    _once(turn, task)
    restore = {
        "title": task["title"],
        "placeId": task["placeId"],
        "durationMin": task["durationMin"],
        "day": task["day"],
        "priority": task["priority"],
        "hoursUnknown": task["hoursUnknown"],
        "fixedStart": task.get("fixedStart"),
        "window": task.get("window"),
    }
    step = turn.add("remove_task", "server", f"Remove “{task['title']}”", "remove", {"tripId": trip["tripId"], "taskId": task["taskId"], "restore": restore})
    return _ok(step)


def _ahead(trip: dict[str, Any]) -> list[dict[str, Any]]:
    """Today's open tasks in the plan's order."""
    plan = _today_plan(trip)
    tasks = {x["taskId"]: x for x in trip["tasks"]}
    return [tasks[leg["taskId"]] for leg in (plan or {}).get("legs", []) if leg["taskId"] in tasks and tasks[leg["taskId"]]["state"] not in ("done", "skipped")]


async def running_late(turn: Turn, a: dict[str, Any]) -> dict[str, Any]:
    trip = _need_trip(turn)
    minutes = _int(a, "minutes", 5, 240)
    if _today_plan(trip) is None:
        raise Refused("Today has no plan, so there's nothing to be late for.")
    ahead = _ahead(trip)
    if not ahead:
        raise Refused("Everything in today's plan is done.")
    if any(s.tool == "running_late" for s in turn.steps):
        raise Refused("Running late is already on the card.")
    fixed = next((x for x in ahead if x.get("fixedStart")), None)
    detail = f"The rest of today re-plans; the {fixed['title'].lower()} stays at {_hm(fixed['fixedStart'], trip)}." if fixed else "The rest of today re-plans."
    step = turn.add(
        "running_late",
        "server",
        f"Tell Reroute you're {minutes} min late",
        "late",
        {"tripId": trip["tripId"], "taskId": ahead[0]["taskId"], "minutes": minutes},
        detail=detail,
    )
    return _ok(step)


async def mark_done(turn: Turn, a: dict[str, Any]) -> dict[str, Any]:
    trip = _need_trip(turn)
    if a.get("taskId"):
        task = _open_task(turn, a["taskId"])
    else:
        ahead = _ahead(trip)
        if not ahead:
            raise Refused("Say which task is done.")
        task = ahead[0]
    _once(turn, task)
    step = turn.add("mark_done", "server", f"Mark “{task['title']}” done", "done", {"tripId": trip["tripId"], "taskId": task["taskId"]})
    return _ok(step)


async def plan_today(turn: Turn, a: dict[str, Any]) -> dict[str, Any]:
    t = _target(turn, a.get("tripId"))
    if any(s.tool == "plan_today" and s.args["tripId"] == t.trip_id for s in turn.steps):
        raise Refused("Planning that day is already on the card.")
    adding = any(s.tool == "add_task" and s.args["tripId"] == t.trip_id for s in turn.steps)
    if t.trip_id != NEW_TRIP and not adding:
        trip = _need_trip(turn)
        if not any(x["state"] not in ("done", "skipped") for x in trip["tasks"]):
            raise Refused("There's nothing to plan: add a task first.")
    label = "Plan the first day" if t.trip_id == NEW_TRIP else "Plan today" if t.default_day == t.today else f"Plan {_weekday(t.default_day)}"
    step = turn.add("plan_today", "server", label, "plan", {"tripId": t.trip_id}, detail="The order, when to leave and how to get there.")
    return _ok(step)


async def choose_option(turn: Turn, a: dict[str, Any]) -> dict[str, Any]:
    trip = _need_trip(turn)
    offered = trip.get("openOptions")
    if not offered:
        raise Refused("There are no fixes waiting to choose from.")
    option = next((o for o in offered["options"] if o["optionId"] == a.get("optionId")), None)
    if option is None:
        raise Refused("Use an optionId from get_day's openOptions.")
    if any(s.tool == "choose_option" for s in turn.steps):
        raise Refused("A fix is already chosen on the card.")
    args = {"tripId": trip["tripId"], "optionId": option["optionId"], "optionSetId": offered["optionSetId"]}
    step = turn.add("choose_option", "server", f"Choose “{option['label']}”", "option", args, detail=option["consequence"])
    return _ok(step)


async def undo_last_change(turn: Turn, a: dict[str, Any]) -> dict[str, Any]:
    trip = _need_trip(turn)
    entry = next((e for e in trip["log"] if e.get("canUndo")), None)
    if entry is None or entry.get("previousVersion") is None:
        raise Refused("There's no change to undo.")
    step = turn.add(
        "undo_last_change", "server", "Undo the last change", "undo", {"tripId": trip["tripId"], "version": entry["previousVersion"]}, detail=entry["text"]
    )
    return _ok(step)


async def book_cab(turn: Turn, a: dict[str, Any]) -> dict[str, Any]:
    trip = _need_trip(turn)
    to_id = str(a.get("toId") or "")
    name = _stop(trip, to_id)
    key = (to_id, str(a.get("optionId") or ""))
    if key not in turn.cabs:
        await cab_options(turn, {"toId": to_id})
    option = turn.cabs.get(key)
    if option is None:
        raise Refused("Use an optionId from cab_options for this leg.")
    if any(s.tool == "book_cab" and s.args["toId"] == to_id for s in turn.steps):
        raise Refused("A ride for that leg is already on the card.")
    if sum(1 for s in turn.steps if s.cost_inr) >= MAX_BOOKINGS:
        raise Refused(f"One card books at most {MAX_BOOKINGS} rides.")
    await _afford(turn, option["fareInr"])
    args = {"tripId": trip["tripId"], "toId": to_id, "optionId": option["optionId"]}
    detail = f"{option['providerLabel']}, about {option['etaMin']} min away"
    step = turn.add("book_cab", "server", f"Book a {option['vehicleLabel'].lower()} to {name}", "cab", args, detail=detail, cost_inr=option["fareInr"])
    return _ok(step)


async def cancel_booking(turn: Turn, a: dict[str, Any]) -> dict[str, Any]:
    trip = _need_trip(turn)
    if turn.bookings is None:
        turn.bookings = await turn.api.get(f"/v1/trips/{trip['tripId']}/bookings")
    booking = next((b for b in turn.bookings if b["bookingId"] == a.get("bookingId")), None)
    if booking is None:
        raise Refused("Use a bookingId from list_bookings.")
    if booking["status"] != "confirmed":
        raise Refused("That booking is already cancelled.")
    if any(s.args.get("bookingId") == booking["bookingId"] for s in turn.steps):
        raise Refused("Cancelling it is already on the card.")
    fee = {"train": 60, "flight": 500}.get(booking["kind"], 0) * len((booking.get("details") or {}).get("passengers", []))
    refund = max(0, booking["fareInr"] - fee)
    detail = f"₹{refund:,} back" + (f" (a ₹{fee:,} fee)" if fee else "")
    step = turn.add(
        "cancel_booking",
        "server",
        f"Cancel the {_what(booking)}",
        "cancel",
        {"tripId": trip["tripId"], "bookingId": booking["bookingId"]},
        detail=detail,
        refund_inr=refund,
    )
    return _ok(step)


async def top_up(turn: Turn, a: dict[str, Any]) -> dict[str, Any]:
    amount = _int(a, "amountInr", 100, 50_000)
    step = turn.add("top_up", "server", f"Add ₹{amount:,} to your wallet", "wallet", {"amountInr": amount}, detail="Simulated money", top_up_inr=amount)
    return _ok(step)


async def create_trip(turn: Turn, a: dict[str, Any]) -> dict[str, Any]:
    if turn.new_trip:
        raise Refused("This card already starts a trip.")
    slug = a.get("citySlug")
    name = turn.cities.get(slug) if isinstance(slug, str) else None
    if name is None and turn.trip and slug == turn.trip["citySlug"]:
        name = turn.trip["cityName"]
    if name is None:
        raise Refused("Find the city with find_city first, and use its citySlug.")
    try:
        start, end = date.fromisoformat(str(a.get("startDate"))), date.fromisoformat(str(a.get("endDate")))
    except ValueError as exc:
        raise Refused('Dates must look like "2026-10-14".') from exc
    if start < datetime.now(ZoneInfo("Asia/Kolkata")).date():
        raise Refused("A trip can't start in the past.")
    if end < start or (end - start).days > 13:
        raise Refused("A trip ends on or after its first day, and lasts at most 14 days.")
    place = _place(turn, a.get("stayPlaceId"), slug)
    label = a["stayLabel"].strip()[:200] if isinstance(a.get("stayLabel"), str) and a["stayLabel"].strip() else place["name"]
    turn.new_trip = {
        "citySlug": slug,
        "cityName": name,
        "startDate": start.isoformat(),
        "endDate": end.isoformat(),
        "stayPlaceId": place["placeId"],
        "stayLabel": label,
    }
    step = turn.add(
        "create_trip",
        "server",
        f"Start a trip to {name}",
        "trip",
        {"body": dict(turn.new_trip)},
        detail=f"{_day_month(start)} to {_day_month(end)}, staying at {label}",
    )
    return _ok(step)


# ---------- done by the app ----------


async def set_theme(turn: Turn, a: dict[str, Any]) -> dict[str, Any]:
    theme = a.get("theme")
    labels = {"light": "Switch to light mode", "dark": "Switch to dark mode", "system": "Follow your phone's light or dark mode"}
    if theme not in labels:
        raise Refused("theme is light, dark or system.")
    if any(s.tool == "set_theme" for s in turn.steps):
        raise Refused("The theme is already on the card.")
    return _ok(turn.add("set_theme", "phone", labels[theme], "theme", {"theme": theme}))


async def set_voice(turn: Turn, a: dict[str, Any]) -> dict[str, Any]:
    on = a.get("on")
    if not isinstance(on, bool):
        raise Refused("on is true or false.")
    if any(s.tool == "set_voice" for s in turn.steps):
        raise Refused("Rico's voice is already on the card.")
    return _ok(turn.add("set_voice", "phone", "Read my replies aloud" if on else "Stop reading my replies aloud", "voice", {"on": on}))


async def tell_them_late(turn: Turn, a: dict[str, Any]) -> dict[str, Any]:
    trip = _need_trip(turn)
    meeting = next((x for x in _ahead(trip) if x.get("fixedStart")), None)
    if meeting is None:
        raise Refused("There's no fixed meeting ahead today to tell.")
    if any(s.tool == "tell_them_late" for s in turn.steps):
        raise Refused("The message is already on the card.")
    step = turn.add(
        "tell_them_late",
        "phone",
        f"Write a “running late” note for the {meeting['title'].lower()}",
        "message",
        {"taskId": meeting["taskId"]},
        detail="You send it yourself.",
    )
    return _ok(step)


async def open_screen(turn: Turn, a: dict[str, Any]) -> dict[str, Any]:
    screen = a.get("screen")
    if screen not in SCREENS:
        raise Refused("screen is one of: " + ", ".join(SCREENS) + ".")
    if any(s.tool == "open_screen" for s in turn.steps):
        raise Refused("A screen to open is already on the card.")
    return _ok(turn.add("open_screen", "phone", f"Open {SCREENS[screen]}", "open", {"screen": screen}))


async def ask_choice(turn: Turn, a: dict[str, Any]) -> dict[str, Any]:
    question = _text(a, "question", 200)
    options = [str(o).strip()[:40] for o in (a.get("options") or []) if str(o).strip()]
    if not 2 <= len(options) <= 4:
        raise Refused("Give 2 to 4 short answers.")
    turn.ask = {"question": question, "options": options}
    return {"ok": True, "note": "They'll answer in their next message."}


HANDLERS = {
    f.__name__: f
    for f in (
        get_day, search_places, find_city, list_trips, cab_options, get_wallet, list_bookings, get_summary, why_this_plan,
        add_task, change_task, skip_task, remove_task, running_late, mark_done, plan_today, choose_option, undo_last_change,
        book_cab, cancel_booking, top_up, create_trip, set_theme, set_voice, tell_them_late, open_screen, ask_choice,
    )
}  # fmt: skip


async def call_tool(turn: Turn, name: str, args: dict[str, Any]) -> dict[str, Any]:
    """Run one tool; whatever goes wrong goes back to the model in words."""
    handler = HANDLERS.get(name)
    if handler is None:
        return {"ok": False, "error": f"There's no tool called {name}."}
    try:
        return await handler(turn, args if isinstance(args, dict) else {})
    except Refused as no:
        return {"ok": False, "error": str(no)}
    except CallFailed as failed:
        return {"ok": False, "error": failed.message}
    except (KeyError, TypeError, ValueError):
        log.warning("Roo's %s tool failed", name, exc_info=True)
        return {"ok": False, "error": "That didn't work; try it another way."}
