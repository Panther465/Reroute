"""Stops at the same place: no travel-time source has a leg from a place to itself, so the planner adds one."""

from __future__ import annotations

import itertools
import random
from datetime import date

import pytest

from app.services.planner import Mode, Objective, PairOptions, PlannerInput, PlanTask, Start, TravelSnapshot, Window, plan_day, simulate
from app.services.planner.search import STAY
from app.services.planner.util import hhmm

from .conftest import grid_snapshot, opt, t

DAY = date(2026, 10, 14)


def make(tasks, snapshot, start=None, **kw) -> PlannerInput:
    return PlannerInput(day=DAY, stay_place_id="home", start=start or Start(place_id="home", ready_at=t(7)), tasks=tuple(tasks), snapshot=snapshot, **kw)


def task(task_id, place, duration=30, fixed=None, window=None, priority=2) -> PlanTask:
    return PlanTask(
        task_id=task_id,
        title=task_id.title(),
        place_id=place,
        duration_min=duration,
        fixed_start=fixed,
        window=Window(opens=window[0], closes=window[1]) if window else None,
        priority=priority,
        movable=fixed is None,
    )


def test_a_fixed_checkout_at_the_hotel_is_planned():
    plan = plan_day(make([task("checkout", "home", duration=15, fixed=t(11))], grid_snapshot(["home", "a"])))
    assert plan.feasible
    checkout, home = plan.legs
    assert checkout.task_id == "checkout" and checkout.option.option_id == f"{STAY}:home"
    assert checkout.option.label == "Already there" and checkout.option.travel_min == 0 and checkout.option.fare_inr == 0
    assert checkout.option.mode is Mode.WALK and checkout.option.segments == ()
    assert (hhmm(checkout.leave_by), hhmm(checkout.task_start), hhmm(checkout.task_end)) == ("10:50", "11:00", "11:15")
    assert home.task_id is None and home.from_place == home.to_place == "home"
    assert plan.travel_min == 0 and plan.fare_inr == 0


def test_a_checkout_with_other_tasks_keeps_every_task():
    tasks = [task("checkout", "home", duration=15, fixed=t(11)), task("a", "a", window=(t(9), t(17)))]
    plan = plan_day(make(tasks, grid_snapshot(["home", "a"], minutes=20)))
    assert plan.feasible and plan.moved == ()
    assert {leg.task_id for leg in plan.legs} == {"checkout", "a", None}
    assert plan.legs[-1].to_place == "home"


def test_two_tasks_at_one_place_need_no_travel_between_them():
    tasks = [task("drop", "a", duration=20, window=(t(9), t(17))), task("pick", "a", duration=20, window=(t(9), t(17)))]
    plan = plan_day(make(tasks, grid_snapshot(["home", "a"], minutes=20)))
    assert plan.feasible and plan.moved == ()
    assert [leg.task_id for leg in plan.legs] == ["drop", "pick", None]
    between = plan.legs[1]
    assert between.option.option_id == f"{STAY}:a" and between.option.travel_min == 0
    # Leave 5 minutes after the first task ends, as after any task.
    assert between.leave_by == plan.legs[0].task_end + 5


def test_skipping_the_last_task_at_the_hotel_still_gives_a_plan():
    """Everything is skipped and the traveller never left: the day is just "Already there"."""
    plan = plan_day(make([], grid_snapshot(["home", "a"]), start=Start(place_id="home", ready_at=t(9, 30), kind="stay")))
    assert plan.feasible
    assert [(leg.task_id, leg.option.option_id) for leg in plan.legs] == [(None, f"{STAY}:home")]


def test_the_last_task_skipped_after_returning_to_the_hotel():
    """Back at the hotel after a task there, the only task left is skipped: plan the (empty) way home."""
    start = Start(place_id="home", ready_at=t(13), kind="after_task")
    plan = plan_day(make([], grid_snapshot(["home", "a"]), start=start, objective=Objective(allow_unplace=True)))
    assert plan.feasible and plan.legs[0].option.option_id == f"{STAY}:home"
    assert hhmm(plan.legs[0].leave_by) == "13:05"


