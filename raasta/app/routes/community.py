"""Writes: contributions, confirmations, fare reports, and the moderator queue."""

from __future__ import annotations

from datetime import datetime
from typing import Literal

from fastapi import APIRouter, Depends, Query, status
from sqlalchemy.orm import Session

from app.adapters.osrm import Router, get_router
from app.adapters.rides import RideStore, get_ride_store
from app.config import Settings, get_settings
from app.db import get_session
from app.pagination import Page
from app.ratelimit import enforce_daily_contributions, per_minute_limit
from app.routes.deps import utc_now
from app.schemas import (
    ConfirmationIn,
    ConfirmationOut,
    ContributionDecision,
    ContributionIn,
    ContributionOut,
    FareReportDecision,
    FareReportIn,
    FareReportOut,
)
from app.schemas import Page as PageOut
from app.security import User, require_moderator, require_user
from app.services import community, contributions
from app.services.timefmt import parse_offset

router = APIRouter(tags=["Contributions and moderation"], dependencies=[Depends(per_minute_limit)])


@router.post("/contributions", response_model=ContributionOut, status_code=status.HTTP_201_CREATED, summary="Add a route or a GPS ride")
def add_contribution(
    body: ContributionIn,
    user: User = Depends(require_user),
    session: Session = Depends(get_session),
    router_: Router = Depends(get_router),
    rides: RideStore = Depends(get_ride_store),
    settings: Settings = Depends(get_settings),
    now: datetime = Depends(utc_now),
) -> ContributionOut:
    local_day = now.astimezone(parse_offset(settings.city_utc_offset)).strftime("%Y%m%d")
    enforce_daily_contributions(user, local_day, settings.contributions_per_day)
    return contributions.create_contribution(session, user, body, router_, rides, settings, now)


@router.get("/contributions", response_model=PageOut[ContributionOut], summary="The moderator queue")
def list_contributions(
    status_: Literal["waiting", "verified", "rejected", "merged"] = Query(default="waiting", alias="status"),
    page: Page = Depends(),
    _: User = Depends(require_moderator),
    session: Session = Depends(get_session),
    settings: Settings = Depends(get_settings),
    now: datetime = Depends(utc_now),
) -> PageOut[ContributionOut]:
    items, cursor = contributions.list_contributions(session, status_, page.position, page.limit, settings, now)
    return PageOut[ContributionOut](items=items, next_cursor=cursor)


@router.patch("/contributions/{contribution_id}", response_model=ContributionOut, summary="Moderator decision: approve, edit or reject")
def decide_contribution(
    contribution_id: str,
    body: ContributionDecision,
    moderator: User = Depends(require_moderator),
    session: Session = Depends(get_session),
    settings: Settings = Depends(get_settings),
    now: datetime = Depends(utc_now),
) -> ContributionOut:
    return contributions.decide_contribution(session, moderator, contribution_id, body, settings, now)


@router.post("/routes/{route_id}/confirmations", response_model=ConfirmationOut, status_code=status.HTTP_201_CREATED, summary="Confirm that a route still runs")
def confirm(
    route_id: str,
    body: ConfirmationIn,
    user: User = Depends(require_user),
    session: Session = Depends(get_session),
    settings: Settings = Depends(get_settings),
    now: datetime = Depends(utc_now),
) -> ConfirmationOut:
    del body
    return community.confirm_route(session, user, route_id, settings, now)


@router.post("/routes/{route_id}/fare-reports", response_model=FareReportOut, status_code=status.HTTP_201_CREATED, summary="Report a fare")
def report_fare(
    route_id: str,
    body: FareReportIn,
    user: User = Depends(require_user),
    session: Session = Depends(get_session),
    settings: Settings = Depends(get_settings),
    now: datetime = Depends(utc_now),
) -> FareReportOut:
    return community.report_fare(session, user, route_id, body.fare_inr, settings, now)


@router.get("/fare-reports", response_model=PageOut[FareReportOut], summary="Fare reports waiting for review")
def list_fare_reports(
    status_: Literal["waiting", "accepted", "rejected"] = Query(default="waiting", alias="status"),
    page: Page = Depends(),
    _: User = Depends(require_moderator),
    session: Session = Depends(get_session),
    settings: Settings = Depends(get_settings),
) -> PageOut[FareReportOut]:
    items, cursor = community.list_fare_reports(session, status_, page.position, page.limit, settings)
    return PageOut[FareReportOut](items=items, next_cursor=cursor)


@router.patch("/fare-reports/{fare_report_id}", response_model=FareReportOut, summary="Moderator decision on a fare report")
def decide_fare_report(
    fare_report_id: str,
    body: FareReportDecision,
    moderator: User = Depends(require_moderator),
    session: Session = Depends(get_session),
    settings: Settings = Depends(get_settings),
    now: datetime = Depends(utc_now),
) -> FareReportOut:
    return community.decide_fare_report(session, moderator, fare_report_id, body.action, settings, now)
