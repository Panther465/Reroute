"""Adding routes, the verification rules and moderator decisions (project brief, section 12)."""

from __future__ import annotations

import logging
import uuid
from datetime import datetime

from sqlalchemy import and_, func, or_, select
from sqlalchemy.orm import Session

from app import cities
from app.adapters.osrm import Router
from app.adapters.rides import RideStore, RideStoreUnavailable
from app.config import Settings
from app.errors import ApiError, not_found
from app.models import Confirmation, Contribution, Route, RouteStand, Stand
from app.pagination import cursor_value, encode_cursor
from app.schemas import ContributionDecision, ContributionIn, ContributionOut, Location, TappedStand
from app.security import User
from app.services.catalog import point, route_out
from app.services.freshness import reverified_by_riders
from app.services.geo import LatLng, RidePoint, downsample, suggest_stops, trim_ride
from app.services.matching import RouteShape, find_match
from app.services.timefmt import parse_hhmm, to_local_iso

log = logging.getLogger("raasta")

TRIM_M = 200.0
#: Rides are thinned to this many points, spread over time, before finding stops and snapping to roads.
MAX_RIDE_POINTS = 2000
#: At most this many stands are suggested from one ride, spread along it.
MAX_SUGGESTED_STANDS = 20


def new_id(prefix: str) -> str:
    return f"{prefix}-{uuid.uuid4().hex[:12]}"


def _ride_store_down(session: Session, exc: RideStoreUnavailable) -> ApiError:
    session.rollback()
    log.warning("ride store unavailable: %s", exc)
    return ApiError(503, "UNAVAILABLE", "Recorded rides can't be saved or removed right now. Try again in a few minutes.")


def _check_area(body: ContributionIn) -> None:
    """The city must be one Raasta serves, and every tapped stand and ride point must lie inside it."""
    place = cities.city(body.city_slug)
    if place is None:
        raise ApiError(422, "VALIDATION_ERROR", f"Raasta doesn't cover the city {body.city_slug!r}.")
    for i, s in enumerate(body.stands or []):
        if s.location is not None and not place.contains(s.location.lng, s.location.lat):
            raise ApiError(422, "VALIDATION_ERROR", f"stands.{i}.location is outside {place.name}.")
    for i, p in enumerate(body.points or []):
        if not place.contains(p.lng, p.lat):
            raise ApiError(422, "VALIDATION_ERROR", f"points.{i} is outside {place.name}.")


def _at_most(items: list[LatLng], n: int) -> list[LatLng]:
    """`n` items spread evenly through the list, keeping the first and the last."""
    if len(items) <= n:
        return items
    return [items[round(k * (len(items) - 1) / (n - 1))] for k in range(n)]


def _resolve_stand(session: Session, city: str, tapped: TappedStand, settings: Settings) -> Stand:
    if tapped.stand_id:
        stand = session.get(Stand, tapped.stand_id)
        if stand is None:
            raise ApiError(422, "VALIDATION_ERROR", f"Stand {tapped.stand_id} doesn't exist.")
        if stand.city_slug != city:
            raise ApiError(422, "VALIDATION_ERROR", f"Stand {tapped.stand_id} is in another city.")
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


def _own_evidence(body: ContributionIn) -> bool:
    """A recorded ride, or at least one stand tapped on the map: not only stand IDs copied from a route."""
    return body.kind == "gps_ride" or any(s.stand_id is None for s in body.stands or [])


def _has_contributed(session: Session, route: Route, user_id: str) -> bool:
    if route.contributor_id == user_id:
        return True
    earlier = select(Contribution.contribution_id).where(Contribution.route_id == route.route_id, Contribution.contributor_id == user_id).limit(1)
    return session.scalar(earlier) is not None


def riders_since_stale(session: Session, route: Route) -> set[str]:
    """Everyone who vouched for a route since its status last changed: riders confirming it, and contributors whose route matched it."""
    confirmers = select(Confirmation.user_id).where(Confirmation.route_id == route.route_id, Confirmation.at >= route.status_changed_at)
    contributors = select(Contribution.contributor_id).where(
        Contribution.route_id == route.route_id,
        Contribution.status == "merged",
        Contribution.created_at >= route.status_changed_at,
        Contribution.contributor_id.is_not(None),
    )
    return {*session.scalars(confirmers), *session.scalars(contributors)}


