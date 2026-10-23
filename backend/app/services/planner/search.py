"""The day planner: a pure function from PlannerInput to PlanResult.

Up to `exact_search_max_tasks` tasks (8 by default) the search is exact: a depth-first search over
every task order and every leg option, with branch and bound and a dominance check, so it always
finds the cheapest plan that keeps every rule. Above that it inserts tasks one at a time into
their cheapest feasible position, which is fast but approximate; the result says so.

Cost, lower is better: travel minutes + fare / 10 + waiting minutes + 120 per task left out.
Ties: fewer tasks left out, lower fare, higher priority first, then task IDs, then option IDs.
"""

from __future__ import annotations

from dataclasses import dataclass

from .hashing import inputs_hash
from .models import (
    Blocked,
    LegOption,
    Mode,
    MovedTask,
    PlannedLeg,
    PlannerInput,
    PlanResult,
    PlanTask,
    ReasonCode,
)
from .timing import LegTiming, leg_cost_scaled, time_leg
from .util import hhmm, lower_first

#: Prefix of the "Already there" option: staying put between two stops at the same place.
STAY = "__stay__"


def stay_option(place: str) -> LegOption:
    """No travel-time source has a leg from a place to itself, so the planner adds one: 0 minutes, ₹0."""
    return LegOption(option_id=f"{STAY}:{place}", mode=Mode.WALK, label="Already there", segments=(), travel_min=0, fare_inr=0)


@dataclass(frozen=True, slots=True)
class Step:
    task: PlanTask | None
    from_place: str
    to_place: str
    option: LegOption
    timing: LegTiming


@dataclass(slots=True)
class _Ctx:
    inp: PlannerInput
    tasks: list[PlanTask]
    options: dict[tuple[str, str], tuple[LegOption, ...]]
    extras: dict[tuple[str, str], tuple[LegOption, ...]]


def _build_ctx(inp: PlannerInput) -> _Ctx:
    allowed = inp.objective.allowed_modes
    options: dict[tuple[str, str], tuple[LegOption, ...]] = {}
    extras: dict[tuple[str, str], tuple[LegOption, ...]] = {}
    for (a, b), opts in inp.snapshot.lookup().items():
        main = tuple(sorted((o for o in opts if o.is_main and (allowed is None or o.mode in allowed)), key=lambda o: o.option_id))
        options[(a, b)] = main
        extras[(a, b)] = tuple(sorted((o for o in opts if not o.is_main), key=lambda o: o.option_id))
    # A checkout at the hotel, two tasks at one place, or the way home from a task at the hotel:
    # staying put is always possible, whatever modes the objective allows.
    for place in {inp.start.place_id, inp.stay_place_id, *(t.place_id for t in inp.tasks)}:
        if not options.get((place, place)):
            options[(place, place)] = (stay_option(place),)
    tasks = sorted(inp.tasks, key=lambda t: t.task_id)
    return _Ctx(inp, tasks, options, extras)


# ---------- leaving tasks out ----------


def _left_out_kind(inp: PlannerInput, t: PlanTask) -> str | None:
    if t.fixed_start is not None:
        return None
    o = inp.objective
    if o.allow_move and inp.has_next_day and t.movable:
        return "moved"
    if o.allow_skip and t.priority == 3:
        return "skipped"
    if o.allow_unplace:
        return "unplaced"
    return None


def _left_out_ok(inp: PlannerInput, left: list[PlanTask]) -> bool:
    o = inp.objective
    if any(t.task_id in o.must_include for t in left):
        return False
    if len(left) < o.min_left_out:
        return False
    if o.max_left_out is not None and len(left) > o.max_left_out:
        return False
    return all(_left_out_kind(inp, t) is not None for t in left)


# ---------- exact search ----------


