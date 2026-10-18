"""The decide step of the re-plan loop (project brief, section 10), as a pure function.

Given the active plan's remaining order and where the traveller is now, return one of:
- on_time: nothing changes;
- shifted: same tasks, order and modes with new times; safe to apply without asking;
- options: 2 or 3 feasible options of different kinds, cheapest first; nothing is applied;
- no_feasible_plan: no plan keeps every fixed time; the blocking task is named.

Guardrail: only "shifted" may ever be applied automatically. Options always need a choice.
"""

from __future__ import annotations

from typing import Literal

from pydantic import Field

from . import explain
from .models import Blocked, Frozen, Mode, Objective, PlannerInput, PlanResult, ReasonCode, Window
from .search import plan_day, simulate

ResultKind = Literal["on_time", "shifted", "options", "no_feasible_plan"]
OptionKind = Literal["faster_mode", "move_task", "skip_task"]
_KIND_ORDER = {"faster_mode": 0, "move_task": 1, "skip_task": 2}
_NO_CAB = frozenset(m for m in Mode if m is not Mode.CAB)


class ReplanInput(Frozen):
    planner: PlannerInput
    #: Remaining legs of the active plan, as (taskId or None for the leg home, optionId).
    active_order: tuple[tuple[str | None, str], ...]
    #: The active plan's leave-by times for those legs, to tell "on time" from "shifted".
    active_leave_times: tuple[int, ...]
    behind_min: int = 0
    automatic: bool = False
    #: Every task of the day, including those done, for wording such as "all three tasks".
    today_task_count: int = Field(ge=0)


class ReplanOption(Frozen):
    option_id: str
    kind: OptionKind
    label: str
    consequence: str
    explanation: str
    time_saved_min: int
    extra_fare_inr: int
    moved_tasks: tuple[str, ...]
    skipped_tasks: tuple[str, ...]
    reason_codes: tuple[ReasonCode, ...]
    plan: PlanResult


class ReplanResult(Frozen):
    result: ResultKind
    reason_codes: tuple[ReasonCode, ...]
    explanation: str
    plan: PlanResult | None = None
    options: tuple[ReplanOption, ...] = ()
    blocked: Blocked | None = None


def _relaxed_end(inp: ReplanInput) -> int | None:
    """When the shifted day would end if nothing closed and every route ran: the baseline for time saved."""
    p = inp.planner
    tasks = tuple(
        t.model_copy(
            update={
                "fixed_start": None,
                "window": Window(opens=t.fixed_start if t.fixed_start is not None else (t.window.opens if t.window else 0), closes=48 * 60),
            }
        )
        for t in p.tasks
    )
    pairs = tuple(
        pair.model_copy(update={"options": tuple(o.model_copy(update={"service_first": None, "service_last": None}) for o in pair.options)})
        for pair in p.snapshot.pairs
    )
    relaxed = p.model_copy(update={"tasks": tasks, "snapshot": p.snapshot.model_copy(update={"pairs": pairs})})
    plan, _, _ = simulate(relaxed, inp.active_order)
    return plan.end_time if plan else None


def _active_fare(inp: ReplanInput) -> int:
    fares = {o.option_id: o.fare_inr for pair in inp.planner.snapshot.pairs for o in pair.options}
    return sum(fares.get(opt_id, 0) for _, opt_id in inp.active_order)


def _first_changed_leg(inp: ReplanInput, plan: PlanResult):
    active = dict(inp.active_order)
    for leg in plan.legs:
        if active.get(leg.task_id) != leg.option.option_id:
            return leg
    return None


def _title(inp: ReplanInput, task_id: str | None) -> str | None:
    for t in inp.planner.tasks:
        if t.task_id == task_id:
            return t.title
    return None


