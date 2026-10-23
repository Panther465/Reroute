"""API contracts (section 8). JSON is camelCase; times are ISO 8601 with the city's offset;
money is whole rupees; durations are whole minutes. shared/contracts/ holds the generated JSON Schema.
"""

from __future__ import annotations

from datetime import date, datetime
from typing import Annotated, Generic, Literal, TypeVar

from pydantic import BaseModel, ConfigDict, Field, StringConstraints, model_validator
from pydantic.alias_generators import to_camel

Hhmm = Annotated[str, StringConstraints(pattern=r"^([01]\d|2[0-3]):[0-5]\d$")]
IdempotencyKey = Annotated[str, StringConstraints(min_length=4, max_length=128, pattern=r"^[A-Za-z0-9._:-]+$")]
Mode = Literal["walk", "metro", "shared_auto", "e_rickshaw", "tempo", "cab"]
T = TypeVar("T")
ReasonCode = Literal[
    "ON_TIME",
    "BEHIND_SCHEDULE",
    "SHIFT_ONLY",
    "FIXED_TASK_AT_RISK",
    "WINDOW_CLOSES_SOON",
    "FASTER_MODE",
    "TASK_MOVED_TOMORROW",
    "TASK_SKIPPED",
    "RAASTA_VERIFIED",
    "RAASTA_UNVERIFIED",
    "LAST_TRIP_PASSED",
    "HOURS_UNKNOWN",
    "NO_FEASIBLE_PLAN",
]


class Api(BaseModel):
    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True, from_attributes=True)


class PostBody(Api):
    """Every POST carries an idempotency key (section 13)."""

    idempotency_key: IdempotencyKey


# ---------- users and auth ----------


class FeaturesOut(Api):
    """What this server has switched on, so the app shows only what works."""

    #: Simulated train tickets, flights and cab rides (SIMULATED_SERVICES).
    bookings: bool
    #: "Describe your day" (AI_HELPER_ENABLED).
    ai_helper: bool
    #: Natural voices for Roo's alerts (TTS_ENABLED); otherwise the phone's own voice.
    voices: bool
    #: The simulated wallet that pays for simulated bookings (SIMULATED_SERVICES, like bookings).
    wallet: bool = False
    #: Roo as an agent: it reads the trip and proposes changes on one card (AI_HELPER_ENABLED with a Gemini key).
    agent: bool = False


class UserOut(Api):
    user_id: str
    email: str
    name: str
    role: Literal["traveller", "moderator", "admin"]
    is_demo: bool = False
    features: FeaturesOut


class TokenOut(Api):
    access_token: str
    token_type: Literal["Bearer"] = "Bearer"
    expires_in: int
    user: UserOut


class GoogleSignIn(Api):
    code: Annotated[str, StringConstraints(min_length=10, max_length=2048)]


class DemoSignIn(Api):
    as_role: Literal["traveller", "moderator"] = Field(default="traveller", alias="as")


Email = Annotated[str, StringConstraints(strip_whitespace=True, to_lower=True, min_length=3, max_length=320, pattern=r"^[^@\s]+@[^@\s]+\.[^@\s]+$")]
Password = Annotated[str, StringConstraints(min_length=8, max_length=128)]


class AuthOptionsOut(Api):
    """How this server lets people in, for the home page to show only what works."""

    #: The demo account (DEMO_LOGIN).
    demo_login: bool
    #: Google sign-in is configured (GOOGLE_CLIENT_ID).
    google: bool


class SignUpIn(Api):
    name: Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=80)]
    email: Email
    password: Password


class LoginIn(Api):
    email: Email
    password: Annotated[str, StringConstraints(min_length=1, max_length=128)]


# ---------- wallet (simulated money) ----------


class WalletEntryOut(Api):
    entry_id: str
    amount_inr: int
    kind: Literal["welcome", "topup", "booking", "refund"]
    label: str
    booking_id: str | None
    created_at: datetime


class WalletOut(Api):
    balance_inr: int
    entries: list[WalletEntryOut]
    #: Always true: simulated money. Nothing real is charged.
    demo: bool = True


class TopUpIn(PostBody):
    amount_inr: int = Field(ge=100, le=50000)


