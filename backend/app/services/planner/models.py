"""Planner inputs and outputs.

The planner works on one day of a trip. Times are whole minutes from midnight of that day,
in the city's local time; the service layer converts to and from ISO 8601. Money is whole
rupees. Every model here is plain data: the planner reads no clock, network or database.
"""

from __future__ import annotations

from datetime import date
from enum import StrEnum
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, field_serializer


class Mode(StrEnum):
    WALK = "walk"
    METRO = "metro"
    SHARED_AUTO = "shared_auto"
    E_RICKSHAW = "e_rickshaw"
    TEMPO = "tempo"
    CAB = "cab"


class ReasonCode(StrEnum):
    ON_TIME = "ON_TIME"
    BEHIND_SCHEDULE = "BEHIND_SCHEDULE"
    SHIFT_ONLY = "SHIFT_ONLY"
    FIXED_TASK_AT_RISK = "FIXED_TASK_AT_RISK"
    WINDOW_CLOSES_SOON = "WINDOW_CLOSES_SOON"
    FASTER_MODE = "FASTER_MODE"
    TASK_MOVED_TOMORROW = "TASK_MOVED_TOMORROW"
    TASK_SKIPPED = "TASK_SKIPPED"
    RAASTA_VERIFIED = "RAASTA_VERIFIED"
    RAASTA_UNVERIFIED = "RAASTA_UNVERIFIED"
    LAST_TRIP_PASSED = "LAST_TRIP_PASSED"
    HOURS_UNKNOWN = "HOURS_UNKNOWN"
    NO_FEASIBLE_PLAN = "NO_FEASIBLE_PLAN"


class Frozen(BaseModel):
    model_config = ConfigDict(frozen=True, extra="forbid")


class Segment(Frozen):
    mode: Mode
    minutes: int = Field(ge=0)


class TransitRef(Frozen):
    kind: Literal["raasta", "metro"]
    ref_id: str
    status: Literal["verified", "unverified", "stale"] | None = None


class LegOption(Frozen):
    """One way to travel between two places, taken from the travel-time snapshot."""

    option_id: str
    mode: Mode
    label: str
    segments: tuple[Segment, ...]
    travel_min: int = Field(ge=0, description="Includes walking and the expected wait (half the frequency).")
    fare_inr: int = Field(ge=0)
    service_first: int | None = Field(default=None, description="Earliest departure, minutes from midnight.")
    service_last: int | None = Field(default=None, description="Latest departure, minutes from midnight.")
    transit_ref: TransitRef | None = None

    @property
    def is_raasta(self) -> bool:
        return self.transit_ref is not None and self.transit_ref.kind == "raasta"

    @property
    def is_main(self) -> bool:
        """Unverified or stale Raasta routes are never a main option, only a labelled extra."""
        return not self.is_raasta or self.transit_ref.status in (None, "verified")  # type: ignore[union-attr]


class PairOptions(Frozen):
    from_place: str
    to_place: str
    options: tuple[LegOption, ...]


class TravelSnapshot(Frozen):
    snapshot_id: str
    pairs: tuple[PairOptions, ...]

    def lookup(self) -> dict[tuple[str, str], tuple[LegOption, ...]]:
        return {(p.from_place, p.to_place): p.options for p in self.pairs}


class Window(Frozen):
    opens: int
    closes: int


class PlanTask(Frozen):
    task_id: str
    title: str
    place_id: str
    duration_min: int = Field(ge=0, le=720)
    fixed_start: int | None = None
    window: Window | None = None
    priority: Literal[1, 2, 3] = 2
    hours_unknown: bool = False
    #: The task may move to the next trip day. Fixed tasks never move.
    movable: bool = True


class RuleSettings(Frozen):
    """Time rules and cost weights. Saved with every plan as part of its inputs."""

    version: str = "1.0"
    leave_after_task_min: int = 5
    fixed_buffer_min: int = 10
    behind_threshold_min: int = 5
    weight_travel: int = 1
    #: Cost uses fare / fare_divisor. Costs are kept as integers scaled by fare_divisor.
    fare_divisor: int = 10
    weight_wait: int = 1
    weight_moved_task: int = 120
    exact_search_max_tasks: int = 8
    day_earliest_departure: int = 7 * 60
    next_day_default_start: int = 10 * 60


class Start(Frozen):
    """Where the traveller is and when they can leave."""

    place_id: str
    ready_at: int
    #: "stay": at the place of stay, free to leave as late as the first task allows.
    #: "after_task": a task has just ended (or will end at ready_at); leave the usual gap after it.
    kind: Literal["stay", "after_task"] = "stay"


class Objective(Frozen):
    """What a search may change. The re-plan loop builds different objectives for different option kinds.

    A task left out of the day is "moved" (to the next trip day), "skipped" (priority 3 only) or,
    when first planning a day, "unplaced" (named, never dropped silently). Fixed tasks are never left out.
    """

    allowed_modes: frozenset[Mode] | None = None
    allow_move: bool = False
    allow_skip: bool = False
    allow_unplace: bool = False
    must_include: frozenset[str] = frozenset()
    min_left_out: int = 0
    max_left_out: int | None = None

    @field_serializer("allowed_modes", "must_include")
    def _sorted(self, value: frozenset | None) -> list[str] | None:
        # Sets serialise in a random order; sort them so inputsHash is stable across runs.
        return None if value is None else sorted(str(v) for v in value)


class PlannerInput(Frozen):
    rule: RuleSettings = RuleSettings()
    day: date
    utc_offset: str = "+05:30"
    stay_place_id: str
    start: Start
    tasks: tuple[PlanTask, ...]
    snapshot: TravelSnapshot
    has_next_day: bool = False
    objective: Objective = Objective()


class PlannedLeg(Frozen):
    seq: int
    task_id: str | None
    from_place: str
    to_place: str
    option: LegOption
    leave_by: int
    arrive_at: int
    wait_min: int
    #: For a task leg, when the task starts and ends. For the last leg home, both equal arrive_at.
    task_start: int
    task_end: int
    extras: tuple[LegOption, ...] = ()


class MovedTask(Frozen):
    task_id: str
    title: str
    kind: Literal["moved", "skipped", "unplaced"]
    to_day_start: int | None = None
    reason: str


class Blocked(Frozen):
    task_id: str
    title: str
    reason: str


class PlanResult(Frozen):
    feasible: bool
    legs: tuple[PlannedLeg, ...] = ()
    moved: tuple[MovedTask, ...] = ()
    reason_codes: tuple[ReasonCode, ...] = ()
    travel_min: int = 0
    fare_inr: int = 0
    wait_min: int = 0
    #: Cost multiplied by rule.fare_divisor, so it stays an integer.
    cost_scaled: int = 0
    cost_divisor: int = 10
    approximate: bool = False
    blocked: Blocked | None = None
    inputs_hash: str = ""

    @property
    def cost(self) -> float:
        return self.cost_scaled / self.cost_divisor

    @property
    def end_time(self) -> int | None:
        return self.legs[-1].arrive_at if self.legs else None

    def order(self) -> tuple[tuple[str | None, str], ...]:
        """Task order and leg options: what "shift only" must keep."""
        return tuple((leg.task_id, leg.option.option_id) for leg in self.legs)
