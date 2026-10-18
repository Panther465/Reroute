from __future__ import annotations

from datetime import date
from pathlib import Path

import pytest

from app.adapters.snapshot_file import load_snapshot
from app.services.planner import (
    LegOption,
    Mode,
    PairOptions,
    PlannerInput,
    PlanTask,
    ReplanInput,
    Segment,
    Start,
    TransitRef,
    TravelSnapshot,
    Window,
    plan_day,
)

EXAMPLES = Path(__file__).resolve().parents[3] / "examples" / "bengaluru"
HOTEL, WF, KOR, JAY = "hotel-majestic", "whitefield-office", "koramangala-bank", "jayanagar-office"


def t(hh: int, mm: int = 0) -> int:
    return hh * 60 + mm


@pytest.fixture(scope="session")
def snapshot() -> TravelSnapshot:
    return load_snapshot(EXAMPLES / "travel-times.json")


def demo_tasks() -> tuple[PlanTask, ...]:
    return (
        PlanTask(task_id="task-meet", title="Meeting", place_id=WF, duration_min=60, fixed_start=t(10), priority=1, movable=False),
        PlanTask(task_id="task-bank", title="Bank", place_id=KOR, duration_min=150, window=Window(opens=t(10), closes=t(16)), priority=1),
        PlanTask(task_id="task-office", title="University office", place_id=JAY, duration_min=45, window=Window(opens=t(10), closes=t(17)), priority=1),
    )


@pytest.fixture
def demo_input(snapshot: TravelSnapshot) -> PlannerInput:
    return PlannerInput(
        day=date(2026, 10, 14),
        stay_place_id=HOTEL,
        start=Start(place_id=HOTEL, ready_at=t(7), kind="stay"),
        tasks=demo_tasks(),
        snapshot=snapshot,
        has_next_day=True,
    )


def replan_input(base: PlannerInput, delay_min: int, automatic: bool = False) -> ReplanInput:
    """The traveller reports a delay during the meeting (10:55, the demo clock)."""
    v1 = plan_day(base)
    meeting = next(leg for leg in v1.legs if leg.task_id == "task-meet")
    remaining = [leg for leg in v1.legs if leg.seq > meeting.seq]
    tasks = tuple(x for x in base.tasks if x.task_id != "task-meet")
    planner = base.model_copy(update={"tasks": tasks, "start": Start(place_id=WF, ready_at=meeting.task_end + delay_min, kind="after_task")})
    return ReplanInput(
        planner=planner,
        active_order=tuple((leg.task_id, leg.option.option_id) for leg in remaining),
        active_leave_times=tuple(leg.leave_by for leg in remaining),
        behind_min=delay_min,
        automatic=automatic,
        today_task_count=3,
    )


def opt(option_id: str, minutes: int, fare: int, mode: Mode = Mode.METRO, first: int | None = None, last: int | None = None, raasta: str | None = None) -> LegOption:
    ref = TransitRef(kind="raasta", ref_id=option_id, status=raasta) if raasta else None
    return LegOption(
        option_id=option_id,
        mode=mode,
        label=mode.value,
        segments=(Segment(mode=mode, minutes=minutes),),
        travel_min=minutes,
        fare_inr=fare,
        service_first=first,
        service_last=last,
        transit_ref=ref,
    )


def grid_snapshot(places: list[str], minutes: int = 20, fare: int = 30, cab_minutes: int | None = None, cab_fare: int = 300) -> TravelSnapshot:
    """Every pair connected by metro (and optionally cab); handy for synthetic cases."""
    pairs = []
    for a in places:
        for b in places:
            if a == b:
                continue
            options = [opt(f"{a}-{b}-metro", minutes, fare)]
            if cab_minutes is not None:
                options.append(opt(f"{a}-{b}-cab", cab_minutes, cab_fare, Mode.CAB))
            pairs.append(PairOptions(from_place=a, to_place=b, options=tuple(options)))
    return TravelSnapshot(snapshot_id="synthetic", pairs=tuple(pairs))