def _exact(ctx: _Ctx) -> list[Step] | None:
    inp, rule, tasks = ctx.inp, ctx.inp.rule, ctx.tasks
    n = len(tasks)
    d = rule.fare_divisor
    moved_scaled = d * rule.weight_moved_task
    best_key: tuple | None = None
    best_path: list[Step] | None = None
    memo: dict[tuple[int, str], list[tuple[int, int]]] = {}
    path: list[Step] = []

    # Admissible lower bound on the rest of the day: each unvisited task costs at least its
    # cheapest incoming leg (or the left-out penalty, if it may be left out), plus the cheapest
    # leg home. Waiting is never negative, so the bound never overestimates. A free leg from a
    # place to itself counts only where it can be taken: into a task when the day starts there or
    # another task is there too, and home when a task is at the place of stay (or, before any
    # task, when the day starts there).
    def cheapest_into(place: str, self_leg: bool) -> int:
        return min(
            (d * rule.weight_travel * o.travel_min + o.fare_inr for (a, b), opts in ctx.options.items() if b == place and (a != b or self_leg) for o in opts),
            default=10**9,
        )

    start_place, stay = inp.start.place_id, inp.stay_place_id
    into = [cheapest_into(x.place_id, x.place_id == start_place or any(y is not x and y.place_id == x.place_id for y in tasks)) for x in tasks]
    floor = [min(into[i], moved_scaled) if _left_out_kind(inp, tasks[i]) is not None else into[i] for i in range(n)]
    task_at_stay = any(x.place_id == stay for x in tasks)
    home = cheapest_into(stay, task_at_stay)
    home_first = cheapest_into(stay, task_at_stay or start_place == stay)
    lower: dict[int, int] = {}

    def lower_bound(mask: int) -> int:
        lb = lower.get(mask)
        if lb is None:
            lb = (home if mask else home_first) + sum(floor[i] for i in range(n) if not mask >> i & 1)
            lower[mask] = lb
        return lb

    # A feasible heuristic plan gives an upper bound before the search starts.
    seed = _insertion(ctx)
    upper = _steps_cost(ctx, seed) if seed is not None else None

    def finish(mask: int, place: str, ready: int, from_stay: bool, cost: int, fare: int) -> None:
        nonlocal best_key, best_path
        left = [tasks[i] for i in range(n) if not mask >> i & 1]
        if not _left_out_ok(inp, left):
            return
        for opt in ctx.options.get((place, inp.stay_place_id), ()):
            timing = time_leg(rule, ready, from_stay, None, opt)
            if not timing.ok:
                continue
            total = cost + leg_cost_scaled(rule, opt, timing) + moved_scaled * len(left)
            visited = [s.task for s in path if s.task is not None]
            key = (
                total,
                len(left),
                fare + opt.fare_inr,
                tuple(t.priority for t in visited),
                tuple(t.task_id for t in visited),
                tuple(s.option.option_id for s in path) + (opt.option_id,),
            )
            if best_key is None or key < best_key:
                best_key = key
                best_path = [*path, Step(None, place, inp.stay_place_id, opt, timing)]

    def dfs(mask: int, place: str, ready: int, from_stay: bool, cost: int, fare: int) -> None:
        limit = best_key[0] if best_key is not None else upper
        if limit is not None and cost + lower_bound(mask) > limit:
            return
        if mask:
            k = (mask, place)
            frontier = memo.setdefault(k, [])
            w = d * rule.weight_wait
            for r0, c0 in frontier:
                if r0 <= ready and c0 + w * (ready - r0) < cost:
                    return
            frontier.append((ready, cost))
        finish(mask, place, ready, from_stay, cost, fare)
        for i in range(n):
            if mask >> i & 1:
                continue
            t = tasks[i]
            for opt in ctx.options.get((place, t.place_id), ()):
                timing = time_leg(rule, ready, from_stay, t, opt)
                if not timing.ok:
                    continue
                path.append(Step(t, place, t.place_id, opt, timing))
                dfs(mask | 1 << i, t.place_id, timing.end, False, cost + leg_cost_scaled(rule, opt, timing), fare + opt.fare_inr)
                path.pop()

    start = inp.start
    dfs(0, start.place_id, start.ready_at, start.kind == "stay", 0, 0)
    return best_path


# ---------- approximate search (more than 8 tasks) ----------


def _order_key(t: PlanTask) -> tuple:
    if t.fixed_start is not None:
        return (0, t.fixed_start, t.task_id)
    if t.window is not None:
        return (1, t.window.closes - t.duration_min, t.task_id)
    return (2, t.priority, t.task_id)


