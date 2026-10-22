"""Reroute tables (public schema). Raasta's tables live in their own schema and are never read from here."""

from __future__ import annotations

import secrets
from datetime import date, datetime

from geoalchemy2 import Geography
from sqlalchemy import (
    JSON,
    Boolean,
    Date,
    DateTime,
    Float,
    ForeignKey,
    Index,
    Integer,
    String,
    Text,
    UniqueConstraint,
    func,
    text,
)
from sqlalchemy.dialects.postgresql import ARRAY, JSONB
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db import Base

JsonB = JSON().with_variant(JSONB(), "postgresql")


def new_id(prefix: str) -> str:
    return f"{prefix}-{secrets.token_hex(6)}"


class User(Base):
    __tablename__ = "users"

    user_id: Mapped[str] = mapped_column(String(40), primary_key=True, default=lambda: new_id("usr"))
    google_sub: Mapped[str | None] = mapped_column(String(255), unique=True)
    email: Mapped[str] = mapped_column(String(320))
    name: Mapped[str] = mapped_column(String(200))
    role: Mapped[str] = mapped_column(String(20), default="traveller")
    is_demo: Mapped[bool] = mapped_column(Boolean, default=False)
    #: A scrypt hash (app.security.hash_password), for an account made with email and password.
    password_hash: Mapped[str | None] = mapped_column(Text)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class WalletEntry(Base):
    """Simulated money in or out of a traveller's wallet. The balance is the sum of the entries."""

    __tablename__ = "wallet_entries"

    entry_id: Mapped[str] = mapped_column(String(40), primary_key=True, default=lambda: new_id("wal"))
    user_id: Mapped[str] = mapped_column(ForeignKey("users.user_id", ondelete="CASCADE"), index=True)
    amount_inr: Mapped[int] = mapped_column(Integer)
    kind: Mapped[str] = mapped_column(String(12))
    label: Mapped[str] = mapped_column(String(200))
    booking_id: Mapped[str | None] = mapped_column(String(40))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class RefreshToken(Base):
    __tablename__ = "refresh_tokens"

    token_id: Mapped[str] = mapped_column(String(40), primary_key=True, default=lambda: new_id("rt"))
    user_id: Mapped[str] = mapped_column(ForeignKey("users.user_id", ondelete="CASCADE"), index=True)
    family_id: Mapped[str] = mapped_column(String(40), index=True)
    token_hash: Mapped[str] = mapped_column(String(64), unique=True)
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    revoked_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class Place(Base):
    __tablename__ = "places"

    place_id: Mapped[str] = mapped_column(String(80), primary_key=True)
    city_slug: Mapped[str] = mapped_column(String(40), index=True)
    name: Mapped[str] = mapped_column(String(200))
    area: Mapped[str] = mapped_column(String(120))
    location: Mapped[object] = mapped_column(Geography(geometry_type="POINT", srid=4326))
    lng: Mapped[float] = mapped_column(Float)
    lat: Mapped[float] = mapped_column(Float)
    osm_id: Mapped[str | None] = mapped_column(String(40))
    sample: Mapped[bool] = mapped_column(Boolean, default=False)


class Trip(Base):
    __tablename__ = "trips"

    trip_id: Mapped[str] = mapped_column(String(40), primary_key=True, default=lambda: new_id("trip"))
    user_id: Mapped[str] = mapped_column(ForeignKey("users.user_id", ondelete="CASCADE"), index=True)
    city_slug: Mapped[str] = mapped_column(String(40))
    city_name: Mapped[str] = mapped_column(String(80))
    start_date: Mapped[date] = mapped_column(Date)
    end_date: Mapped[date] = mapped_column(Date)
    utc_offset: Mapped[str] = mapped_column(String(6), default="+05:30")
    stay_place_id: Mapped[str] = mapped_column(ForeignKey("places.place_id"))
    stay_label: Mapped[str] = mapped_column(String(200))
    sample: Mapped[bool] = mapped_column(Boolean, default=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())

    tasks: Mapped[list[Task]] = relationship(back_populates="trip", order_by="Task.created_at", cascade="all, delete-orphan")


