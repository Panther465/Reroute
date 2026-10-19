"""Planner rules (project brief, sections 9, 10 and 18)."""

from __future__ import annotations

import itertools
import random
import time
from datetime import date

import pytest

from app.services.planner import (
    Mode,
    Objective,
    PairOptions,
    PlannerInput,
    PlanTask,
    ReasonCode,
    RuleSettings,
    Start,
    TravelSnapshot,
    Window,
    inputs_hash,
    plan_day,
    replan,
    simulate,
)
from app.services.planner.util import hhmm, rupees

from .conftest import HOTEL, JAY, KOR, WF, grid_snapshot, opt, replan_input, t

DAY = date(2026, 10, 14)


def make(tasks, snapshot, start=None, **kw) -> PlannerInput:
    return PlannerInput(day=DAY, stay_place_id="home", start=start or Start(place_id="home", ready_at=t(7)), tasks=tuple(tasks), snapshot=snapshot, **kw)


def task(task_id, place, duration=30, fixed=None, window=None, priority=2, **kw) -> PlanTask:
    return PlanTask(
        task_id=task_id,
        title=task_id.title(),
        place_id=place,
        duration_min=duration,
        fixed_start=fixed,
        window=Window(opens=window[0], closes=window[1]) if window else None,
        priority=priority,
        **kw,
    )


# ---------- fixed times and the 10-minute buffer ----------


def test_fixed_task_leaves_at_latest_time_that_keeps_the_buffer():
    snap = grid_snapshot(["home", "a"], minutes=40)
    plan = plan_day(make([task("a", "a", fixed=t(10))], snap))
    assert hhmm(plan.legs[0].leave_by) == "09:10"
    assert hhmm(plan.legs[0].arrive_at) == "09:50"


def test_fixed_task_arriving_exactly_at_the_buffer_is_feasible():
    snap = grid_snapshot(["home", "a"], minutes=40)
    plan = plan_day(make([task("a", "a", fixed=t(9, 50))], snap, start=Start(place_id="home", ready_at=t(9))))
    assert plan.feasible and hhmm(plan.legs[0].arrive_at) == "09:40"


def test_fixed_task_one_minute_short_of_the_buffer_has_no_feasible_plan():
    snap = grid_snapshot(["home", "a"], minutes=40)
    plan = plan_day(make([task("a", "a", fixed=t(9, 49))], snap, start=Start(place_id="home", ready_at=t(9))))
    assert not plan.feasible
    assert plan.reason_codes == (ReasonCode.NO_FEASIBLE_PLAN,)
    assert plan.blocked and plan.blocked.task_id == "a"
    assert plan.blocked.reason == "The a starts at 09:49; the earliest arrival is 09:40" or "earliest arrival" in plan.blocked.reason


def test_unreachable_fixed_task_is_named_with_its_earliest_arrival():
    snap = grid_snapshot(["home", "a"], minutes=90)
    plan = plan_day(make([task("a", "a", fixed=t(8))], snap))
    assert not plan.feasible
    assert plan.blocked.task_id == "a"
    assert plan.blocked.reason == "The a starts at 08:00; the earliest arrival is 08:30"


def test_fixed_tasks_are_never_left_out_even_when_moves_are_allowed():
    snap = grid_snapshot(["home", "a", "b"], minutes=60)
    tasks = [task("a", "a", fixed=t(9)), task("b", "b", fixed=t(9, 30))]
    plan = plan_day(make(tasks, snap, has_next_day=True, objective=Objective(allow_move=True, allow_skip=True, allow_unplace=True)))
    assert not plan.feasible


# ---------- opening windows ----------


def test_window_task_never_starts_before_it_opens_and_waiting_is_counted():
    snap = grid_snapshot(["home", "a", "b"], minutes=20)
    tasks = [task("a", "a", fixed=t(9), duration=30), task("b", "b", window=(t(11), t(17)))]
    plan = plan_day(make(tasks, snap))
    leg_b = next(leg for leg in plan.legs if leg.task_id == "b")
    assert hhmm(leg_b.task_start) == "11:00"
    assert leg_b.wait_min == 11 * 60 - leg_b.arrive_at
    assert plan.wait_min == leg_b.wait_min


def test_first_leg_from_stay_arrives_at_opening_instead_of_waiting():
    snap = grid_snapshot(["home", "a"], minutes=20)
    plan = plan_day(make([task("a", "a", window=(t(10), t(17)))], snap))
    assert hhmm(plan.legs[0].leave_by) == "09:40"
    assert plan.wait_min == 0


