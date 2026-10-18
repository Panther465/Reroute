"""The deterministic planner. Pure: inputs in, plan out. No clock, network or database.

tests/test_planner_purity.py checks that nothing in this package imports I/O modules.
"""

from .hashing import inputs_hash
from .models import (
    Blocked,
    LegOption,
    Mode,
    MovedTask,
    Objective,
    PairOptions,
    PlannedLeg,
    PlannerInput,
    PlanResult,
    PlanTask,
    ReasonCode,
    RuleSettings,
    Segment,
    Start,
    TransitRef,
    TravelSnapshot,
    Window,
)
from .replan import ReplanInput, ReplanOption, ReplanResult, replan
from .search import plan_day, simulate

RULE_VERSION = RuleSettings().version

__all__ = [
    "RULE_VERSION",
    "Blocked",
    "LegOption",
    "Mode",
    "MovedTask",
    "Objective",
    "PairOptions",
    "PlanResult",
    "PlanTask",
    "PlannedLeg",
    "PlannerInput",
    "ReasonCode",
    "ReplanInput",
    "ReplanOption",
    "ReplanResult",
    "RuleSettings",
    "Segment",
    "Start",
    "TransitRef",
    "TravelSnapshot",
    "Window",
    "inputs_hash",
    "plan_day",
    "replan",
    "simulate",
]