class Task(Base):
    __tablename__ = "tasks"

    task_id: Mapped[str] = mapped_column(String(40), primary_key=True, default=lambda: new_id("task"))
    trip_id: Mapped[str] = mapped_column(ForeignKey("trips.trip_id", ondelete="CASCADE"), index=True)
    title: Mapped[str] = mapped_column(String(120))
    place_id: Mapped[str] = mapped_column(ForeignKey("places.place_id"))
    duration_min: Mapped[int] = mapped_column(Integer)
    fixed_start: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    opens_at: Mapped[str | None] = mapped_column(String(5))
    closes_at: Mapped[str | None] = mapped_column(String(5))
    #: The trip day the task is planned for now. A moved task gets the next day.
    day: Mapped[date] = mapped_column(Date)
    #: The day the traveller asked for, so an Undo can bring a moved task back.
    planned_day: Mapped[date] = mapped_column(Date)
    #: The plan that moved or skipped this task, if any.
    changed_by_plan_id: Mapped[str | None] = mapped_column(String(40))
    priority: Mapped[int] = mapped_column(Integer, default=2)
    state: Mapped[str] = mapped_column(String(20), default="planned")
    hours_unknown: Mapped[bool] = mapped_column(Boolean, default=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), onupdate=func.now())

    trip: Mapped[Trip] = relationship(back_populates="tasks")
    place: Mapped[Place] = relationship(lazy="joined")


class Plan(Base):
    """An immutable plan version. Only `status` (and `activated_at`) may change; a trigger enforces it."""

    __tablename__ = "plans"
    __table_args__ = (
        UniqueConstraint("trip_id", "version", name="uq_plans_trip_version"),
        Index("uq_plans_one_active", "trip_id", unique=True, postgresql_where=text("status = 'active'")),
    )

    plan_id: Mapped[str] = mapped_column(String(40), primary_key=True, default=lambda: new_id("plan"))
    trip_id: Mapped[str] = mapped_column(ForeignKey("trips.trip_id", ondelete="CASCADE"), index=True)
    day: Mapped[date] = mapped_column(Date)
    #: Null while proposed; set when the plan becomes active.
    version: Mapped[int | None] = mapped_column(Integer)
    status: Mapped[str] = mapped_column(String(20))
    trigger: Mapped[str] = mapped_column(String(20))
    checkin_id: Mapped[str | None] = mapped_column(String(40))
    inputs_hash: Mapped[str] = mapped_column(String(64))
    rule_version: Mapped[str] = mapped_column(String(10))
    travel_time_snapshot_id: Mapped[str] = mapped_column(String(80))
    inputs: Mapped[dict] = mapped_column(JsonB)
    legs: Mapped[list] = mapped_column(JsonB)
    #: Legs already travelled before this version began, carried over for the timeline and summary.
    done_legs: Mapped[list] = mapped_column(JsonB, default=list)
    moved: Mapped[list] = mapped_column(JsonB, default=list)
    travel_min: Mapped[int] = mapped_column(Integer)
    fare_inr: Mapped[int] = mapped_column(Integer)
    wait_min: Mapped[int] = mapped_column(Integer)
    cost: Mapped[float] = mapped_column(Float)
    reason_codes: Mapped[list[str]] = mapped_column(ARRAY(String(40)).with_variant(JSON(), "sqlite"))
    explanation: Mapped[str] = mapped_column(Text)
    approximate: Mapped[bool] = mapped_column(Boolean, default=False)
    #: Proposed plans are re-plan options: their option fields and the open option set they belong to.
    option_set_id: Mapped[str | None] = mapped_column(String(40), index=True)
    option_id: Mapped[str | None] = mapped_column(String(20))
    option: Mapped[dict | None] = mapped_column(JsonB)
    #: Why this plan: the leg choices and the other days the planner weighed (planner/insight.py), saved
    #: with the plan so the API only reads it.
    insight: Mapped[dict | None] = mapped_column(JsonB)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    activated_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


