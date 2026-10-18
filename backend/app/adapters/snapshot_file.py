"""Load a travel-time snapshot from a JSON file (examples/<city>/travel-times.json).

This is the sample snapshot adapter. The OSRM adapter builds the same TravelSnapshot from live
road times; the planner can't tell them apart.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from app.services.planner import LegOption, Mode, PairOptions, Segment, TransitRef, TravelSnapshot
from app.services.planner.util import to_minutes

#: Service hours for Raasta routes in the sample file; the live transit adapter replaces these
#: with the route's real first and last trip from the Raasta API.
SAMPLE_RAASTA_SERVICE = {"sample-kor-jay": ("07:00", "21:30"), "sample-jay-kor": ("07:00", "21:30")}


def parse_snapshot(
    data: dict[str, Any], raasta_status: dict[str, str] | None = None, raasta_service: dict[str, tuple[str, str]] | None = None
) -> TravelSnapshot:
    metro = data.get("service", {}).get("metro")
    raasta_service = raasta_service if raasta_service is not None else SAMPLE_RAASTA_SERVICE
    pairs = []
    for pair in data["pairs"]:
        options = []
        for o in pair["options"]:
            ref = o.get("transitRef")
            first = last = None
            transit = None
            if ref:
                status = None
                if ref["kind"] == "raasta":
                    status = (raasta_status or {}).get(ref["refId"], "verified")
                    svc = raasta_service.get(ref["refId"])
                    if svc:
                        first, last = to_minutes(svc[0]), to_minutes(svc[1])
                elif ref["kind"] == "metro" and metro:
                    first, last = to_minutes(metro["first"]), to_minutes(metro["last"])
                transit = TransitRef(kind=ref["kind"], ref_id=ref["refId"], status=status)
            options.append(
                LegOption(
                    option_id=o["optionId"],
                    mode=Mode(o["mode"]),
                    label=o["label"],
                    segments=tuple(Segment(mode=Mode(s["mode"]), minutes=s["minutes"]) for s in o["segments"]),
                    travel_min=o["travelMin"],
                    fare_inr=o["fareInr"],
                    service_first=first,
                    service_last=last,
                    transit_ref=transit,
                )
            )
        pairs.append(PairOptions(from_place=pair["from"], to_place=pair["to"], options=tuple(options)))
    return TravelSnapshot(snapshot_id=data["snapshotId"], pairs=tuple(pairs))


def load_snapshot(path: Path, **kwargs: Any) -> TravelSnapshot:
    return parse_snapshot(json.loads(path.read_text(encoding="utf-8")), **kwargs)
