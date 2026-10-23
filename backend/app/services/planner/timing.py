"""Time rules for a single leg (rule version 1.0).

- Leave 5 minutes after a task ends. For a fixed task, leave at the latest time that still
  arrives 10 minutes early.
- A fixed task the traveller goes to anyway (late_ok) that can't be reached in time: leave as soon
  as possible; it starts on arrival. Arriving after it would have ended is still a failure.
- A window task starts on arrival, never before it opens, and must finish by closing time.
- Never depart outside a route's or the metro's service hours.
- The first leg from the place of stay leaves as late as the first task allows, so the
  traveller never waits at a closed door.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Literal

from .models import LegOption, PlanTask, RuleSettings

Failure = Literal["fixed", "window", "service"]


@dataclass(frozen=True, slots=True)
class LegTiming:
    ok: bool
    leave: int = 0
    arrive: int = 0
    start: int = 0
    end: int = 0
    wait: int = 0
    failure: Failure | None = None
    #: Minutes after a fixed start, for a fixed task the traveller goes to anyway.
    late: int = 0


def time_leg(rule: RuleSettings, ready: int, from_stay: bool, task: PlanTask | None, opt: LegOption) -> LegTiming:
    earliest = max(ready, rule.day_earliest_departure) if from_stay else ready + rule.leave_after_task_min
    travel = opt.travel_min
    first, last = opt.service_first, opt.service_last

    if task is not None and task.fixed_start is not None:
        latest_for_task = task.fixed_start - rule.fixed_buffer_min - travel
        latest = latest_for_task if last is None else min(latest_for_task, last)
        low = earliest if first is None else max(earliest, first)
        if latest < low:
            if task.late_ok and latest_for_task < earliest and (last is None or low <= last):
                # Going anyway: leave now; the task starts when you get there.
                arrive = low + travel
                if arrive >= task.fixed_start + task.duration_min:
                    return LegTiming(ok=False, failure="fixed")
                start = max(arrive, task.fixed_start)
                return LegTiming(True, low, arrive, start, start + task.duration_min, 0, late=max(0, arrive - task.fixed_start))
            # Distinguish "can't get there in time" from "the route isn't running then".
            failure: Failure = "fixed" if latest_for_task < earliest else "service"
            return LegTiming(ok=False, failure=failure)
        leave = latest
        arrive = leave + travel
        return LegTiming(True, leave, arrive, task.fixed_start, task.fixed_start + task.duration_min, 0)

    leave = earliest
    if from_stay and task is not None and task.window is not None:
        leave = max(leave, task.window.opens - travel)
    wait = 0
    if first is not None and leave < first:
        if not from_stay:
            wait = first - leave
        leave = first
    if last is not None and leave > last:
        return LegTiming(ok=False, failure="service")
    arrive = leave + travel

    if task is None:
        return LegTiming(True, leave, arrive, arrive, arrive, wait)

    start = arrive
    if task.window is not None:
        if arrive < task.window.opens:
            wait += task.window.opens - arrive
            start = task.window.opens
        end = start + task.duration_min
        if end > task.window.closes:
            return LegTiming(ok=False, failure="window")
        return LegTiming(True, leave, arrive, start, end, wait)
    return LegTiming(True, leave, arrive, start, start + task.duration_min, wait)


def leg_cost_scaled(rule: RuleSettings, opt: LegOption, timing: LegTiming) -> int:
    """travel + fare / divisor + wait (+ minutes late), multiplied by the divisor so it stays an integer."""
    d = rule.fare_divisor
    return d * rule.weight_travel * opt.travel_min + opt.fare_inr + d * rule.weight_wait * timing.wait + d * rule.weight_late * timing.late
