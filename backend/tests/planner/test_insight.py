"""Why this plan: the choices the planner weighed, from the golden demo day."""

from __future__ import annotations

from math import factorial

from app.services.planner import Mode, plan_day
from app.services.planner.insight import plan_insight


def test_the_days_compared_are_the_plan_then_cabs_then_no_cabs(demo_input):
    result = plan_day(demo_input)
    insight = plan_insight(demo_input, result)
    chosen, cabs, no_cabs = insight.days
    assert [d.kind for d in insight.days] == ["chosen", "cab_only", "no_cab"]
    assert chosen.fare_inr == result.fare_inr and chosen.travel_min == result.travel_min
    assert chosen.ends_at == result.legs[-1].arrive_at
    assert chosen.order == ("task-meet", "task-bank", "task-office")
    # Cabs everywhere cost more than the plan; the plan is the cheapest day overall.
    assert cabs.feasible and cabs.fare_inr > chosen.fare_inr
    assert chosen.cost <= cabs.cost
    assert no_cabs.feasible is True or no_cabs.left_out


def test_each_leg_lists_every_option_with_the_chosen_one_once(demo_input):
    result = plan_day(demo_input)
    insight = plan_insight(demo_input, result)
    assert [leg.task_id for leg in insight.legs] == [leg.task_id for leg in result.legs]
    for leg, planned in zip(insight.legs, result.legs, strict=True):
        chosen = [c for c in leg.choices if c.chosen]
        assert len(chosen) == 1 and chosen[0].option_id == planned.option.option_id
        usable = [c for c in leg.choices if c.unusable is None]
        assert [c.cost for c in usable] == sorted(c.cost for c in usable)
        # Priced like the planner: minutes plus the fare divided by fare_divisor (₹10 is one minute).
        assert all(c.cost == c.travel_min + c.fare_inr / 10 for c in leg.choices)
    assert any(c.mode == Mode.CAB for leg in insight.legs for c in leg.choices)


def test_the_search_was_exact_over_every_order(demo_input):
    insight = plan_insight(demo_input, plan_day(demo_input))
    assert insight.exact is True
    assert insight.orders == factorial(len(demo_input.tasks))
    assert insight.fare_divisor == 10