class PlanLeg(Base):
    """Legs of a plan, one row each, for querying and the summary. Written once with the plan."""

    __tablename__ = "plan_legs"

    plan_id: Mapped[str] = mapped_column(ForeignKey("plans.plan_id", ondelete="CASCADE"), primary_key=True)
    seq: Mapped[int] = mapped_column(Integer, primary_key=True)
    task_id: Mapped[str | None] = mapped_column(String(40))
    mode: Mapped[str] = mapped_column(String(20))
    label: Mapped[str] = mapped_column(String(80))
    leave_by: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    arrive_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    travel_min: Mapped[int] = mapped_column(Integer)
    wait_min: Mapped[int] = mapped_column(Integer)
    fare_inr: Mapped[int] = mapped_column(Integer)
    transit_ref: Mapped[dict | None] = mapped_column(JsonB)


class Checkin(Base):
    __tablename__ = "checkins"
    __table_args__ = (UniqueConstraint("trip_id", "idempotency_key", name="uq_checkins_idempotency"),)

    checkin_id: Mapped[str] = mapped_column(String(40), primary_key=True, default=lambda: new_id("chk"))
    trip_id: Mapped[str] = mapped_column(ForeignKey("trips.trip_id", ondelete="CASCADE"), index=True)
    task_id: Mapped[str] = mapped_column(ForeignKey("tasks.task_id", ondelete="CASCADE"))
    kind: Mapped[str] = mapped_column(String(10))
    delay_min: Mapped[int | None] = mapped_column(Integer)
    at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    idempotency_key: Mapped[str] = mapped_column(String(128))
    result: Mapped[dict | None] = mapped_column(JsonB)


class Booking(Base):
    """A simulated train ticket, flight or cab ride (a demo: nothing real is booked; the wallet's simulated money pays)."""

    __tablename__ = "bookings"

    booking_id: Mapped[str] = mapped_column(String(40), primary_key=True, default=lambda: new_id("bkg"))
    trip_id: Mapped[str] = mapped_column(ForeignKey("trips.trip_id", ondelete="CASCADE"), index=True)
    kind: Mapped[str] = mapped_column(String(10))
    #: The task a train ticket is for, or the stop a cab ride goes to (a task ID, or "end").
    task_id: Mapped[str | None] = mapped_column(String(40))
    to_id: Mapped[str | None] = mapped_column(String(40))
    provider: Mapped[str] = mapped_column(String(20))
    status: Mapped[str] = mapped_column(String(12), default="confirmed")
    reference: Mapped[str] = mapped_column(String(20))
    fare_inr: Mapped[int] = mapped_column(Integer)
    details: Mapped[dict] = mapped_column(JsonB)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class ShareLink(Base):
    __tablename__ = "share_links"

    share_id: Mapped[str] = mapped_column(String(40), primary_key=True, default=lambda: new_id("shr"))
    trip_id: Mapped[str] = mapped_column(ForeignKey("trips.trip_id", ondelete="CASCADE"), index=True)
    token_hash: Mapped[str] = mapped_column(String(64), unique=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    revoked_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


class RerouteLog(Base):
    __tablename__ = "reroute_log"

    log_id: Mapped[str] = mapped_column(String(40), primary_key=True, default=lambda: new_id("log"))
    trip_id: Mapped[str] = mapped_column(ForeignKey("trips.trip_id", ondelete="CASCADE"), index=True)
    at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    kind: Mapped[str] = mapped_column(String(20))
    text: Mapped[str] = mapped_column(Text)
    automatic: Mapped[bool] = mapped_column(Boolean, default=False)
    plan_id: Mapped[str | None] = mapped_column(String(40))
    previous_plan_id: Mapped[str | None] = mapped_column(String(40))
    reason_codes: Mapped[list[str]] = mapped_column(ARRAY(String(40)).with_variant(JSON(), "sqlite"), default=list)
    undone_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