# ---------- places ----------


class CityOut(Api):
    """A city to plan in. Only Bengaluru has sample data (metro, shared autos); elsewhere times are rough estimates."""

    slug: str
    name: str
    state: str | None = None
    sample: bool = False


class PlaceOut(Api):
    place_id: str
    name: str
    area: str
    lng: float
    lat: float
    sample: bool = False


# ---------- trips and tasks ----------


class WindowIn(Api):
    opens_at: Hhmm
    closes_at: Hhmm

    @model_validator(mode="after")
    def _order(self) -> WindowIn:
        if self.closes_at <= self.opens_at:
            raise ValueError("closesAt must be after opensAt")
        return self


class TaskIn(PostBody):
    title: Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=120)]
    place_id: Annotated[str, StringConstraints(min_length=1, max_length=80)]
    duration_min: int = Field(ge=5, le=720)
    fixed_start: datetime | None = None
    window: WindowIn | None = None
    priority: Literal[1, 2, 3] = 2
    hours_unknown: bool = False
    day: date | None = None

    @model_validator(mode="after")
    def _timing(self) -> TaskIn:
        if self.fixed_start is not None and self.window is not None:
            raise ValueError("A task has either fixedStart or a window, not both")
        if self.fixed_start is not None and self.fixed_start.tzinfo is None:
            raise ValueError("fixedStart needs a UTC offset, for example 2026-10-14T10:00:00+05:30")
        if self.hours_unknown and (self.window is not None or self.fixed_start is not None):
            raise ValueError("hoursUnknown is only for tasks without a window or fixed time")
        return self


class TaskPatch(Api):
    title: Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=120)] | None = None
    place_id: str | None = None
    duration_min: int | None = Field(default=None, ge=5, le=720)
    fixed_start: datetime | None = None
    window: WindowIn | None = None
    timing: Literal["fixed", "window", "anytime"] | None = None
    priority: Literal[1, 2, 3] | None = None
    hours_unknown: bool | None = None
    #: Move the task to another day of the trip; a fixed time keeps its clock time.
    day: date | None = None


class WindowOut(Api):
    opens_at: str
    closes_at: str


class TaskOut(Api):
    task_id: str
    trip_id: str
    title: str
    place_id: str
    place: PlaceOut
    duration_min: int
    fixed_start: datetime | None
    window: WindowOut | None
    priority: int
    state: Literal["planned", "in_progress", "done", "skipped", "moved"]
    hours_unknown: bool
    day: date


class TripIn(PostBody):
    city_slug: Annotated[str, StringConstraints(pattern=r"^[a-z][a-z0-9-]{1,39}$")]
    city_name: Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=80)]
    start_date: date
    end_date: date
    stay_place_id: str
    stay_label: Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=200)]

    @model_validator(mode="after")
    def _dates(self) -> TripIn:
        if self.end_date < self.start_date:
            raise ValueError("endDate must be on or after startDate")
        if (self.end_date - self.start_date).days > 13:
            raise ValueError("A trip lasts at most 14 days")
        return self


# ---------- plans ----------


class SegmentOut(Api):
    mode: Mode
    minutes: int


class TransitRefOut(Api):
    kind: Literal["raasta", "metro"]
    ref_id: str
    status: Literal["verified", "unverified", "stale"] | None = None


class LegExtraOut(Api):
    label: str
    mode: Mode
    travel_min: int
    fare_inr: int
    transit_ref: TransitRefOut | None = None
    rough: bool = False


class LegOut(Api):
    seq: int
    task_id: str | None
    mode: Mode
    label: str
    segments: list[SegmentOut]
    from_place_id: str
    to_place_id: str
    leave_by: datetime
    arrive_at: datetime
    task_start: datetime
    task_end: datetime
    travel_min: int
    wait_min: int
    fare_inr: int
    option_id: str
    transit_ref: TransitRefOut | None = None
    extras: list[LegExtraOut] = []
    estimate: bool = True
    #: Worked out from the straight-line distance, because Reroute has no travel data for one of the places.
    rough: bool = False


class TotalsOut(Api):
    travel_min: int
    fare_inr: int
    wait_min: int


