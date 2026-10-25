"""Going to a fixed task anyway, late. Nobody can move someone else's meeting: when its time can't be kept,
the meeting stays where it is, the traveller gets there as soon as sensibly possible, and the rest of the
day is planned from then."""

from __future__ import annotations

from app.services.planner import Mode, Objective, PairOptions, ReasonCode, ReplanInput, Start, TravelSnapshot, plan_day, replan
from app.services.planner.util import hhmm

from .conftest import grid_snapshot, opt, t
from .test_rules import make, task

#: The office is an hour away by metro (₹40) and 35 minutes by cab (₹400).
FAR = grid_snapshot(["home", "office"], minutes=60, fare=40, cab_minutes=35, cab_fare=400)
AT_945 = Start(place_id="home", ready_at=t(9, 45))


def meeting(**kw):
    return task("meeting", "office", duration=60, fixed=t(10), **kw)


def test_a_meeting_you_go_to_anyway_starts_when_you_get_there():
    assert not plan_day(make([meeting()], FAR, start=AT_945)).feasible
    plan = plan_day(make([meeting(late_ok=True)], FAR, start=AT_945))
    assert plan.feasible
    leg = plan.legs[0]
    # Leave at once, by cab: each minute late weighs ₹50, and the cab saves 25 of them for ₹360 more.
    times = (hhmm(leg.leave_by), hhmm(leg.arrive_at), hhmm(leg.task_start), hhmm(leg.task_end))
    assert leg.option.mode.value == "cab" and times == ("09:45", "10:20", "10:20", "11:20")


def test_going_anyway_changes_nothing_when_you_can_be_on_time():
    snap = grid_snapshot(["home", "office"], minutes=40)
    on_time = plan_day(make([meeting()], snap))
    anyway = plan_day(make([meeting(late_ok=True)], snap))
    assert [(leg.leave_by, leg.arrive_at, leg.task_start) for leg in anyway.legs] == [(leg.leave_by, leg.arrive_at, leg.task_start) for leg in on_time.legs]
    assert hhmm(anyway.legs[0].arrive_at) == "09:50"  # still 10 minutes early


def test_arriving_after_it_would_have_ended_is_missing_it():
    plan = plan_day(make([meeting(late_ok=True)], FAR, start=Start(place_id="home", ready_at=t(10, 30))))
    assert not plan.feasible
    assert plan.blocked.reason == "The meeting ends at 11:00; the earliest arrival is 11:05"


def _pairs(minutes: dict[tuple[str, str], tuple[int, int | None]]) -> TravelSnapshot:
    """Metro (and cab) minutes each way between the places named."""
    pairs = []
    for (a, b), (metro, cab) in minutes.items():
        for x, y in ((a, b), (b, a)):
            options = [opt(f"{x}-{y}-metro", metro, 40)] + ([opt(f"{x}-{y}-cab", cab, 400, Mode.CAB)] if cab else [])
            pairs.append(PairOptions(from_place=x, to_place=y, options=tuple(options)))
    return TravelSnapshot(snapshot_id="synthetic", pairs=tuple(pairs))


def test_a_first_plan_going_anyway_leaves_an_errand_out_rather_than_make_the_meeting_later():
    # The bank is 5 minutes from home and closes at 10:30, before the meeting ends: it fits only before the meeting,
    # which would get there at 10:45 rather than 10:20. Nobody should wait 25 more minutes for a bank errand.
    snap = _pairs({("home", "office"): (60, 35), ("home", "bank"): (5, None), ("bank", "office"): (60, 35)})
    bank = task("bank", "bank", duration=15, window=(t(9), t(10, 30)))
    first = Objective(allow_unplace=True)
    assert not plan_day(make([meeting(), bank], snap, start=AT_945, objective=first)).feasible
    plan = plan_day(make([meeting(late_ok=True), bank], snap, start=AT_945, objective=first))
    assert plan.feasible
    assert [leg.task_id for leg in plan.legs] == ["meeting", None]
    assert hhmm(plan.legs[0].arrive_at) == "10:20"
    # Named as left out, never dropped silently; and the cost is on the ordinary scale (each minute late ₹50).
    assert [(m.task_id, m.kind) for m in plan.moved] == [("bank", "unplaced")]
    alone = plan_day(make([meeting(late_ok=True)], snap, start=AT_945, objective=first))
    assert plan.cost_scaled == alone.cost_scaled + 10 * 120


def test_a_first_plan_going_anyway_still_fits_an_errand_that_costs_the_meeting_nothing():
    # The bank opens until noon: after the meeting, it costs the meeting nothing, so it stays in.
    snap = _pairs({("home", "office"): (60, 35), ("home", "bank"): (5, None), ("bank", "office"): (60, 35)})
    bank = task("bank", "bank", duration=15, window=(t(9), t(13)))
    plan = plan_day(make([meeting(late_ok=True), bank], snap, start=AT_945, objective=Objective(allow_unplace=True)))
    assert [leg.task_id for leg in plan.legs][:2] == ["meeting", "bank"] and not plan.moved
    assert hhmm(plan.legs[0].arrive_at) == "10:20"


def _late_at_home(start: Start) -> ReplanInput:
    """The traveller is still at home, with a plan that left at 08:50 by metro."""
    return ReplanInput(
        planner=make([meeting()], FAR, start=start),
        active_order=(("meeting", "home-office-metro"), (None, "office-home-metro")),
        active_leave_times=(t(8, 50), t(11, 5)),
        behind_min=55,
        today_task_count=1,
    )


def test_when_nothing_keeps_the_time_go_anyway_is_offered_not_a_dead_end():
    out = replan(_late_at_home(AT_945))
    assert out.result == "options"
    [late] = out.options
    assert (late.option_id, late.kind, late.label) == ("opt-1", "late", "Go anyway, about 20 min late")
    assert late.consequence == "You reach the meeting at about 10:20; it starts at 10:00"
    assert late.explanation == (
        "The meeting stays at 10:00: it isn’t yours to move, so you go anyway. A cab gets you there soonest, for ₹360 more. "
        "The rest of your day is planned from when you get there. Tell them you’re running late."
    )
    assert ReasonCode.FIXED_TASK_AT_RISK in late.reason_codes
    # The meeting itself never moves: it's in the plan, at today's date, after its start.
    assert [leg.task_id for leg in late.plan.legs] == ["meeting", None] and not late.plan.moved


def test_a_cab_that_keeps_the_time_comes_first_and_going_late_by_metro_is_the_other_choice():
    # 08:55: by cab (35 min) you're there at 09:30, on time; by metro at 09:55, inside the 10 minutes.
    out = replan(_late_at_home(Start(place_id="home", ready_at=t(8, 55))))
    kinds = [(o.kind, o.label) for o in out.options]
    assert kinds[0] == ("faster_mode", "Take a cab to the meeting")
    assert kinds[-1] == ("late", "Go anyway")
    assert out.options[-1].consequence == "You reach the meeting at about 09:55; it starts at 10:00"
    assert out.options[-1].explanation.endswith("You’ll walk in just as it starts.")


def test_when_you_would_miss_all_of_it_the_answer_is_to_tell_them_not_to_move_it():
    out = replan(_late_at_home(Start(place_id="home", ready_at=t(10, 40))))
    assert out.result == "no_feasible_plan"
    assert out.explanation == "The meeting starts at 10:00; the earliest arrival is 11:15. Let them know, or change its time if it has moved."
