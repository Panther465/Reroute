"""The golden test: project brief, section 16, exactly."""

from __future__ import annotations

from app.services.planner import Mode, ReasonCode, plan_day, replan
from app.services.planner.util import hhmm

from .conftest import replan_input


def timeline(plan) -> list[tuple[str | None, str, str, str]]:
    """(task, leave, task start, task end) per leg, as HH:MM."""
    return [(leg.task_id, hhmm(leg.leave_by), hhmm(leg.task_start), hhmm(leg.task_end)) for leg in plan.legs]


def test_plan_version_1(demo_input):
    plan = plan_day(demo_input)
    assert plan.feasible
    assert timeline(plan) == [
        ("task-meet", "08:50", "10:00", "11:00"),
        ("task-bank", "11:05", "12:25", "14:55"),
        ("task-office", "15:00", "15:40", "16:25"),
        (None, "16:30", "16:50", "16:50"),
    ]
    assert [leg.option.label for leg in plan.legs] == ["Metro, then shared auto", "Metro, then shared auto", "Shared auto", "Metro"]
    office_leg = plan.legs[2]
    assert office_leg.option.transit_ref and office_leg.option.transit_ref.kind == "raasta"
    assert ReasonCode.RAASTA_VERIFIED in plan.reason_codes
    assert plan.moved == ()


def test_15_minute_delay_shifts_only(demo_input):
    result = replan(replan_input(demo_input, 15))
    assert result.result == "shifted"
    assert result.reason_codes == (ReasonCode.BEHIND_SCHEDULE, ReasonCode.SHIFT_ONLY)
    assert result.options == ()
    assert timeline(result.plan) == [
        ("task-bank", "11:20", "12:40", "15:10"),
        ("task-office", "15:15", "15:55", "16:40"),
        (None, "16:45", "17:05", "17:05"),
    ]


def test_40_minute_delay_offers_two_options_in_order(demo_input):
    result = replan(replan_input(demo_input, 40))
    assert result.result == "options"
    assert result.plan is None, "nothing changes until the traveller chooses"
    assert result.reason_codes == (ReasonCode.BEHIND_SCHEDULE, ReasonCode.WINDOW_CLOSES_SOON)
    assert [o.option_id for o in result.options] == ["opt-1", "opt-2"]

    cab, cheap = result.options
    assert cab.label == "Take a cab to the bank"
    assert cab.kind == "faster_mode"
    assert cab.extra_fare_inr == 350
    assert cab.time_saved_min == 30
    assert cab.plan.cost == 159
    assert ReasonCode.FASTER_MODE in cab.reason_codes
    assert cab.plan.legs[0].option.mode is Mode.CAB
    assert timeline(cab.plan) == [
        ("task-bank", "11:45", "12:35", "15:05"),
        ("task-office", "15:10", "15:50", "16:35"),
        (None, "16:40", "17:00", "17:00"),
    ]
    assert cab.explanation == "A cab keeps all three tasks today for ₹350 more."

    assert cheap.label == "Keep it cheap"
    assert cheap.kind == "move_task"
    assert cheap.extra_fare_inr == 0
    assert cheap.plan.cost == 246
    assert cheap.moved_tasks == ("task-office",)
    assert ReasonCode.TASK_MOVED_TOMORROW in cheap.reason_codes
    assert timeline(cheap.plan) == [
        ("task-bank", "11:45", "13:05", "15:35"),
        (None, "15:40", "16:15", "16:15"),
    ]
    assert cheap.plan.moved[0].to_day_start == 10 * 60
    assert cheap.consequence == "The university office moves to tomorrow, 10:00"


def test_metro_then_cab_to_office_keeps_every_task_but_loses_to_opt_1(demo_input):
    """Metro and shared auto to the bank, then a cab to the office: cost 166, so it isn't offered."""
    from app.services.planner import simulate

    r = replan_input(demo_input, 40)
    plan, failure, _ = simulate(
        r.planner,
        [("task-bank", "whitefield-koramangala-transit"), ("task-office", "koramangala-jayanagar-cab"), (None, "jayanagar-hotel-metro")],
    )
    assert failure is None and plan is not None
    assert plan.cost == 166
    result = replan(r)
    assert all(o.plan.cost != 166 for o in result.options)


def test_day_summary_with_opt_1(demo_input):
    v1 = plan_day(demo_input)
    cab = replan(replan_input(demo_input, 40)).options[0]
    fares = [v1.legs[0].option.fare_inr] + [leg.option.fare_inr for leg in cab.plan.legs]
    minutes = [v1.legs[0].option.travel_min] + [leg.option.travel_min for leg in cab.plan.legs]
    assert fares == [70, 430, 30, 30]
    assert sum(fares) == 560
    assert sum(minutes) == 2 * 60 + 50