def test_window_task_must_finish_by_closing_time():
    snap = grid_snapshot(["home", "a"], minutes=20)
    plan = plan_day(make([task("a", "a", duration=120, window=(t(10), t(11)))], snap))
    assert not plan.feasible


def test_task_that_cant_fit_is_named_not_dropped_silently(demo_input):
    late_start = demo_input.model_copy(
        update={"start": Start(place_id=WF, ready_at=t(13), kind="after_task"), "tasks": demo_input.tasks[1:], "objective": Objective(allow_unplace=True)}
    )
    plan = plan_day(late_start)
    assert plan.feasible
    unplaced = [m for m in plan.moved if m.kind == "unplaced"]
    assert len(unplaced) == 1
    assert "closes at" in unplaced[0].reason and "earliest" in unplaced[0].reason


def test_leave_five_minutes_after_a_task_ends():
    snap = grid_snapshot(["home", "a", "b"], minutes=15)
    plan = plan_day(make([task("a", "a", fixed=t(9), duration=60), task("b", "b", window=(t(9), t(18)))], snap))
    assert hhmm(plan.legs[1].leave_by) == "10:05"


def test_day_starts_and_ends_at_the_place_of_stay():
    snap = grid_snapshot(["home", "a", "b"])
    plan = plan_day(make([task("a", "a"), task("b", "b")], snap))
    assert plan.legs[0].from_place == "home"
    assert plan.legs[-1].to_place == "home" and plan.legs[-1].task_id is None


# ---------- search: cheapest order, ties, determinism ----------


def _brute_force_best(inp: PlannerInput) -> float | None:
    best = None
    lookup = inp.snapshot.lookup()
    places = ["home"] + [x.place_id for x in inp.tasks]
    for perm in itertools.permutations(inp.tasks):
        seq = [x.place_id for x in perm] + ["home"]
        prev = "home"
        option_lists = []
        for p in seq:
            option_lists.append([o.option_id for o in lookup.get((prev, p), ())])
            prev = p
        for choice in itertools.product(*option_lists):
            order = [(x.task_id, c) for x, c in zip(perm, choice, strict=False)] + [(None, choice[-1])]
            plan, failure, _ = simulate(inp, order)
            if plan is not None and (best is None or plan.cost < best):
                best = plan.cost
    del places
    return best


@pytest.mark.parametrize("seed", range(6))
def test_cheapest_order_matches_brute_force_on_small_cases(seed):
    rng = random.Random(seed)
    places = ["home", "a", "b", "c", "d"]
    pairs = []
    for a in places:
        for b in places:
            if a != b:
                m = rng.randint(10, 60)
                pairs.append(
                    PairOptions(
                        from_place=a,
                        to_place=b,
                        options=(opt(f"{a}{b}m", m, rng.randint(10, 60)), opt(f"{a}{b}c", max(5, m - rng.randint(5, 25)), rng.randint(150, 500), Mode.CAB)),
                    )
                )
    snap = TravelSnapshot(snapshot_id=f"rand-{seed}", pairs=tuple(pairs))
    tasks = [
        task("a", "a", duration=rng.randint(20, 90), fixed=t(10)),
        task("b", "b", duration=rng.randint(20, 90), window=(t(9), t(17))),
        task("c", "c", duration=rng.randint(20, 90), window=(t(11), t(18))),
        task("d", "d", duration=rng.randint(20, 60)),
    ]
    inp = make(tasks, snap)
    plan = plan_day(inp)
    expected = _brute_force_best(inp)
    if expected is None:
        assert not plan.feasible
    else:
        assert plan.feasible and plan.cost == expected


def test_same_input_gives_the_same_plan_and_hash(demo_input):
    a, b = plan_day(demo_input), plan_day(demo_input.model_copy())
    assert a == b
    assert a.inputs_hash == b.inputs_hash == inputs_hash(demo_input)
    assert len(a.inputs_hash) == 64


def test_hash_changes_with_rule_version_and_snapshot(demo_input):
    other_rule = demo_input.model_copy(update={"rule": RuleSettings(version="1.1")})
    other_snap = demo_input.model_copy(update={"snapshot": demo_input.snapshot.model_copy(update={"snapshot_id": "other"})})
    assert len({inputs_hash(demo_input), inputs_hash(other_rule), inputs_hash(other_snap)}) == 3


def test_hash_is_stable_for_set_valued_settings(demo_input):
    modes_a = frozenset([Mode.METRO, Mode.WALK, Mode.SHARED_AUTO])
    modes_b = frozenset([Mode.SHARED_AUTO, Mode.METRO, Mode.WALK])
    a = demo_input.model_copy(update={"objective": Objective(allowed_modes=modes_a)})
    b = demo_input.model_copy(update={"objective": Objective(allowed_modes=modes_b)})
    assert inputs_hash(a) == inputs_hash(b)


