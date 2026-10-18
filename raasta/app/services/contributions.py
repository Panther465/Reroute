"""Adding routes, the verification rules and moderator decisions (project brief, section 12)."""

from __future__ import annotations

import uuid
from datetime import datetime

from sqlalchemy import and_, func, or_, select
from sqlalchemy.orm import Session

from app.adapters.osrm import Router
from app.adapters.rides import RideStore
from app.config import Settings
from app.errors import ApiError, not_found
from app.models import Contribution, Route, RouteStand, Stand
from app.pagination import encode_cursor
from app.schemas import ContributionDecision, ContributionIn, ContributionOut, Location, TappedStand
from app.security import User
from app.services.catalog import point, route_out
from app.services.geo import LatLng, RidePoint, suggest_stops, trim_ride
from app.services.matching import RouteShape, find_match
from app.services.timefmt import parse_hhmm, to_local_iso

TRIM_M = 200.0


def new_id(prefix: str) -> str:
    return f"{prefix}-{uuid.uuid4().hex[:12]}"


def _resolve_stand(session: Session, city: str, tapped: TappedStand, settings: Settings) -> Stand:
    if tapped.stand_id:
        stand = session.get(Stand, tapped.stand_id)
        if stand is None:
            raise ApiError(422, "VALIDATION_ERROR", f"Stand {tapped.stand_id} doesn't exist.")
        return stand
    assert tapped.location is not None and tapped.name is not None
    loc = tapped.location
    return _stand_at(session, city, tapped.name, LatLng(loc.lat, loc.lng), settings)


def _stand_at(session: Session, city: str, name: str, at: LatLng, settings: Settings) -> Stand:
    """Reuse a stand within a few metres, so riders tapping the same corner share one stand."""
    here = point(at.lng, at.lat)
    existing = session.scalars(
        select(Stand)
        .where(Stand.city_slug == city, func.ST_DWithin(Stand.location, here, settings.stand_reuse_radius_m))
        .order_by(func.ST_Distance(Stand.location, here))
        .limit(1)
    ).first()
    if existing:
        return existing
    stand = Stand(stand_id=new_id("std"), city_slug=city, name=name.strip(), location=here, lng=at.lng, lat=at.lat, sample=False)
    session.add(stand)
    session.flush()
    return stand


def _linestring(coords: list[LatLng]):
    text = ", ".join(f"{p.lng:.7f} {p.lat:.7f}" for p in coords)
    return func.ST_GeogFromText(f"SRID=4326;LINESTRING({text})")


def _shape(route: Route) -> RouteShape:
    return RouteShape(route.vehicle_type, tuple(LatLng(rs.stand.lat, rs.stand.lng) for rs in route.stands))


def _contribution_out(session: Session, c: Contribution, settings: Settings, now: datetime, suggested: list[LatLng] | None = None) -> ContributionOut:
    route = session.get(Route, c.route_id) if c.route_id else None
    return ContributionOut(
        contribution_id=c.contribution_id,
        kind=c.kind,
        status=c.status,  # type: ignore[arg-type]
        route_id=c.route_id,
        contributor_id=c.contributor_id,
        reject_reason=c.reject_reason,
        created_at=to_local_iso(c.created_at, settings.city_utc_offset) or "",
        decided_at=to_local_iso(c.decided_at, settings.city_utc_offset),
        payload=c.payload,
        route=route_out(session, route, settings, now) if route else None,
        suggested_stands=[Location(lat=p.lat, lng=p.lng) for p in (suggested or [])],
    )


