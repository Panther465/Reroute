"""Load the sample Raasta routes (examples/<city>/raasta-routes.json). Safe to run more than once.

Every seeded stand and route is marked sample=true. Run with `python -m app.seed`.
"""

from __future__ import annotations

import json
import logging
import os
from datetime import UTC, datetime, timedelta
from pathlib import Path

from sqlalchemy import func
from sqlalchemy.orm import Session

from app.config import get_settings
from app.db import get_engine
from app.models import Confirmation, Route, RouteStand, Stand
from app.services.catalog import point
from app.services.freshness import STALE_AFTER_DAYS
from app.services.timefmt import parse_hhmm

log = logging.getLogger("raasta.seed")


def _linestring(coords: list[tuple[float, float]]):
    text = ", ".join(f"{lng:.7f} {lat:.7f}" for lng, lat in coords)
    return func.ST_GeogFromText(f"SRID=4326;LINESTRING({text})")


def seed(session: Session, data: dict, now: datetime) -> tuple[int, int]:
    """Insert stands and routes that aren't there yet. Returns (stands added, routes added)."""
    city = data["citySlug"]
    stands_added = routes_added = 0
    stands: dict[str, Stand] = {}
    for s in data["stands"]:
        stand = session.get(Stand, s["standId"])
        if stand is None:
            stand = Stand(stand_id=s["standId"], city_slug=city, name=s["name"], location=point(s["lng"], s["lat"]), lng=s["lng"], lat=s["lat"], sample=True)
            session.add(stand)
            stands_added += 1
        stands[s["standId"]] = stand
    session.flush()
    for r in data["routes"]:
        if session.get(Route, r["routeId"]) is not None:
            continue
        coords = [(stands[i].lng, stands[i].lat) for i in r["standIds"]]
        confirmed = now - timedelta(days=r.get("confirmedDaysAgo", 0))
        # A stale route went stale 90 days after its last confirmation, so those confirmations don't count towards reviving it.
        status_changed_at = min(now, confirmed + timedelta(days=STALE_AFTER_DAYS)) if r["status"] == "stale" else confirmed
        route = Route(
            route_id=r["routeId"],
            city_slug=city,
            path=_linestring(coords),
            path_coords=[list(c) for c in coords],
            vehicle_type=r["vehicleType"],
            fare_inr=r["fareInr"],
            frequency_min=r["frequencyMin"],
            first_trip=parse_hhmm(r["firstTrip"]),
            last_trip=parse_hhmm(r["lastTrip"]),
            status=r["status"],
            status_changed_at=status_changed_at,
            source=r["source"],
            confidence={"verified": 0.9, "unverified": 0.4, "stale": 0.5}[r["status"]],
            last_confirmed_at=confirmed,
            contributor_id=None,
            sample=True,
            created_at=confirmed,
        )
        route.stands = [RouteStand(seq=i, stand_id=sid) for i, sid in enumerate(r["standIds"], start=1)]
        session.add(route)
        session.flush()
        for n in range(r.get("confirmations", 0)):
            session.add(Confirmation(route_id=r["routeId"], user_id=f"sample-rider-{n + 1}", at=confirmed))
        routes_added += 1
    session.commit()
    return stands_added, routes_added


def main() -> None:
    logging.basicConfig(level=logging.INFO)
    base = Path(os.environ.get("EXAMPLES_DIR", get_settings().examples_dir))
    data = json.loads((base / "raasta-routes.json").read_text(encoding="utf-8"))
    with Session(get_engine()) as session:
        stands, routes = seed(session, data, datetime.now(UTC))
    log.info("seeded %d stands and %d routes (sample data)", stands, routes)


if __name__ == "__main__":
    main()