def test_task_order_in_the_input_does_not_change_the_plan(demo_input):
    reversed_input = demo_input.model_copy(update={"tasks": tuple(reversed(demo_input.tasks))})
    assert plan_day(demo_input).order() == plan_day(reversed_input).order()


def test_ties_prefer_the_lower_fare():
    # Same cost (10*20 + 100 = 300 vs 10*10 + 200 = 300) but one fare is lower.
    snap = TravelSnapshot(
        snapshot_id="tie",
        pairs=(
            PairOptions(from_place="home", to_place="a", options=(opt("slow-cheap", 20, 100), opt("fast-dear", 10, 200, Mode.CAB))),
            PairOptions(from_place="a", to_place="home", options=(opt("back", 10, 10),)),
        ),
    )
    plan = plan_day(make([task("a", "a")], snap))
    assert plan.legs[0].option.option_id == "slow-cheap"


def test_ties_then_prefer_higher_priority_first():
    snap = grid_snapshot(["home", "a", "b"], minutes=20, fare=30)
    plan = plan_day(make([task("low", "a", priority=3), task("high", "b", priority=1)], snap))
    assert [leg.task_id for leg in plan.legs][:2] == ["high", "low"]


def test_ties_then_prefer_task_id():
    snap = grid_snapshot(["home", "a", "b"], minutes=20, fare=30)
    plan = plan_day(make([task("zeta", "a"), task("alpha", "b")], snap))
    assert [leg.task_id for leg in plan.legs][:2] == ["alpha", "zeta"]


def test_allowed_modes_exclude_cab(demo_input):
    no_cab = frozenset(m for m in Mode if m is not Mode.CAB)
    plan = plan_day(demo_input.model_copy(update={"objective": Objective(allowed_modes=no_cab)}))
    assert all(leg.option.mode is not Mode.CAB for leg in plan.legs)


# ---------- last trips and service hours ----------


def _raasta_snapshot(last: int, status: str = "verified") -> TravelSnapshot:
    return TravelSnapshot(
        snapshot_id="raasta",
        pairs=(
            PairOptions(from_place="home", to_place="a", options=(opt("home-a", 10, 20),)),
            PairOptions(
                from_place="a",
                to_place="b",
                options=(opt("auto-ab", 30, 25, Mode.SHARED_AUTO, first=t(7), last=last, raasta=status), opt("cab-ab", 20, 250, Mode.CAB)),
            ),
            PairOptions(from_place="b", to_place="home", options=(opt("b-home", 10, 20),)),
        ),
    )


def test_shared_auto_is_never_offered_after_its_last_trip():
    tasks = [task("a", "a", fixed=t(12), duration=240), task("b", "b", window=(t(9), t(20)))]
    plan = plan_day(make(tasks, _raasta_snapshot(last=t(15))))
    leg = next(leg for leg in plan.legs if leg.task_id == "b")
    assert leg.option.mode is Mode.CAB
    assert ReasonCode.LAST_TRIP_PASSED in plan.reason_codes


def test_shared_auto_is_used_before_its_last_trip():
    tasks = [task("a", "a", fixed=t(12), duration=60), task("b", "b", window=(t(9), t(20)))]
    plan = plan_day(make(tasks, _raasta_snapshot(last=t(15))))
    leg = next(leg for leg in plan.legs if leg.task_id == "b")
    assert leg.option.option_id == "auto-ab"
    assert ReasonCode.RAASTA_VERIFIED in plan.reason_codes


def test_waiting_for_the_first_trip_counts_as_waiting():
    snap = TravelSnapshot(
        snapshot_id="first",
        pairs=(
            PairOptions(from_place="home", to_place="a", options=(opt("home-a", 10, 20),)),
            PairOptions(from_place="a", to_place="b", options=(opt("auto-ab", 30, 25, Mode.SHARED_AUTO, first=t(9), last=t(21), raasta="verified"),)),
            PairOptions(from_place="b", to_place="home", options=(opt("b-home", 10, 20),)),
        ),
    )
    plan = plan_day(make([task("a", "a", fixed=t(8), duration=20), task("b", "b")], snap))
    leg = next(leg for leg in plan.legs if leg.task_id == "b")
    assert hhmm(leg.leave_by) == "09:00"
    assert leg.wait_min == 9 * 60 - (8 * 60 + 25)