class MovedOut(Api):
    task_id: str
    title: str
    kind: Literal["moved", "skipped", "unplaced"]
    to_day_start: datetime | None = None
    reason: str


class LegChoiceOut(Api):
    option_id: str
    label: str
    mode: Mode
    travel_min: int
    fare_inr: int
    #: The planner's price of the leg on its own: minutes plus the fare divided by `fareDivisor`.
    cost: float
    chosen: bool
    #: Why the planner wouldn't use it (an unverified or stale Raasta route).
    unusable: str | None = None
    rough: bool = False


class LegInsightOut(Api):
    seq: int
    task_id: str | None
    from_place: str
    to_place: str
    #: Every way the travel data offers between the two places, cheapest first; one is `chosen`.
    choices: list[LegChoiceOut]


class DayAlternativeOut(Api):
    kind: Literal["chosen", "cab_only", "no_cab"]
    label: str
    feasible: bool
    travel_min: int = 0
    fare_inr: int = 0
    wait_min: int = 0
    #: When the day's last leg arrives.
    ends_at: datetime | None = None
    #: Titles of the tasks this day couldn't keep.
    left_out: list[str] = []
    #: The visit order, by task ID.
    order: list[str] = []
    cost: float | None = None


class PlanInsightOut(Api):
    """Why this plan: worked out when the plan was made, from the plan's own inputs."""

    plan_id: str
    version: int | None
    task_count: int
    #: True when the search tried every visit order; `orders` is how many there are.
    exact: bool
    orders: int
    #: ₹`fareDivisor` counts the same as one minute of travel or waiting.
    fare_divisor: int
    #: Your plan, then cabs door to door, then no cabs, all planned from the same inputs.
    days: list[DayAlternativeOut]
    legs: list[LegInsightOut]


class PlanOut(Api):
    plan_id: str
    trip_id: str
    day: date
    version: int | None
    status: Literal["proposed", "active", "superseded"]
    #: "morning": the scheduler planned the day on its own, early in the local morning.
    trigger: Literal["created", "late", "skipped", "edited", "morning"]
    checkin_id: str | None
    inputs_hash: str
    rule_version: str
    travel_time_snapshot_id: str
    legs: list[LegOut]
    done_legs: list[LegOut] = []
    moved: list[MovedOut] = []
    totals: TotalsOut
    reason_codes: list[ReasonCode]
    explanation: str
    approximate: bool = False
    cost: float
    created_at: datetime


class PathStopOut(Api):
    name: str
    lng: float
    lat: float


class PathStepOut(Api):
    """One instruction. Along roads, OSRM's manoeuvre (`kind`: depart, turn, continue, roundabout, arrive…, with
    its `modifier` and the road's `name`); on a metro or shared ride, `board` and `alight`."""

    kind: str
    modifier: str = ""
    name: str = ""
    #: The exit to take at a roundabout.
    exit: int | None = None
    distance_m: int = 0
    duration_s: int = 0
    #: Where the step starts: an index into its segment's coords.
    at: int = 0
    #: Boarding: the line, where it heads, and how many stops to ride.
    line: str | None = None
    towards: str | None = None
    stops: int | None = None


class PathLineOut(Api):
    name: str
    colour: str


class PathSegmentOut(Api):
    mode: Mode
    #: road: along OpenStreetMap's roads; rail: a metro line station to station; recorded: a Raasta route's GPS
    #: path; approximate: a straight line where nothing better is known (drawn dashed).
    source: Literal["road", "rail", "recorded", "approximate"]
    #: [lng, lat] pairs.
    coords: list[list[float]]
    #: Stations or stands passed, boarding first and getting off last.
    stops: list[PathStopOut] = []
    line: PathLineOut | None = None
    distance_m: int
    #: For the map and the directions only: the plan's own times are the planner's.
    duration_s: int
    steps: list[PathStepOut] = []


class LegPathOut(Api):
    seq: int
    segments: list[PathSegmentOut]
    #: False while part of it waits to be drawn (routing was busy): it's drawn straight until then.
    complete: bool = True