def _build_option(inp: ReplanInput, kind: OptionKind, plan: PlanResult, base_fare: int, base_end: int | None) -> ReplanOption:
    extra = max(0, plan.fare_inr - base_fare)
    saved = max(0, base_end - plan.end_time) if base_end is not None and plan.end_time is not None else 0
    moved = [m for m in plan.moved if m.kind == "moved"]
    skipped = [m for m in plan.moved if m.kind == "skipped"]
    codes: set[ReasonCode] = {
        c for c in plan.reason_codes if c in (ReasonCode.RAASTA_VERIFIED, ReasonCode.RAASTA_UNVERIFIED, ReasonCode.HOURS_UNKNOWN, ReasonCode.LAST_TRIP_PASSED)
    }
    if kind == "faster_mode":
        leg = _first_changed_leg(inp, plan)
        uses_cab = any(leg.option.mode is Mode.CAB for leg in plan.legs)
        label = explain.faster_label(_title(inp, leg.task_id) if leg else None, uses_cab)
        consequence = explain.faster_consequence(inp.today_task_count)
        text = explain.faster_explanation(inp.today_task_count, extra, uses_cab)
        if extra > 0:
            codes.add(ReasonCode.FASTER_MODE)
    elif kind == "move_task":
        pairs = [(m.title, m.to_day_start) for m in moved]
        label = "Keep it cheap"
        consequence = explain.moved_consequence(pairs)
        text = explain.moved_explanation(pairs, extra)
        codes.add(ReasonCode.TASK_MOVED_TOMORROW)
    else:
        titles = [m.title for m in skipped]
        label = explain.skipped_label(titles)
        consequence = explain.skipped_consequence(titles)
        text = explain.skipped_explanation(titles, extra)
        codes.add(ReasonCode.TASK_SKIPPED)
    return ReplanOption(
        option_id="",
        kind=kind,
        label=label,
        consequence=consequence,
        explanation=text,
        time_saved_min=saved,
        extra_fare_inr=extra,
        moved_tasks=tuple(m.task_id for m in moved),
        skipped_tasks=tuple(m.task_id for m in skipped),
        reason_codes=tuple(sorted(codes)),
        plan=plan,
    )


def replan(inp: ReplanInput) -> ReplanResult:
    p = inp.planner
    codes: list[ReasonCode] = [ReasonCode.BEHIND_SCHEDULE] if inp.behind_min > 0 else []

    shifted, failure, failed_task = simulate(p, inp.active_order)
    if shifted is not None:
        new_times = tuple(leg.leave_by for leg in shifted.legs)
        if new_times == inp.active_leave_times:
            return ReplanResult(result="on_time", reason_codes=(ReasonCode.ON_TIME,), explanation=explain.on_time(), plan=shifted)
        moved_by = max(0, new_times[0] - inp.active_leave_times[0]) if new_times and inp.active_leave_times else 0
        return ReplanResult(
            result="shifted",
            reason_codes=tuple([*codes, ReasonCode.SHIFT_ONLY]),
            explanation=explain.shifted(moved_by, inp.automatic, inp.behind_min),
            plan=shifted,
        )

    failed = next((t for t in p.tasks if t.task_id == failed_task), None)
    if failure == "fixed":
        codes.append(ReasonCode.FIXED_TASK_AT_RISK)
        at = failed.fixed_start if failed else None
    elif failure == "window":
        codes.append(ReasonCode.WINDOW_CLOSES_SOON)
        at = failed.window.closes if failed and failed.window else None
    elif failure == "service":
        codes.append(ReasonCode.LAST_TRIP_PASSED)
        at = None
    else:
        at = None

    base_fare = _active_fare(inp)
    base_end = _relaxed_end(inp)
    searches: list[tuple[OptionKind, Objective]] = [
        ("faster_mode", Objective()),
        ("move_task", Objective(allowed_modes=_NO_CAB, allow_move=True, min_left_out=1)),
        ("skip_task", Objective(allow_skip=True, min_left_out=1)),
    ]
    options: list[ReplanOption] = []
    seen: set[tuple] = set()
    blocked: Blocked | None = None
    for kind, objective in searches:
        if kind == "skip_task" and not any(t.priority == 3 and t.fixed_start is None for t in p.tasks):
            continue
        if kind == "move_task" and not p.has_next_day:
            continue
        plan = plan_day(p.model_copy(update={"objective": objective}))
        if not plan.feasible:
            if kind == "faster_mode":
                blocked = plan.blocked
            continue
        signature = plan.order() + tuple((m.task_id, m.kind) for m in plan.moved)
        if signature in seen:
            continue
        seen.add(signature)
        options.append(_build_option(inp, kind, plan, base_fare, base_end))

    options.sort(key=lambda o: (o.plan.cost_scaled, _KIND_ORDER[o.kind]))
    options = [o.model_copy(update={"option_id": f"opt-{i}"}) for i, o in enumerate(options[:3], start=1)]

    if not options:
        if blocked is None:
            blocked = plan_day(p).blocked
        return ReplanResult(
            result="no_feasible_plan",
            reason_codes=tuple([*codes, ReasonCode.NO_FEASIBLE_PLAN]),
            explanation=(blocked.reason + ". Move it to another day or change it.") if blocked else "Nothing keeps every fixed time.",
            blocked=blocked,
        )
    return ReplanResult(
        result="options",
        reason_codes=tuple(codes),
        explanation=explain.must_choose(failure, failed.title if failed else None, at),
        options=tuple(options),
    )