def _simulate_greedy(ctx: _Ctx, order: list[PlanTask]) -> tuple[list[Step], int] | None:
    """Schedule tasks in this order, picking the cheapest feasible option for each leg."""
    inp, rule = ctx.inp, ctx.inp.rule
    place, ready, from_stay = inp.start.place_id, inp.start.ready_at, inp.start.kind == "stay"
    steps: list[Step] = []
    cost = 0
    targets: list[PlanTask | None] = [*order, None]
    for t in targets:
        to = inp.stay_place_id if t is None else t.place_id
        best: tuple[int, str, LegOption, LegTiming] | None = None
        for opt in ctx.options.get((place, to), ()):
            timing = time_leg(rule, ready, from_stay, t, opt)
            if timing.ok:
                c = leg_cost_scaled(rule, opt, timing)
                if best is None or (c, opt.option_id) < (best[0], best[1]):
                    best = (c, opt.option_id, opt, timing)
        if best is None:
            return None
        c, _, opt, timing = best
        steps.append(Step(t, place, to, opt, timing))
        cost += c
        place, ready, from_stay = to, timing.end, False
    return steps, cost


def _insertion(ctx: _Ctx) -> list[Step] | None:
    inp = ctx.inp
    order: list[PlanTask] = []
    left: list[PlanTask] = []
    for t in sorted(ctx.tasks, key=_order_key):
        best: tuple[int, int] | None = None
        for pos in range(len(order) + 1):
            trial = [*order[:pos], t, *order[pos:]]
            sim = _simulate_greedy(ctx, trial)
            if sim is not None and (best is None or sim[1] < best[0]):
                best = (sim[1], pos)
        if best is None:
            left.append(t)
        else:
            order.insert(best[1], t)
    if not _left_out_ok(inp, left):
        return None
    sim = _simulate_greedy(ctx, order)
    return sim[0] if sim else None


# ---------- assembling the result ----------


def _assemble(ctx: _Ctx, steps: list[Step], approximate: bool) -> PlanResult:
    inp, rule = ctx.inp, ctx.inp.rule
    visited = {s.task.task_id for s in steps if s.task is not None}
    legs: list[PlannedLeg] = []
    codes: set[ReasonCode] = set()
    for i, s in enumerate(steps, start=1):
        extras = ctx.extras.get((s.from_place, s.to_place), ())
        legs.append(
            PlannedLeg(
                seq=i,
                task_id=s.task.task_id if s.task else None,
                from_place=s.from_place,
                to_place=s.to_place,
                option=s.option,
                leave_by=s.timing.leave,
                arrive_at=s.timing.arrive,
                wait_min=s.timing.wait,
                task_start=s.timing.start,
                task_end=s.timing.end,
                extras=extras,
            )
        )
        if s.option.is_raasta:
            codes.add(ReasonCode.RAASTA_VERIFIED)
        if extras:
            codes.add(ReasonCode.RAASTA_UNVERIFIED)
        if _raasta_ran_out(ctx, steps, i - 1):
            codes.add(ReasonCode.LAST_TRIP_PASSED)
        if s.task is not None and s.task.hours_unknown:
            codes.add(ReasonCode.HOURS_UNKNOWN)

    moved: list[MovedTask] = []
    for t in ctx.tasks:
        if t.task_id in visited:
            continue
        kind = _left_out_kind(inp, t) or "unplaced"
        if kind == "moved":
            codes.add(ReasonCode.TASK_MOVED_TOMORROW)
            start = t.window.opens if t.window else rule.next_day_default_start
            moved.append(MovedTask(task_id=t.task_id, title=t.title, kind="moved", to_day_start=start, reason="moved to the next trip day"))
        elif kind == "skipped":
            codes.add(ReasonCode.TASK_SKIPPED)
            moved.append(MovedTask(task_id=t.task_id, title=t.title, kind="skipped", reason="skipped, priority 3"))
        else:
            moved.append(MovedTask(task_id=t.task_id, title=t.title, kind="unplaced", reason=_why_not(ctx, t)))

    travel = sum(leg.option.travel_min for leg in legs)
    fare = sum(leg.option.fare_inr for leg in legs)
    wait = sum(leg.wait_min for leg in legs)
    d = rule.fare_divisor
    cost = d * rule.weight_travel * travel + fare + d * rule.weight_wait * wait + d * rule.weight_moved_task * len(moved)
    return PlanResult(
        feasible=True,
        legs=tuple(legs),
        moved=tuple(moved),
        reason_codes=tuple(sorted(codes)),
        travel_min=travel,
        fare_inr=fare,
        wait_min=wait,
        cost_scaled=cost,
        cost_divisor=d,
        approximate=approximate,
        inputs_hash=inputs_hash(inp),
    )


