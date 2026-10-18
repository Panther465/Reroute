"""inputsHash: the SHA-256 of the canonical JSON of every planner input.

The travel-time snapshot ID and the rule version are part of the inputs, so a saved plan can be
replayed exactly: same inputs, same plan, same hash.
"""

from __future__ import annotations

import hashlib
import json
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from .models import PlannerInput


def canonical_json(data: object) -> str:
    return json.dumps(data, sort_keys=True, separators=(",", ":"), ensure_ascii=False, default=_default)


def _default(value: object) -> object:
    if isinstance(value, (set, frozenset)):
        return sorted(value)
    raise TypeError(f"Not JSON serialisable: {type(value).__name__}")


def inputs_hash(inp: PlannerInput) -> str:
    payload = inp.model_dump(mode="json")
    return hashlib.sha256(canonical_json(payload).encode("utf-8")).hexdigest()