class PlanPathsOut(Api):
    plan_id: str
    version: int | None
    #: False while legs are still being drawn: ask again, or wait for the `paths_ready` live event.
    complete: bool
    legs: list[LegPathOut]


class BlockedOut(Api):
    task_id: str
    title: str
    reason: str


class OptionOut(Api):
    option_id: str
    kind: Literal["faster_mode", "move_task", "skip_task", "late"]
    label: str
    consequence: str
    explanation: str
    time_saved_min: int
    extra_fare_inr: int
    moved_tasks: list[str]
    skipped_tasks: list[str]
    reason_codes: list[ReasonCode]
    plan: PlanOut


class OptionSetOut(Api):
    option_set_id: str
    reason_codes: list[ReasonCode]
    explanation: str
    options: list[OptionOut]


class PlanRequest(PostBody):
    day: date | None = None


class JobAccepted(Api):
    job_id: str
    status: Literal["queued"] = "queued"


class JobOut(Api):
    job_id: str
    status: Literal["queued", "started", "finished", "failed"]
    plan_version: int | None = None
    error: str | None = None


# ---------- check-ins ----------


class CheckinIn(PostBody):
    task_id: str
    kind: Literal["done", "skipped", "delay"]
    delay_min: int | None = Field(default=None, ge=1, le=240)

    @model_validator(mode="after")
    def _delay(self) -> CheckinIn:
        if self.kind == "delay" and self.delay_min is None:
            raise ValueError("delayMin is required for a delay")
        if self.kind != "delay" and self.delay_min is not None:
            raise ValueError("delayMin is only for a delay")
        return self


class CheckinOut(Api):
    checkin_id: str
    plan_id: str | None
    result: Literal["on_time", "shifted", "options", "no_feasible_plan", "recorded", "pending"]
    reason_codes: list[ReasonCode] = []
    explanation: str = ""
    plan: PlanOut | None = None
    options: list[OptionOut] = []
    #: The set `options` belongs to: send it back when accepting one.
    option_set_id: str | None = None
    blocked: BlockedOut | None = None
    job_id: str | None = None


class AcceptIn(PostBody):
    #: The option set the traveller saw. If the 5-minute check replaced it, the API answers 409.
    option_set_id: str | None = None


class ActivateIn(PostBody):
    pass


# ---------- log, trip view ----------


class LogEntryOut(Api):
    log_id: str
    at: datetime
    kind: str
    text: str
    automatic: bool
    plan_id: str | None
    previous_plan_id: str | None
    #: The version Undo restores (POST /v1/trips/:id/plans/:previousVersion/activate).
    previous_version: int | None = None
    reason_codes: list[str]
    undone: bool
    can_undo: bool = False


class TripSummaryOut(Api):
    trip_id: str
    city_slug: str
    city_name: str
    start_date: date
    end_date: date
    stay_label: str
    sample: bool


class TripOut(TripSummaryOut):
    utc_offset: str
    stay_place: PlaceOut
    tasks: list[TaskOut]
    active_plan: PlanOut | None
    open_options: OptionSetOut | None
    log: list[LogEntryOut]
    now: datetime
    #: The demo clock holds still at the time it was set; a real clock keeps running after `now`.
    clock_simulated: bool = False
    day: date
    day_index: int
    day_count: int


class Page(Api, Generic[T]):
    items: list[T]
    next_cursor: str | None = None


# ---------- sharing ----------


class ShareLinkIn(PostBody):
    pass


class ShareLinkOut(Api):
    share_id: str
    trip_id: str
    token: str | None = Field(default=None, description="Shown once, when the link is created.")
    url: str | None = None
    expires_at: datetime
    revoked_at: datetime | None = None


class SharedStopOut(Api):
    title: str
    area: str
    time: datetime
    end: datetime | None
    status: Literal["done", "now", "upcoming", "skipped", "moved"]
    fixed: bool


class SharedLegOut(Api):
    label: str
    mode: Mode
    segments: list[SegmentOut]
    leave_by: datetime
    arrive_at: datetime
    travel_min: int
    status: Literal["done", "active", "upcoming"]


class SharedTripOut(Api):
    traveller_first_name: str
    city_name: str
    utc_offset: str
    day: date
    updated_at: datetime
    now: datetime
    stops: list[SharedStopOut]
    legs: list[SharedLegOut]