def _steps_cost(ctx: _Ctx, steps: list[Step]) -> int:
    rule = ctx.inp.rule
    visited = {s.task.task_id for s in steps if s.task is not None}
    left = sum(1 for t in ctx.tasks if t.task_id not in visited)
    return sum(leg_cost_scaled(rule, s.option, s.timing) for s in steps) + rule.fare_divisor * rule.weight_moved_task * left


def _raasta_ran_out(ctx: _Ctx, steps: list[Step], idx: int) -> bool:
    """True when a Raasta route serves this leg's pair but its last trip had gone by departure time."""
    inp = ctx.inp
    s = steps[idx]
    if idx == 0:
        ready, from_stay = inp.start.ready_at, inp.start.kind == "stay"
    else:
        ready, from_stay = steps[idx - 1].timing.end, False
    for opt in ctx.options.get((s.from_place, s.to_place), ()):
        if opt.is_raasta and opt.option_id != s.option.option_id:
            timing = time_leg(inp.rule, ready, from_stay, s.task, opt)
            if not timing.ok and timing.failure == "service":
                return True
    return False


def _dur(minutes: int) -> str:
    h, m = divmod(minutes, 60)
    return f"{h} h {m} min" if h and m else f"{h} h" if h else f"{m} min"


def _why_not(ctx: _Ctx, t: PlanTask) -> str:
    """Name why a task can't fit, using the earliest arrival the rules allow."""
    inp = ctx.inp
    relaxed_tasks = tuple(
        x.model_copy(update={"window": x.window.model_copy(update={"closes": 48 * 60})}) if x.task_id == t.task_id and x.window else x for x in inp.tasks
    )
    objective = inp.objective.model_copy(update={"allow_unplace": True, "min_left_out": 0, "max_left_out": None, "must_include": frozenset({t.task_id})})
    relaxed = inp.model_copy(update={"tasks": relaxed_tasks, "objective": objective})
    rctx = _build_ctx(relaxed)
    steps = _exact(rctx) if len(rctx.tasks) <= inp.rule.exact_search_max_tasks else _insertion(rctx)
    title = lower_first(t.title)
    if steps:
        for s in steps:
            if s.task is not None and s.task.task_id == t.task_id:
                if t.window is not None:
                    # Fixed times inside its opening hours are usually why: say so, rather than an arrival time
                    # from a relaxed plan the traveller never sees.
                    w = t.window
                    fixed = [x.fixed_start for x in inp.tasks if x.fixed_start is not None and x.task_id != t.task_id]
                    blockers = sorted(f for f in fixed if w.opens <= f < w.closes)
                    if blockers and (s.timing.arrive > w.closes or s.timing.end > w.closes):
                        times = " and ".join(hhmm(b) for b in blockers)  # type: ignore[arg-type]
                        plural = "s" if len(blockers) > 1 else ""
                        return (
                            f"The {title} needs {_dur(t.duration_min)} between {hhmm(t.window.opens)} and {hhmm(t.window.closes)}, "
                            f"and your fixed time{plural} at {times} leave no gap that long with the travel"
                        )
                    if s.timing.arrive > t.window.closes:
                        return f"The {title} closes at {hhmm(t.window.closes)}; the earliest arrival is {hhmm(s.timing.arrive)}"
                    return f"The {title} closes at {hhmm(t.window.closes)}; the earliest you can finish is {hhmm(s.timing.end)}"
                return f"The {title} doesn't fit in the rest of today"
    if (inp.start.place_id, t.place_id) not in ctx.options and t.place_id != inp.start.place_id:
        return f"There's no travel option to the {title} in this snapshot"
    return f"The {title} doesn't fit around your fixed times"


def _blocked(ctx: _Ctx) -> Blocked:
    """No plan keeps every fixed time: name the task at risk and why."""
    inp, rule = ctx.inp, ctx.inp.rule
    fixed = sorted((t for t in ctx.tasks if t.fixed_start is not None), key=lambda t: (t.fixed_start, t.task_id))
    start = inp.start
    for t in fixed:
        opts = ctx.options.get((start.place_id, t.place_id), ())
        if not opts and start.place_id != t.place_id:
            continue
        earliest_leave = max(start.ready_at, rule.day_earliest_departure) if start.kind == "stay" else start.ready_at + rule.leave_after_task_min
        fastest = min((o.travel_min for o in opts), default=0)
        arrival = earliest_leave + fastest
        if t.late_ok:
            ends = t.fixed_start + t.duration_min  # type: ignore[operator]
            if arrival >= ends:
                reason = f"The {lower_first(t.title)} ends at {hhmm(ends)}; the earliest arrival is {hhmm(arrival)}"
                return Blocked(task_id=t.task_id, title=t.title, reason=reason)
            continue
        if arrival > t.fixed_start - rule.fixed_buffer_min:  # type: ignore[operator]
            return Blocked(
                task_id=t.task_id, title=t.title, reason=f"The {lower_first(t.title)} starts at {hhmm(t.fixed_start)}; the earliest arrival is {hhmm(arrival)}"
            )  # type: ignore[arg-type]
    for t in sorted(ctx.tasks, key=_order_key):
        if _left_out_kind(inp, t) is None:
            return Blocked(task_id=t.task_id, title=t.title, reason=_why_not(ctx, t))
    t = sorted(ctx.tasks, key=_order_key)[0]
    return Blocked(task_id=t.task_id, title=t.title, reason=_why_not(ctx, t))