def create_contribution(
    session: Session, user: User, body: ContributionIn, router: Router, rides: RideStore, settings: Settings, now: datetime
) -> ContributionOut:
    contribution_id = new_id("con")
    suggested: list[LatLng] = []
    snapped: list[LatLng] | None = None
    payload: dict = {
        "vehicleType": body.vehicle_type,
        "fareInr": body.fare_inr,
        "frequencyMin": body.frequency_min,
        "firstTrip": body.first_trip,
        "lastTrip": body.last_trip,
    }

    if body.kind == "gps_ride":
        assert body.points is not None
        trimmed = trim_ride([RidePoint(p.lat, p.lng, p.t) for p in body.points], TRIM_M)
        if len(trimmed) < 2:
            raise ApiError(422, "VALIDATION_ERROR", "This ride is too short to keep once the first and last 200 m are trimmed.")
        suggested = suggest_stops(trimmed)
        snapped = router.match(trimmed) or [LatLng(p.lat, p.lng) for p in trimmed]
        tapped = body.stands or [TappedStand(name=f"Stand {i}", location=Location(lat=p.lat, lng=p.lng)) for i, p in enumerate(suggested, start=1)]
        if len(tapped) < 2:
            raise ApiError(422, "VALIDATION_ERROR", "Mark at least two stands while you ride, or add them after the ride.")
        rides.save(contribution_id, user.user_id, body.city_slug, trimmed, now)
        payload["pointsKept"] = len(trimmed)
        payload["pointsTrimmed"] = len(body.points) - len(trimmed)
    else:
        assert body.stands is not None
        tapped = body.stands

    stands = [_resolve_stand(session, body.city_slug, s, settings) for s in tapped]
    if len({s.stand_id for s in stands}) != len(stands):
        raise ApiError(422, "VALIDATION_ERROR", "Each stand can appear only once in a route.")
    payload["standIds"] = [s.stand_id for s in stands]
    stops = [LatLng(s.lat, s.lng) for s in stands]
    path = snapped or router.route(stops) or stops

    candidate = RouteShape(body.vehicle_type, tuple(stops))
    others = session.scalars(
        select(Route)
        .where(
            Route.city_slug == body.city_slug,
            Route.vehicle_type == body.vehicle_type,
            or_(Route.contributor_id.is_(None), Route.contributor_id != user.user_id),
        )
        .order_by(Route.route_id)
    ).all()
    match_id = find_match(candidate, [(r.route_id, _shape(r)) for r in others])

    contribution = Contribution(contribution_id=contribution_id, contributor_id=user.user_id, kind=body.kind, payload=payload, status="waiting", created_at=now)
    if match_id:
        # A second contributor submitted the same route: it is verified without a moderator.
        existing = session.get(Route, match_id)
        assert existing is not None
        if existing.status != "verified":
            existing.status = "verified"
            existing.status_changed_at = now
            for waiting in session.scalars(select(Contribution).where(Contribution.route_id == match_id, Contribution.status == "waiting")):
                waiting.status = "verified"
                waiting.decided_at = now
        existing.last_confirmed_at = now
        existing.confidence = min(1.0, existing.confidence + 0.25)
        contribution.status = "merged"
        contribution.route_id = match_id
        contribution.decided_at = now
    else:
        route = Route(
            route_id=new_id("rt"),
            city_slug=body.city_slug,
            path=_linestring(path),
            path_coords=[[p.lng, p.lat] for p in path],
            vehicle_type=body.vehicle_type,
            fare_inr=body.fare_inr,
            frequency_min=body.frequency_min,
            first_trip=parse_hhmm(body.first_trip),
            last_trip=parse_hhmm(body.last_trip),
            status="unverified",
            status_changed_at=now,
            source=body.kind,
            confidence=0.5 if body.kind == "gps_ride" else 0.4,
            contributor_id=user.user_id,
            sample=False,
            created_at=now,
        )
        route.stands = [RouteStand(seq=i, stand_id=s.stand_id) for i, s in enumerate(stands, start=1)]
        session.add(route)
        session.flush()
        contribution.route_id = route.route_id
    session.add(contribution)
    session.commit()
    return _contribution_out(session, contribution, settings, now, suggested)


def list_contributions(
    session: Session, status: str, after: dict | None, limit: int, settings: Settings, now: datetime
) -> tuple[list[ContributionOut], str | None]:
    query = select(Contribution).where(Contribution.status == status)
    if after:
        at = datetime.fromisoformat(after["c"])
        query = query.where(or_(Contribution.created_at < at, and_(Contribution.created_at == at, Contribution.contribution_id < after["i"])))
    rows = session.scalars(query.order_by(Contribution.created_at.desc(), Contribution.contribution_id.desc()).limit(limit + 1)).all()
    items = [_contribution_out(session, c, settings, now) for c in rows[:limit]]
    cursor = None
    if len(rows) > limit:
        last = rows[limit - 1]
        cursor = encode_cursor({"c": last.created_at.isoformat(), "i": last.contribution_id})
    return items, cursor


def decide_contribution(
    session: Session, moderator: User, contribution_id: str, decision: ContributionDecision, settings: Settings, now: datetime
) -> ContributionOut:
    c = session.get(Contribution, contribution_id)
    if c is None:
        raise not_found("Contribution")
    if c.status != "waiting":
        raise ApiError(409, "CONFLICT", f"This contribution was already {c.status}.")
    route = session.get(Route, c.route_id) if c.route_id else None

    if decision.action == "edit":
        if route is None:
            raise ApiError(409, "CONFLICT", "This contribution has no route to edit.")
        changes = decision.model_dump(exclude_none=True, exclude={"action", "reason"}, by_alias=True)
        if "vehicleType" in changes:
            route.vehicle_type = changes["vehicleType"]
        if "fareInr" in changes:
            route.fare_inr = changes["fareInr"]
        if "frequencyMin" in changes:
            route.frequency_min = changes["frequencyMin"]
        if "firstTrip" in changes:
            route.first_trip = parse_hhmm(changes["firstTrip"])
        if "lastTrip" in changes:
            route.last_trip = parse_hhmm(changes["lastTrip"])
        if route.first_trip >= route.last_trip:
            raise ApiError(422, "VALIDATION_ERROR", "lastTrip must be after firstTrip.")
        c.payload = {**c.payload, "edits": [*c.payload.get("edits", []), {"by": moderator.user_id, "at": now.isoformat(), "changes": changes}]}
    elif decision.action == "approve":
        if route is None:
            raise ApiError(409, "CONFLICT", "This contribution has no route to approve.")
        route.status = "verified"
        route.status_changed_at = now
        route.last_confirmed_at = now
        route.confidence = max(route.confidence, 0.8)
        c.status = "verified"
        c.decided_by = moderator.user_id
        c.decided_at = now
    else:
        c.status = "rejected"
        c.reject_reason = decision.reason
        c.decided_by = moderator.user_id
        c.decided_at = now
        # A rejected new route, or a stale route nobody can vouch for, leaves the map.
        if route is not None:
            c.route_id = None
            session.flush()
            session.delete(route)
    session.commit()
    return _contribution_out(session, c, settings, now)