# ---------- summary ----------


class SummaryLegOut(Api):
    from_name: str
    to_name: str
    label: str
    mode: Mode
    segments: list[SegmentOut]
    travel_min: int
    fare_inr: int


class SummaryTaskOut(Api):
    task_id: str
    title: str
    area: str
    state: str
    start: datetime | None
    end: datetime | None
    moved_to: datetime | None = None


class SummaryOut(Api):
    trip_id: str
    day: date
    city_name: str
    tasks: list[SummaryTaskOut]
    legs: list[SummaryLegOut]
    totals: TotalsOut
    reroutes: list[datetime]
    headline: str
    slip_text: str


# ---------- calendar and drafts ----------


class CalendarImportIn(PostBody):
    code: Annotated[str, StringConstraints(min_length=10, max_length=2048)]


class AiHelperIn(PostBody):
    text: Annotated[str, StringConstraints(min_length=3, max_length=2000)]


class RooTurnIn(Api):
    role: Literal["user", "roo"]
    text: Annotated[str, StringConstraints(max_length=600)]


class RooIn(PostBody):
    message: Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=500)]
    #: The conversation so far, oldest first; the app sends the last few turns.
    history: Annotated[list[RooTurnIn], Field(max_length=12)] = []


class RooActionOut(Api):
    """A change Rico offers. The app asks the traveller before doing it."""

    type: Literal["late", "done", "left", "skip", "move", "duration", "time", "add", "replan", "undo", "why", "summary", "theme"]
    task_id: str | None = None
    minutes: int | None = None
    time: str | None = None
    day: date | None = None
    text: str | None = None
    theme: Literal["light", "dark", "system"] | None = None


class RooOut(Api):
    reply: str
    action: RooActionOut | None = None


# ---------- Roo, the agent ----------


class RooAgentIn(PostBody):
    message: Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=1000)]
    #: The conversation so far, oldest first; the app sends the last few turns.
    history: Annotated[list[RooTurnIn], Field(max_length=12)] = []
    #: The trip on screen; none before the traveller has one (Roo can start one).
    trip_id: str | None = None


class RooStepOut(Api):
    """One thing Rico will do when the traveller taps Do all."""

    step_id: str
    tool: str
    #: "server" changes the trip; "phone" is done by the app itself (the theme, the voice, a screen, a message).
    kind: Literal["server", "phone"]
    label: str
    detail: str | None = None
    icon: str
    #: What the app needs for a phone step (the theme, the screen).
    args: dict = {}
    #: Simulated money: what it costs, what comes back, what goes in.
    cost_inr: int | None = None
    refund_inr: int | None = None
    top_up_inr: int | None = None
    #: Added by Roo itself, such as planning the day after adding tasks to it.
    auto: bool = False


class RooProposalOut(Api):
    proposal_id: str
    trip_id: str | None
    steps: list[RooStepOut]
    total_cost_inr: int
    #: What Undo can't take back (money added, a new trip).
    final: list[str] = []
    expires_at: datetime


class RooAskOut(Api):
    question: str
    options: list[str]


class RooAgentOut(Api):
    reply: str
    #: What Roo looked at to answer, in words ("Read your day").
    reads: list[str] = []
    #: A question with answers to tap, when a detail is missing.
    ask: RooAskOut | None = None
    #: The changes Roo proposes, all on one card. Nothing has changed yet.
    proposal: RooProposalOut | None = None


class RooStepResultOut(Api):
    step_id: str
    status: Literal["done", "failed", "skipped", "phone"]
    message: str = ""


class RooRunOut(Api):
    proposal_id: str
    state: Literal["done", "partial", "failed", "undone"]
    #: The trip the card changed (a new one, if it started one).
    trip_id: str | None
    steps: list[RooStepResultOut]
    #: Steps the app does itself, in order.
    phone: list[RooStepOut] = []
    summary: str
    can_undo: bool = False


class TrainClassOut(Api):
    code: str
    label: str
    fare_inr: int
    status: Literal["available", "rac", "wl"]
    availability: str


