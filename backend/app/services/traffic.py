"""Usual traffic: how much longer a ride on the roads usually takes at a time of the week, by city. Guidance, not
live data.

Reroute has no live traffic feed. A leg's time comes from the travel-time snapshot (the sample file, OSRM's
empty-road times or rough estimates at 18 km/h), the same at any hour. This adds what anyone who lives in an
Indian city knows: the roads are slowest on weekday mornings (08:30 to 11:00) and evenings (17:30 to 21:00), slow
in between, lighter at the weekend and clear at night. The numbers are assumptions, rounded, to replace with
measured times:
- one figure per city, the extra over the plan's time at the height of a weekday peak (Bengaluru half as long
  again; a city not listed, a fifth);
- the same shape of day everywhere, as a share of that figure;
- Saturday at 60 % of a weekday and Sunday at 40 %, in the same shape.
It knows nothing of rain, festivals, holidays or a match at the stadium. Only rides on the roads slow down (cabs,
autos, buses and bikes): the metro and walking keep their times.

TRAFFIC_SOURCE picks where the guidance comes from: "usual" (this model) or "off" (none). A live provider would be
another source behind leg_delay_min(); none is called today.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

from app.config import get_settings
from app.services.planner.util import to_minutes

#: Every city Reroute plans in is in India.
IST = timezone(timedelta(hours=5, minutes=30))

#: Modes that ride on the roads: the planner's, and the ones still to come (auto, bus, bike).
ROAD_MODES = frozenset({"cab", "auto", "shared_auto", "e_rickshaw", "tempo", "bus", "bike"})

#: The extra over a plan's time at the height of a weekday peak, by city slug: rounded guesses from how these
#: cities are known to move, not measurements.
PEAK_EXTRA: dict[str, float] = {
    "bengaluru": 0.5,
    "mumbai": 0.5,
    "pune": 0.45,
    "kolkata": 0.45,
    "delhi": 0.4,
    "hyderabad": 0.4,
    "chennai": 0.4,
    "ahmedabad": 0.3,
}
#: Anywhere else: smaller cities and towns move better, though not freely at the peaks.
DEFAULT_PEAK_EXTRA = 0.2
#: Towns that run into a big city move like it.
SAME_AS = {
    "gurugram": "delhi",
    "noida": "delhi",
    "greater-noida": "delhi",
    "ghaziabad": "delhi",
    "faridabad": "delhi",
    "navi-mumbai": "mumbai",
    "thane": "mumbai",
    "howrah": "kolkata",
    "secunderabad": "hyderabad",
}

#: A weekday, as a share of the city's peak: (from, until, share), local time. Other hours the roads are clear.
WEEKDAY: tuple[tuple[int, int, float], ...] = tuple(
    (to_minutes(start), to_minutes(end), share)
    for start, end, share in (
        ("07:30", "08:30", 0.5),  # filling up
        ("08:30", "11:00", 1.0),  # the morning peak
        ("11:00", "16:30", 0.3),  # the working day: never quite clear
        ("16:30", "17:30", 0.6),  # filling up again
        ("17:30", "21:00", 1.0),  # the evening peak
        ("21:00", "22:30", 0.3),  # emptying
    )
)
#: Weekends keep the weekday's shape, lighter (Saturday is 5).
WEEKEND = {5: 0.6, 6: 0.4}

#: A delay worth a word to the traveller: this many minutes, or this share of the ride and FLOOR_MIN at least.
WORTH_MIN = 8
WORTH_SHARE = 0.25
FLOOR_MIN = 5


def peak_extra(city: str) -> float:
    return PEAK_EXTRA.get(SAME_AS.get(city, city), DEFAULT_PEAK_EXTRA)


def busyness(depart_at: datetime) -> float:
    """How busy the roads usually are when leaving at `depart_at`, as a share of a weekday peak: 0 when clear, 1 at
    the height of it. A time with an offset is read in India's time; one without is taken as local already."""
    local = depart_at.astimezone(IST) if depart_at.tzinfo else depart_at
    minute = local.hour * 60 + local.minute
    share = next((s for start, end, s in WEEKDAY if start <= minute < end), 0.0)
    return share * WEEKEND.get(local.weekday(), 1.0)


def factor(city: str, mode: str, depart_at: datetime) -> float:
    """How many times its planned time a ride usually takes, leaving at `depart_at`: 1 off the roads or while they're
    clear, 1.5 for a cab in Bengaluru at the height of a weekday peak. Never below 1: a clear road isn't promised."""
    if mode not in ROAD_MODES:
        return 1.0
    return 1 + peak_extra(city) * busyness(depart_at)


def usual_delay_min(city: str, mode: str, depart_at: datetime, base_minutes: int) -> int:
    """The minutes a ride of `base_minutes` by `mode` usually loses to traffic, leaving at `depart_at`."""
    return _whole(base_minutes * (factor(city, mode, depart_at) - 1))


def meaningful(extra_min: int, travel_min: int) -> bool:
    """A delay worth telling the traveller about: 8 minutes or more, or a quarter of the ride and 5 minutes at least."""
    return extra_min >= WORTH_MIN or (extra_min >= FLOOR_MIN and extra_min >= travel_min * WORTH_SHARE)


def is_busy(city: str, mode: str, depart_at: datetime, base_minutes: int) -> bool:
    """The roads are usually busy enough at `depart_at` that a ride of `base_minutes` by `mode` had better leave earlier."""
    return meaningful(usual_delay_min(city, mode, depart_at, base_minutes), base_minutes)


def leg_delay_min(city: str, leg: dict) -> int:
    """The minutes a planned leg is likely to lose to traffic, leaving at its leave-by, from TRAFFIC_SOURCE: "usual"
    is this model, where only the leg's parts on the roads slow down (not its walks or metro rides); "off" is none."""
    if get_settings().traffic_source != "usual":
        return 0
    leave = datetime.fromisoformat(leg["leaveBy"])
    return _whole(sum(s["minutes"] * (factor(city, s["mode"], leave) - 1) for s in leg.get("segments") or ()))


def leave_earlier_min(extra_min: int) -> int:
    """How much earlier to leave for a usual delay, as people say it: to the nearest 5 minutes, 5 at least."""
    return max(5, (extra_min + 2) // 5 * 5)


def _whole(minutes: float) -> int:
    # Half up, once the float noise is gone: 1.15 - 1 isn't quite 0.15.
    return int(round(minutes, 6) + 0.5)
