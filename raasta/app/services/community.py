"""Riders confirming routes and reporting fares, plus the 90-day freshness check."""

from __future__ import annotations

from datetime import datetime, timedelta

from sqlalchemy import and_, or_, select
from sqlalchemy.orm import Session

from app.config import Settings
from app.errors import ApiError, not_found
from app.models import Confirmation, Contribution, FareReport, Route
from app.pagination import encode_cursor
from app.schemas import ConfirmationOut, FareReportOut
from app.security import User
from app.services.catalog import confirmations_count, get_route
from app.services.contributions import mark_verified, new_id, riders_since_stale
from app.services.freshness import STALE_AFTER_DAYS, is_stale, reverified_by_riders
from app.services.timefmt import parse_offset, to_local_iso


def confirm_route(session: Session, user: User, route_id: str, settings: Settings, now: datetime) -> ConfirmationOut:
    """One confirmation per rider per route per local day; a repeat returns the current state."""
    # Locking the route row serialises confirmations of one route, so a double tap can't add two.
    route = session.get(Route, route_id, with_for_update=True)
    if route is None:
        raise not_found("Route")
    day_start = now.astimezone(parse_offset(settings.city_utc_offset)).replace(hour=0, minute=0, second=0, microsecond=0)
    today = select(Confirmation.confirmation_id).where(Confirmation.route_id == route_id, Confirmation.user_id == user.user_id, Confirmation.at >= day_start)
    if session.scalar(today.limit(1)) is None:
        session.add(Confirmation(route_id=route_id, user_id=user.user_id, at=now))
        route.last_confirmed_at = now
        session.flush()
        if route.status == "stale" and reverified_by_riders(riders_since_stale(session, route)):
            mark_verified(session, route, now)
    count = confirmations_count(session, route_id)
    session.commit()
    return ConfirmationOut(
        route_id=route_id,
        status=route.status,
        last_confirmed_at=to_local_iso(route.last_confirmed_at, settings.city_utc_offset),
        confirmations_count=count,
    )  # type: ignore[arg-type]


def _fare_out(r: FareReport, settings: Settings) -> FareReportOut:
    return FareReportOut(
        fare_report_id=r.fare_report_id,
        route_id=r.route_id,
        user_id=r.user_id,
        fare_inr=r.fare_inr,
        status=r.status,  # type: ignore[arg-type]
        at=to_local_iso(r.at, settings.city_utc_offset) or "",
        decided_at=to_local_iso(r.decided_at, settings.city_utc_offset),
    )


def report_fare(session: Session, user: User, route_id: str, fare_inr: int, settings: Settings, now: datetime) -> FareReportOut:
    get_route(session, route_id)
    report = FareReport(fare_report_id=new_id("fr"), route_id=route_id, user_id=user.user_id, fare_inr=fare_inr, status="waiting", at=now)
    session.add(report)
    session.commit()
    return _fare_out(report, settings)


def list_fare_reports(session: Session, status: str, after: dict | None, limit: int, settings: Settings) -> tuple[list[FareReportOut], str | None]:
    query = select(FareReport).where(FareReport.status == status)
    if after:
        at = datetime.fromisoformat(after["c"])
        query = query.where(or_(FareReport.at < at, and_(FareReport.at == at, FareReport.fare_report_id < after["i"])))
    rows = session.scalars(query.order_by(FareReport.at.desc(), FareReport.fare_report_id.desc()).limit(limit + 1)).all()
    cursor = encode_cursor({"c": rows[limit - 1].at.isoformat(), "i": rows[limit - 1].fare_report_id}) if len(rows) > limit else None
    return [_fare_out(r, settings) for r in rows[:limit]], cursor


def decide_fare_report(session: Session, moderator: User, report_id: str, action: str, settings: Settings, now: datetime) -> FareReportOut:
    report = session.get(FareReport, report_id)
    if report is None:
        raise not_found("Fare report")
    if report.status != "waiting":
        raise ApiError(409, "CONFLICT", f"This fare report was already {report.status}.")
    report.status = "accepted" if action == "accept" else "rejected"
    report.decided_by = moderator.user_id
    report.decided_at = now
    session.commit()
    return _fare_out(report, settings)


def mark_stale(session: Session, now: datetime, days: int = STALE_AFTER_DAYS) -> list[str]:
    """Verified routes with no confirmation for `days` days become stale and go back to the queue."""
    cutoff = now - timedelta(days=days)
    candidates = session.scalars(
        select(Route).where(
            Route.status == "verified", or_(Route.last_confirmed_at < cutoff, and_(Route.last_confirmed_at.is_(None), Route.status_changed_at < cutoff))
        )
    ).all()
    changed: list[str] = []
    for route in candidates:
        if not is_stale(route.last_confirmed_at, route.status_changed_at, now, days):
            continue
        route.status = "stale"
        route.status_changed_at = now
        session.add(
            Contribution(
                contribution_id=new_id("con"),
                contributor_id=None,
                kind="freshness_check",
                payload={"reason": f"No rider confirmed this route for {days} days.", "routeId": route.route_id},
                status="waiting",
                route_id=route.route_id,
                created_at=now,
            )
        )
        changed.append(route.route_id)
    session.commit()
    return changed