def test_metro_is_never_used_outside_its_service_hours():
    snap = TravelSnapshot(
        snapshot_id="late",
        pairs=(
            PairOptions(from_place="home", to_place="a", options=(opt("m", 20, 30, first=t(5), last=t(23)),)),
            PairOptions(from_place="a", to_place="home", options=(opt("m-back", 20, 30, first=t(5), last=t(23)), opt("cab-back", 25, 300, Mode.CAB))),
        ),
    )
    plan = plan_day(make([task("a", "a", fixed=t(21), duration=150)], snap))
    assert plan.legs[-1].option.option_id == "cab-back"


# ---------- unverified routes ----------


@pytest.mark.parametrize("status", ["unverified", "stale"])
def test_unverified_or_stale_route_is_never_the_only_option(status):
    snap = TravelSnapshot(
        snapshot_id="u",
        pairs=(
            PairOptions(from_place="home", to_place="a", options=(opt("auto", 15, 20, Mode.SHARED_AUTO, raasta=status),)),
            PairOptions(from_place="a", to_place="home", options=(opt("back", 15, 20),)),
        ),
    )
    plan = plan_day(make([task("a", "a")], snap))
    assert not plan.feasible


def test_unverified_route_is_shown_only_as_a_labelled_extra():
    snap = TravelSnapshot(
        snapshot_id="u",
        pairs=(
            PairOptions(from_place="home", to_place="a", options=(opt("auto", 15, 20, Mode.SHARED_AUTO, raasta="unverified"), opt("metro", 25, 30))),
            PairOptions(from_place="a", to_place="home", options=(opt("back", 15, 20),)),
        ),
    )
    plan = plan_day(make([task("a", "a")], snap))
    assert plan.legs[0].option.option_id == "metro"
    assert [x.option_id for x in plan.legs[0].extras] == ["auto"]
    assert ReasonCode.RAASTA_UNVERIFIED in plan.reason_codes


# ---------- unknown hours ----------


def test_unknown_hours_are_planned_as_open_and_flagged():
    snap = grid_snapshot(["home", "a"])
    plan = plan_day(make([task("a", "a", hours_unknown=True)], snap))
    assert plan.feasible
    assert ReasonCode.HOURS_UNKNOWN in plan.reason_codes


# ---------- re-planning ----------


def test_no_delay_is_on_time(demo_input):
    result = replan(replan_input(demo_input, 0))
    assert result.result == "on_time"
    assert result.reason_codes == (ReasonCode.ON_TIME,)


def test_automatic_shift_explains_what_it_did(demo_input):
    result = replan(replan_input(demo_input, 25, automatic=True))
    assert result.result == "shifted"
    assert result.explanation == "You were 25 min behind. Reroute moved your later stops 25 min later."


def test_options_change_nothing_until_chosen(demo_input):
    result = replan(replan_input(demo_input, 40))
    assert result.result == "options" and result.plan is None


def test_options_differ_in_kind_and_come_cheapest_first(demo_input):
    nice = PlanTask(task_id="task-chai", title="Tea with a friend", place_id=KOR, duration_min=30, priority=3, window=Window(opens=t(10), closes=t(18)))
    base = demo_input.model_copy(update={"tasks": (*demo_input.tasks, nice)})
    result = replan(replan_input(base, 40))
    kinds = [o.kind for o in result.options]
    assert len(kinds) == len(set(kinds)) >= 2
    costs = [o.plan.cost for o in result.options]
    assert costs == sorted(costs)
    assert len(result.options) <= 3


def test_no_move_option_without_a_next_trip_day(demo_input):
    r = replan_input(demo_input, 40)
    r = r.model_copy(update={"planner": r.planner.model_copy(update={"has_next_day": False})})
    result = replan(r)
    assert [o.kind for o in result.options] == ["faster_mode"]


def test_moved_task_goes_to_the_next_day_at_opening_time(demo_input):
    cheap = replan(replan_input(demo_input, 40)).options[1]
    assert cheap.plan.moved[0].kind == "moved"
    assert hhmm(cheap.plan.moved[0].to_day_start) == "10:00"


def test_no_feasible_plan_names_the_task(demo_input):
    r = replan_input(demo_input, 40)
    late = r.planner.model_copy(update={"start": Start(place_id=WF, ready_at=t(15, 30), kind="after_task"), "has_next_day": False})
    result = replan(r.model_copy(update={"planner": late}))
    assert result.result == "no_feasible_plan"
    assert ReasonCode.NO_FEASIBLE_PLAN in result.reason_codes
    assert result.blocked is not None and result.blocked.title in {"Bank", "University office"}
    assert "closes at" in result.blocked.reason


