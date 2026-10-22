"""Why this plan: the choices the planner weighed, priced the way it prices them.

Pure, like the rest of the planner: it reads only a plan's inputs and result. The worker works it out
when it saves a plan and stores it with the plan, so the API only reads it and nothing is planned inside
a request (project brief, section 6).

- Each leg lists every way the travel data offers between its two places, with the one chosen. Unverified
  or stale Raasta routes are listed but marked: the planner never relies on them.
- The day is compared with two others planned from the same inputs: cabs door to door, and no cabs.
"""

from __future__ import annotations

from math import factorial
from typing import Literal

from .models import Frozen, Mode, PlannerInput, PlanResult
from .search import STAY, _build_ctx, plan_day

CAB_ONLY = frozenset({Mode.CAB, Mode.WALK})
NO_CAB = frozenset(m for m in Mode if m is not Mode.CAB)


class LegChoice(Frozen):
    option_id: str
    label: str
    mode: Mode
    travel_min: int
    fare_inr: int
    #: The planner's price of the leg on its own: minutes plus the fare divided by `fare_divisor`.
    cost: float
    chosen: bool
    #: Why the planner wouldn't use it, when it can't (an unverified or stale Raasta route).
    unusable: str | None = None
    rough: bool = False


class LegInsight(Frozen):
    seq: int
    task_id: str | None
    from_place: str
    to_place: str
    choices: tuple[LegChoice, ...]


class DayAlternative(Frozen):
    kind: Literal["chosen", "cab_only", "no_cab"]
    label: str
    feasible: bool
    travel_min: int = 0
    fare_inr: int = 0
    wait_min: int = 0
    #: When the day's last leg arrives, in minutes from midnight.
    ends_at: int | None = None
    #: The tasks this day couldn't keep (moved, skipped or unplaced), by title.
    left_out: tuple[str, ...] = ()
    #: The visit order, by task ID.
    order: tuple[str, ...] = ()
    cost: float | None = None


class PlanInsight(Frozen):
    task_count: int
    #: True when the search tried every order (up to `exact_search_max_tasks` tasks).
    exact: bool
    #: How many visit orders there are for the tasks: all of them were considered when `exact`.
    orders: int
    #: ₹`fare_divisor` counts the same as one minute of travel or waiting.
    fare_divisor: int
    days: tuple[DayAlternative, ...]
    legs: tuple[LegInsight, ...]


def _day(kind: str, label: str, result: PlanResult, titles: dict[str, str]) -> DayAlternative:
    if not result.feasible:
        return DayAlternative(kind=kind, label=label, feasible=False)
    return DayAlternative(
        kind=kind,
        label=label,
        feasible=True,
        travel_min=result.travel_min,
        fare_inr=result.fare_inr,
        wait_min=result.wait_min,
        ends_at=result.legs[-1].arrive_at if result.legs else None,
        left_out=tuple(titles.get(m.task_id, m.title) for m in result.moved),
        order=tuple(leg.task_id for leg in result.legs if leg.task_id is not None),
        cost=result.cost,
    )


def plan_insight(inp: PlannerInput, result: PlanResult) -> PlanInsight:
    rule = inp.rule
    titles = {t.task_id: t.title for t in inp.tasks}

    def with_modes(modes: frozenset[Mode]) -> PlanResult:
        return plan_day(inp.model_copy(update={"objective": inp.objective.model_copy(update={"allowed_modes": modes})}))

    days = (
        _day("chosen", "Your plan", result, titles),
        _day("cab_only", "Cabs door to door", with_modes(CAB_ONLY), titles),
        _day("no_cab", "No cabs", with_modes(NO_CAB), titles),
    )

    ctx = _build_ctx(inp)
    legs: list[LegInsight] = []
    for leg in result.legs:
        if leg.option.option_id.startswith(STAY):
            continue
        pair = (leg.from_place, leg.to_place)
        choices = [
            LegChoice(
                option_id=o.option_id,
                label=o.label,
                mode=o.mode,
                travel_min=o.travel_min,
                fare_inr=o.fare_inr,
                cost=(rule.fare_divisor * rule.weight_travel * o.travel_min + o.fare_inr) / rule.fare_divisor,
                chosen=o.option_id == leg.option.option_id,
                rough=o.rough,
            )
            for o in ctx.options.get(pair, ())
        ]
        choices += [
            LegChoice(
                option_id=o.option_id,
                label=o.label,
                mode=o.mode,
                travel_min=o.travel_min,
                fare_inr=o.fare_inr,
                cost=(rule.fare_divisor * rule.weight_travel * o.travel_min + o.fare_inr) / rule.fare_divisor,
                chosen=False,
                unusable=f"{'Stale' if o.transit_ref and o.transit_ref.status == 'stale' else 'Unverified'} Raasta route: shown, never relied on",
                rough=o.rough,
            )
            for o in ctx.extras.get(pair, ())
        ]
        legs.append(
            LegInsight(
                seq=leg.seq,
                task_id=leg.task_id,
                from_place=leg.from_place,
                to_place=leg.to_place,
                choices=tuple(sorted(choices, key=lambda c: (c.unusable is not None, c.cost, c.option_id))),
            )
        )

    n = len(inp.tasks)
    return PlanInsight(
        task_count=n,
        exact=n <= rule.exact_search_max_tasks,
        orders=factorial(n),
        fare_divisor=rule.fare_divisor,
        days=days,
        legs=tuple(legs),
    )