def test_staying_put_is_allowed_whatever_modes_are_allowed():
    tasks = [task("drop", "a", duration=20), task("pick", "a", duration=20)]
    snap = grid_snapshot(["home", "a"], minutes=40, cab_minutes=20)
    plan = plan_day(make(tasks, snap, objective=Objective(allowed_modes=frozenset({Mode.CAB}))))
    assert plan.feasible
    assert [leg.option.mode for leg in plan.legs] == [Mode.CAB, Mode.WALK, Mode.CAB]


def test_a_snapshot_leg_from_a_place_to_itself_is_kept():
    own = PairOptions(from_place="a", to_place="a", options=(opt("a-a-walk", 3, 0, Mode.WALK),))
    snap = grid_snapshot(["home", "a"])
    snap = snap.model_copy(update={"pairs": (*snap.pairs, own)})
    plan = plan_day(make([task("drop", "a"), task("pick", "a")], snap))
    assert plan.legs[1].option.option_id == "a-a-walk"


def test_replaying_a_plan_with_a_stay_leg_keeps_it():
    tasks = [task("drop", "a", duration=20), task("pick", "a", duration=20)]
    inp = make(tasks, grid_snapshot(["home", "a"]))
    plan = plan_day(inp)
    again, failure, _ = simulate(inp, plan.order())
    assert failure is None and again is not None and again.order() == plan.order()


# ---------- the exact search is still exact with co-located tasks ----------


def _brute_force_best(inp: PlannerInput) -> int | None:
    lookup = inp.snapshot.lookup()
    best = None
    for perm in itertools.permutations(inp.tasks):
        prev, option_lists = inp.start.place_id, []
        for p in [x.place_id for x in perm] + [inp.stay_place_id]:
            option_lists.append([f"{STAY}:{p}"] if prev == p else [o.option_id for o in lookup.get((prev, p), ())])
            prev = p
        for choice in itertools.product(*option_lists):
            order = [(x.task_id, c) for x, c in zip(perm, choice, strict=False)] + [(None, choice[-1])]
            plan, _, _ = simulate(inp, order)
            if plan is not None and (best is None or plan.cost_scaled < best):
                best = plan.cost_scaled
    return best


@pytest.mark.parametrize("seed", range(8))
def test_exact_search_matches_brute_force_with_co_located_tasks(seed):
    rng = random.Random(seed)
    places = ["home", "a", "b"]
    pairs = []
    for a in places:
        for b in places:
            if a != b:
                m = rng.randint(10, 60)
                options = (opt(f"{a}{b}m", m, rng.randint(10, 60)), opt(f"{a}{b}c", max(5, m - rng.randint(5, 25)), rng.randint(150, 500), Mode.CAB))
                pairs.append(PairOptions(from_place=a, to_place=b, options=options))
    snap = TravelSnapshot(snapshot_id=f"co-{seed}", pairs=tuple(pairs))
    tasks = [
        task("a1", "a", duration=rng.randint(20, 90), fixed=t(10) if seed % 2 else None),
        task("a2", "a", duration=rng.randint(20, 90), window=(t(9), t(17))),
        task("b1", "b", duration=rng.randint(20, 90), window=(t(11), t(18))),
        task("h1", "home", duration=rng.randint(15, 45), window=(t(12), t(20))),
    ]
    start = Start(place_id="a", ready_at=t(8), kind="after_task") if seed % 3 == 0 else Start(place_id="home", ready_at=t(7))
    inp = make(tasks, snap, start=start)
    plan = plan_day(inp)
    expected = _brute_force_best(inp)
    if expected is None:
        assert not plan.feasible
    else:
        assert plan.feasible and plan.cost_scaled == expected