#: On a first plan, leaving a task out costs more than any day could: a task is "unplaced" only when it
#: can't fit, never because going there costs more than the ordinary penalty (a long cab ride does).
UNPLACED_WEIGHT = 1_000_000


def _first_plan(inp: PlannerInput) -> bool:
    o = inp.objective
    return o.allow_unplace and not o.allow_move and not o.allow_skip


def plan_day(inp: PlannerInput) -> PlanResult:
    """Plan the rest of a day. Pure and deterministic: the same input gives the same plan and hash."""
    first = _first_plan(inp) and inp.rule.weight_moved_task < UNPLACED_WEIGHT
    run = inp.model_copy(update={"rule": inp.rule.model_copy(update={"weight_moved_task": UNPLACED_WEIGHT})}) if first else inp
    ctx = _build_ctx(run)
    approximate = len(ctx.tasks) > inp.rule.exact_search_max_tasks
    steps = _insertion(ctx) if approximate else _exact(ctx)
    if steps is None:
        return PlanResult(
            feasible=False,
            reason_codes=(ReasonCode.NO_FEASIBLE_PLAN,),
            blocked=_blocked(ctx) if ctx.tasks else None,
            approximate=approximate,
            cost_divisor=inp.rule.fare_divisor,
            inputs_hash=inputs_hash(inp),
        )
    result = _assemble(ctx, steps, approximate)
    if not first:
        return result
    # The plan reports its cost on the ordinary scale, and the hash of what it was asked.
    extra = inp.rule.fare_divisor * (UNPLACED_WEIGHT - inp.rule.weight_moved_task) * len(result.moved)
    return result.model_copy(update={"cost_scaled": result.cost_scaled - extra, "inputs_hash": inputs_hash(inp)})


def simulate(inp: PlannerInput, order: list[tuple[str | None, str]] | tuple[tuple[str | None, str], ...]) -> tuple[PlanResult | None, str | None, str | None]:
    """Re-time a fixed task order with fixed leg options ("shift only").

    Returns (plan, None, None), or (None, failure, task_id) where failure is "fixed", "window",
    "service", "unavailable" or "missing" and task_id names the task that broke.

    Only main options count: a leg whose route is now unverified, stale or unconfirmed by Raasta is
    "unavailable", so the loop offers choices instead of shifting onto it (section 10 guardrails).
    """
    ctx = _build_ctx(inp.model_copy(update={"objective": inp.objective.model_copy(update={"allowed_modes": None})}))
    by_id = {t.task_id: t for t in ctx.tasks}
    main_opts = {o.option_id: o for opts in ctx.options.values() for o in opts}
    known = {o.option_id for p in inp.snapshot.pairs for o in p.options}
    rule = inp.rule
    place, ready, from_stay = inp.start.place_id, inp.start.ready_at, inp.start.kind == "stay"
    steps: list[Step] = []
    for task_id, option_id in order:
        t = by_id.get(task_id) if task_id else None
        if task_id and t is None:
            return None, "missing", task_id
        opt = main_opts.get(option_id)
        if opt is None:
            return None, ("unavailable" if option_id in known else "missing"), task_id
        to = t.place_id if t else inp.stay_place_id
        timing = time_leg(rule, ready, from_stay, t, opt)
        if not timing.ok:
            return None, timing.failure, task_id
        steps.append(Step(t, place, to, opt, timing))
        place, ready, from_stay = to, timing.end, False
    if len(steps) - 1 != len(ctx.tasks):
        return None, "missing", None
    return _assemble(ctx, steps, False), None, None