def mark_verified(session: Session, route: Route, now: datetime) -> None:
    """Verify a route and close what was waiting on it: its new-route contribution or its freshness check."""
    route.status = "verified"
    route.status_changed_at = now
    for waiting in session.scalars(select(Contribution).where(Contribution.route_id == route.route_id, Contribution.status == "waiting")):
        waiting.status = "verified"
        waiting.decided_at = now


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
    _check_area(body)
    contribution_id = new_id("con")
    suggested: list[LatLng] = []
    snapped: list[LatLng] | None = None
    ride: list[RidePoint] | None = None
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
            raise ApiError(422, "VALIDATION_ERROR", "This ride is too short to keep once the points within 200 m of its start and end are removed.")
        sampled = downsample(trimmed, MAX_RIDE_POINTS)
        suggested = _at_most(suggest_stops(sampled), MAX_SUGGESTED_STANDS)
        snapped = router.match(sampled) or [LatLng(p.lat, p.lng) for p in sampled]
        tapped = body.stands or [TappedStand(name=f"Stand {i}", location=Location(lat=p.lat, lng=p.lng)) for i, p in enumerate(suggested, start=1)]
        if len(tapped) < 2:
            raise ApiError(422, "VALIDATION_ERROR", "Mark at least two stands while you ride, or add them after the ride.")
        ride = trimmed
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
        existing = session.get(Route, match_id)
        assert existing is not None
        # A second, different contributor verifies a new route, but only with their own evidence and
        # only once: copied stand IDs or a resubmission don't count. A stale route needs a moderator
        # or two different riders since it went stale, so one submission alone never revives it.
        independent = _own_evidence(body) and not _has_contributed(session, existing, user.user_id)
        if existing.status == "unverified":
            verify = independent
        else:
            verify = existing.status == "stale" and reverified_by_riders({*riders_since_stale(session, existing), user.user_id})
        if verify:
            mark_verified(session, existing, now)
        existing.last_confirmed_at = now
        if independent:
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
    session.flush()
    # The ride goes to MongoDB only once everything else is valid, so a refused contribution never leaves one behind.
    if ride is not None:
        try:
            rides.save(contribution_id, user.user_id, body.city_slug, ride, now)
        except RideStoreUnavailable as exc:
            raise _ride_store_down(session, exc) from exc
    try:
        session.commit()
    except Exception:
        if ride is not None:
            try:
                rides.delete(contribution_id)
            except RideStoreUnavailable:
                log.error("couldn't remove the ride of failed contribution %s", contribution_id)
        raise
    return _contribution_out(session, contribution, settings, now, suggested)


def list_contributions(
    session: Session, status: str, after: dict | None, limit: int, settings: Settings, now: datetime
) -> tuple[list[ContributionOut], str | None]:
    query = select(Contribution).where(Contribution.status == status)
    if after:
        at, last_id = cursor_value(after, "c", datetime), cursor_value(after, "i", str)
        query = query.where(or_(Contribution.created_at < at, and_(Contribution.created_at == at, Contribution.contribution_id < last_id)))
    rows = session.scalars(query.order_by(Contribution.created_at.desc(), Contribution.contribution_id.desc()).limit(limit + 1)).all()
    items = [_contribution_out(session, c, settings, now) for c in rows[:limit]]
    cursor = None
    if len(rows) > limit:
        last = rows[limit - 1]
        cursor = encode_cursor({"c": last.created_at.isoformat(), "i": last.contribution_id})
    return items, cursor


def decide_contribution(
    session: Session, moderator: User, contribution_id: str, decision: ContributionDecision, rides: RideStore, settings: Settings, now: datetime
) -> ContributionOut:
    c = session.get(Contribution, contribution_id)
    if c is None:
        raise not_found("Contribution")
    if c.status != "waiting":
        raise ApiError(409, "CONFLICT", f"This contribution was already {c.status}.")
    if decision.action == "approve" and c.contributor_id == moderator.user_id:
        raise ApiError(403, "FORBIDDEN", "Another moderator has to approve your own contribution.")
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
        if c.kind == "gps_ride":
            try:
                rides.delete(c.contribution_id)
            except RideStoreUnavailable as exc:
                raise _ride_store_down(session, exc) from exc
    session.commit()
    return _contribution_out(session, c, settings, now)
