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


class UserOut(Api):
    user_id: str
    email: str
    name: str
    role: Literal["traveller", "moderator", "admin"]
    is_demo: bool = False


class TokenOut(Api):
    access_token: str
    token_type: Literal["Bearer"] = "Bearer"
    expires_in: int
    user: UserOut


class GoogleSignIn(Api):
    code: Annotated[str, StringConstraints(min_length=10, max_length=2048)]


class DemoSignIn(Api):
    as_role: Literal["traveller", "moderator"] = Field(default="traveller", alias="as")


# ---------- places ----------


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


class PlanOut(Api):
    plan_id: str
    trip_id: str
    day: date
    version: int | None
    status: Literal["proposed", "active", "superseded"]
    trigger: Literal["created", "late", "skipped", "edited"]
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


class BlockedOut(Api):
    task_id: str
    title: str
    reason: str


class OptionOut(Api):
    option_id: str
    kind: Literal["faster_mode", "move_task", "skip_task"]
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


class TaskDraftOut(Api):
    title: str
    place_text: str
    place_id: str | None = None
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