class TrainOptionOut(Api):
    train_no: str
    name: str
    origin: str
    destination: str
    departs: Hhmm
    arrives: Hhmm
    #: 1 when it arrives the next day.
    arrives_next_day: int
    duration_min: int
    classes: list[TrainClassOut]
    #: Sample trains for the demo booking; not a real timetable.
    sample: bool = True


class CabOptionOut(Api):
    option_id: str
    #: Invented, simulated partners: RideNow (cars), AutoGo (autos), ZipBike (bikes).
    provider: Literal["ridenow", "autogo", "zipbike"]
    provider_label: str
    vehicle: Literal["bike", "auto", "mini", "sedan"]
    vehicle_label: str
    seats: int
    eta_min: int
    fare_inr: int


class PassengerIn(Api):
    name: Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=60)]
    age: int = Field(ge=1, le=120)


class FlightFareOut(Api):
    cabin: Literal["economy", "business"]
    label: str
    fare_inr: int
    seats_left: int


class FlightOptionOut(Api):
    flight_no: str
    airline: str
    origin: str
    destination: str
    origin_city: str
    destination_city: str
    date: date
    departs: str
    arrives: str
    arrives_next_day: int
    duration_min: int
    stops: int
    fares: list[FlightFareOut]


class AirportOut(Api):
    code: str
    city: str
    name: str


class BookingIn(PostBody):
    kind: Literal["train", "cab", "flight"]
    #: Train: the task the ticket is for, where to, which train and class, and who travels.
    task_id: str | None = None
    destination: Annotated[str, StringConstraints(strip_whitespace=True, min_length=2, max_length=60)] | None = None
    train_no: str | None = None
    travel_class: Literal["SL", "3A", "2A", "1A", "CC"] | None = None
    passengers: list[PassengerIn] = Field(default_factory=list, max_length=6)
    #: Cab: the stop the leg goes to (a task ID, or "end") and the chosen option.
    to_id: str | None = None
    option_id: str | None = None
    #: Flight: airports (IATA codes), the day, the flight and the cabin (plus passengers above).
    origin: Annotated[str, StringConstraints(pattern=r"^[A-Z]{3}$")] | None = None
    flight_to: Annotated[str, StringConstraints(pattern=r"^[A-Z]{3}$")] | None = None
    flight_date: date | None = None
    flight_no: str | None = None
    cabin: Literal["economy", "business"] | None = None


class BookingOut(Api):
    booking_id: str
    trip_id: str
    kind: Literal["train", "cab", "flight"]
    task_id: str | None
    to_id: str | None
    provider: str
    status: Literal["confirmed", "cancelled"]
    #: The PNR for a train, the ride ID for a cab.
    reference: str
    fare_inr: int
    details: dict
    created_at: datetime
    #: Always true: a simulated booking. Nothing real is booked or charged.
    demo: bool = True


class VoiceOut(Api):
    voice_id: str
    label: str


class SpeechWordOut(Api):
    """One spoken word and when it's said, from the start of the clip."""

    text: str
    offset_ms: int
    duration_ms: int


class SpeechTimedOut(Api):
    """A clip and its word timings together, so Rico's mouth can follow the words."""

    #: The MP3, base64-encoded.
    audio: str
    mime: str = "audio/mpeg"
    duration_ms: int
    words: list[SpeechWordOut]


class RoadPathOut(Api):
    #: [lng, lat] pairs along the roads; just the two ends when `source` is "line".
    coords: list[list[float]]
    distance_m: int
    duration_s: int
    source: Literal["road", "line"]


class TaskDraftOut(Api):
    title: str
    place_text: str
    place_id: str | None = None
    #: The place matched to `place_text`, to show; null when nothing matched and the traveller must choose.
    place: PlaceOut | None = None
    duration_min: int
    fixed_start: datetime | None = None
    window: WindowOut | None = None
    priority: Literal[1, 2, 3] = 2
    source: Literal["calendar", "ai_helper"]


class DemoClockIn(PostBody):
    now: datetime

    @model_validator(mode="after")
    def _tz(self) -> DemoClockIn:
        if self.now.tzinfo is None:
            raise ValueError("now needs a UTC offset")
        return self