def test_last_trip_passing_triggers_options_not_a_silent_change():
    tasks = [task("a", "a", fixed=t(12), duration=60), task("b", "b", window=(t(9), t(20)))]
    inp = make(tasks, _raasta_snapshot(last=t(15)), has_next_day=True)
    v1 = plan_day(inp)
    a_leg = v1.legs[0]
    remaining = v1.legs[1:]
    from app.services.planner import ReplanInput

    r = ReplanInput(
        planner=inp.model_copy(update={"tasks": (tasks[1],), "start": Start(place_id="a", ready_at=a_leg.task_end + 150, kind="after_task")}),
        active_order=tuple((leg.task_id, leg.option.option_id) for leg in remaining),
        active_leave_times=tuple(leg.leave_by for leg in remaining),
        behind_min=150,
        today_task_count=2,
    )
    result = replan(r)
    assert result.result == "options"
    assert ReasonCode.LAST_TRIP_PASSED in result.reason_codes
    assert all(leg.option.option_id != "auto-ab" for o in result.options for leg in o.plan.legs)


# ---------- more than 8 tasks, and speed ----------


def test_more_than_eight_tasks_uses_the_approximate_search():
    places = ["home", *[f"p{i}" for i in range(10)]]
    snap = grid_snapshot(places, minutes=15, fare=20)
    tasks = [task(f"t{i}", f"p{i}", duration=20, window=(t(8), t(22))) for i in range(10)]
    plan = plan_day(make(tasks, snap))
    assert plan.feasible and plan.approximate
    assert len([leg for leg in plan.legs if leg.task_id]) == 10


def test_eight_tasks_plan_in_under_two_seconds():
    places = ["home", *[f"p{i}" for i in range(8)]]
    rng = random.Random(8)
    pairs = []
    for a in places:
        for b in places:
            if a != b:
                m = rng.randint(10, 45)
                pairs.append(PairOptions(from_place=a, to_place=b, options=(opt(f"{a}{b}m", m, 30), opt(f"{a}{b}c", max(5, m - 10), 250, Mode.CAB))))
    snap = TravelSnapshot(snapshot_id="perf", pairs=tuple(pairs))
    tasks = [task(f"t{i}", f"p{i}", duration=25, window=(t(8), t(23))) for i in range(8)]
    began = time.perf_counter()
    plan = plan_day(make(tasks, snap))
    assert plan.feasible and not plan.approximate
    assert time.perf_counter() - began < 2.0


def test_rupee_formatting_uses_indian_grouping():
    assert rupees(560) == "₹560"
    assert rupees(120000) == "₹1,20,000"


def test_demo_places_are_the_brief_places(demo_input):
    assert {HOTEL, WF, KOR, JAY} == {p.from_place for p in demo_input.snapshot.pairs} | {p.to_place for p in demo_input.snapshot.pairs}


@pytest.mark.parametrize("status", ["unverified", "stale"])
def test_never_shifts_onto_a_route_that_is_no_longer_verified(demo_input, status):
    """Raasta stopped confirming the shared auto after the plan was made: the loop must ask, not shift."""
    r = replan_input(demo_input, 15)
    pairs = tuple(
        p.model_copy(
            update={
                "options": tuple(
                    o.model_copy(update={"transit_ref": o.transit_ref.model_copy(update={"status": status})}) if o.is_raasta else o for o in p.options
                )
            }
        )
        for p in r.planner.snapshot.pairs
    )
    planner = r.planner.model_copy(update={"snapshot": r.planner.snapshot.model_copy(update={"pairs": pairs})})
    result = replan(r.model_copy(update={"planner": planner}))
    assert result.result == "options"
    assert ReasonCode.RAASTA_UNVERIFIED in result.reason_codes
    for option in result.options:
        assert all(not leg.option.is_raasta for leg in option.plan.legs)


def test_never_shifts_a_shared_auto_past_its_last_trip(demo_input):
    """A late enough delay pushes the Raasta leg past 21:30: options, never a silent shift."""
    r = replan_input(demo_input, 40)
    pairs = tuple(
        p.model_copy(update={"options": tuple(o.model_copy(update={"service_last": t(15, 0)}) if o.is_raasta else o for o in p.options)})
        for p in r.planner.snapshot.pairs
    )
    planner = r.planner.model_copy(update={"snapshot": r.planner.snapshot.model_copy(update={"pairs": pairs})})
    result = replan(
        r.model_copy(update={"planner": planner, "behind_min": 15}).model_copy(
            update={"planner": planner.model_copy(update={"start": planner.start.model_copy(update={"ready_at": t(11, 15)})})}
        )
    )
    assert result.result != "shifted"
