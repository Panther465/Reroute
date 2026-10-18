"""Seed data: the demo traveller, a moderator, the Bengaluru demo trip and its places (all sample).

Idempotent: run it as often as you like. Usage: python -m app.seed
"""

from __future__ import annotations

import json
import logging
from datetime import date, datetime

from geoalchemy2.elements import WKTElement
from sqlalchemy import delete, select
from sqlalchemy.orm import Session

from app.config import get_settings
from app.db import session_scope
from app.models import Checkin, Place, Plan, RerouteLog, ShareLink, Task, Trip, User

log = logging.getLogger("reroute.seed")

DEMO_USERS = [
    {"user_id": "usr-demo-traveller", "email": "demo.traveller@reroute.example", "name": "Arjun Mehta (sample)", "role": "traveller"},
    {"user_id": "usr-demo-moderator", "email": "demo.moderator@reroute.example", "name": "Demo moderator (sample)", "role": "moderator"},
]


def _demo_file() -> dict:
    return json.loads((get_settings().examples_dir / "bengaluru" / "demo-trip.json").read_text(encoding="utf-8"))


def seed_places(db: Session, data: dict) -> None:
    for p in data["places"]:
        place = db.get(Place, p["placeId"])
        if place is None:
            db.add(
                Place(
                    place_id=p["placeId"],
                    city_slug=data["trip"]["citySlug"],
                    name=p["name"],
                    area=p["area"],
                    lng=p["lng"],
                    lat=p["lat"],
                    sample=True,
                    location=WKTElement(f"POINT({p['lng']} {p['lat']})", srid=4326),
                )
            )


def _tasks(trip: Trip, data: dict) -> list[Task]:
    out = []
    for t in data["tasks"]:
        fixed = datetime.fromisoformat(t["fixedStart"]) if t.get("fixedStart") else None
        day = fixed.date() if fixed else trip.start_date
        window = t.get("window") or {}
        out.append(
            Task(
                task_id=t["taskId"],
                trip_id=trip.trip_id,
                title=t["title"],
                place_id=t["placeId"],
                duration_min=t["durationMin"],
                fixed_start=fixed,
                opens_at=window.get("opensAt"),
                closes_at=window.get("closesAt"),
                day=day,
                planned_day=day,
                priority=t["priority"],
                state="planned",
            )
        )
    return out


def reset_demo_trip(db: Session, trip: Trip) -> None:
    """Put the sample day back to its start: no plans, no check-ins, the four sample tasks."""
    data = _demo_file()
    for model in (Checkin, RerouteLog, ShareLink, Plan, Task):
        db.execute(delete(model).where(model.trip_id == trip.trip_id))
    db.flush()
    db.add_all(_tasks(trip, data))


def seed(db: Session) -> None:
    for u in DEMO_USERS:
        if db.get(User, u["user_id"]) is None:
            db.add(User(**u, is_demo=True))
    data = _demo_file()
    seed_places(db, data)
    db.flush()
    t = data["trip"]
    if db.get(Trip, t["tripId"]) is None:
        trip = Trip(
            trip_id=t["tripId"],
            user_id="usr-demo-traveller",
            city_slug=t["citySlug"],
            city_name=t["cityName"],
            start_date=date.fromisoformat(t["startDate"]),
            end_date=date.fromisoformat(t["endDate"]),
            utc_offset=t["utcOffset"],
            stay_place_id=t["stayPlaceId"],
            stay_label=t["stayLabel"],
            sample=True,
        )
        db.add(trip)
        db.flush()
        db.add_all(_tasks(trip, data))
    elif not db.scalar(select(Task.task_id).where(Task.trip_id == t["tripId"]).limit(1)):
        reset_demo_trip(db, db.get(Trip, t["tripId"]))  # type: ignore[arg-type]


def main() -> None:
    logging.basicConfig(level=logging.INFO)
    with session_scope() as db:
        seed(db)
    log.info("Seed data is in place (all labelled as sample).")


if __name__ == "__main__":
    main()
