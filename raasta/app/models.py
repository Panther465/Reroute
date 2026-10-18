"""Raasta tables. Every table lives in the `raasta` schema; Reroute never reads them."""

from __future__ import annotations

from datetime import datetime, time

from geoalchemy2 import Geography
from sqlalchemy import Boolean, CheckConstraint, DateTime, Float, ForeignKey, Index, Integer, String, Text, Time, UniqueConstraint, func
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db import SCHEMA, Base

VEHICLE_TYPES = ("shared_auto", "e_rickshaw", "tempo")
ROUTE_STATUSES = ("unverified", "verified", "stale")
ROUTE_SOURCES = ("stands_tapped", "gps_ride", "import")
CONTRIBUTION_STATUSES = ("waiting", "verified", "rejected", "merged")
CONTRIBUTION_KINDS = ("stands_tapped", "gps_ride", "freshness_check")
FARE_REPORT_STATUSES = ("waiting", "accepted", "rejected")


def _in(column: str, values: tuple[str, ...]) -> str:
    return f"{column} IN ({', '.join(repr(v) for v in values)})"


class Stand(Base):
    __tablename__ = "stands"
    __table_args__ = (Index("ix_stands_location", "location", postgresql_using="gist"), {"schema": SCHEMA})

    stand_id: Mapped[str] = mapped_column(String(64), primary_key=True)
    city_slug: Mapped[str] = mapped_column(String(64), index=True)
    name: Mapped[str] = mapped_column(String(160))
    location = mapped_column(Geography(geometry_type="POINT", srid=4326, spatial_index=False), nullable=False)
    lng: Mapped[float] = mapped_column(Float)
    lat: Mapped[float] = mapped_column(Float)
    sample: Mapped[bool] = mapped_column(Boolean, default=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class Route(Base):
    __tablename__ = "routes"
    __table_args__ = (
        CheckConstraint(_in("vehicle_type", VEHICLE_TYPES), name="ck_routes_vehicle_type"),
        CheckConstraint(_in("status", ROUTE_STATUSES), name="ck_routes_status"),
        CheckConstraint(_in("source", ROUTE_SOURCES), name="ck_routes_source"),
        CheckConstraint("fare_inr BETWEEN 0 AND 2000", name="ck_routes_fare"),
        CheckConstraint("frequency_min BETWEEN 1 AND 180", name="ck_routes_frequency"),
        CheckConstraint("first_trip < last_trip", name="ck_routes_service_hours"),
        Index("ix_routes_city_status", "city_slug", "status"),
        Index("ix_routes_path", "path", postgresql_using="gist"),
        {"schema": SCHEMA},
    )

    route_id: Mapped[str] = mapped_column(String(64), primary_key=True)
    city_slug: Mapped[str] = mapped_column(String(64))
    path = mapped_column(Geography(geometry_type="LINESTRING", srid=4326, spatial_index=False), nullable=True)
    path_coords: Mapped[list | None] = mapped_column(JSONB, nullable=True)
    vehicle_type: Mapped[str] = mapped_column(String(16))
    fare_inr: Mapped[int] = mapped_column(Integer)
    frequency_min: Mapped[int] = mapped_column(Integer)
    first_trip: Mapped[time] = mapped_column(Time)
    last_trip: Mapped[time] = mapped_column(Time)
    status: Mapped[str] = mapped_column(String(16), default="unverified")
    status_changed_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    source: Mapped[str] = mapped_column(String(16))
    confidence: Mapped[float] = mapped_column(Float, default=0.5)
    last_confirmed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    contributor_id: Mapped[str | None] = mapped_column(String(64), nullable=True)
    sample: Mapped[bool] = mapped_column(Boolean, default=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())

    stands: Mapped[list[RouteStand]] = relationship(order_by="RouteStand.seq", cascade="all, delete-orphan", lazy="selectin")


class RouteStand(Base):
    __tablename__ = "route_stands"
    __table_args__ = (UniqueConstraint("route_id", "seq", name="uq_route_stands_seq"), {"schema": SCHEMA})

    route_id: Mapped[str] = mapped_column(ForeignKey(f"{SCHEMA}.routes.route_id", ondelete="CASCADE"), primary_key=True)
    seq: Mapped[int] = mapped_column(Integer, primary_key=True)
    stand_id: Mapped[str] = mapped_column(ForeignKey(f"{SCHEMA}.stands.stand_id"), index=True)

    stand: Mapped[Stand] = relationship(lazy="joined")


class Contribution(Base):
    __tablename__ = "contributions"
    __table_args__ = (
        CheckConstraint(_in("status", CONTRIBUTION_STATUSES), name="ck_contributions_status"),
        CheckConstraint(_in("kind", CONTRIBUTION_KINDS), name="ck_contributions_kind"),
        Index("ix_contributions_status_created", "status", "created_at"),
        {"schema": SCHEMA},
    )

    contribution_id: Mapped[str] = mapped_column(String(64), primary_key=True)
    contributor_id: Mapped[str | None] = mapped_column(String(64), nullable=True, index=True)
    kind: Mapped[str] = mapped_column(String(24))
    payload: Mapped[dict] = mapped_column(JSONB)
    status: Mapped[str] = mapped_column(String(16), default="waiting")
    reject_reason: Mapped[str | None] = mapped_column(Text, nullable=True)
    route_id: Mapped[str | None] = mapped_column(ForeignKey(f"{SCHEMA}.routes.route_id", ondelete="SET NULL"), nullable=True)
    decided_by: Mapped[str | None] = mapped_column(String(64), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    decided_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)


class Confirmation(Base):
    __tablename__ = "confirmations"
    __table_args__ = (Index("ix_confirmations_route_at", "route_id", "at"), {"schema": SCHEMA})

    confirmation_id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    route_id: Mapped[str] = mapped_column(ForeignKey(f"{SCHEMA}.routes.route_id", ondelete="CASCADE"))
    user_id: Mapped[str] = mapped_column(String(64))
    at: Mapped[datetime] = mapped_column(DateTime(timezone=True))


class FareReport(Base):
    __tablename__ = "fare_reports"
    __table_args__ = (
        CheckConstraint(_in("status", FARE_REPORT_STATUSES), name="ck_fare_reports_status"),
        CheckConstraint("fare_inr BETWEEN 0 AND 2000", name="ck_fare_reports_fare"),
        Index("ix_fare_reports_status_at", "status", "at"),
        Index("ix_fare_reports_route_at", "route_id", "at"),
        {"schema": SCHEMA},
    )

    fare_report_id: Mapped[str] = mapped_column(String(64), primary_key=True)
    route_id: Mapped[str] = mapped_column(ForeignKey(f"{SCHEMA}.routes.route_id", ondelete="CASCADE"))
    user_id: Mapped[str] = mapped_column(String(64))
    fare_inr: Mapped[int] = mapped_column(Integer)
    status: Mapped[str] = mapped_column(String(16), default="waiting")
    at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    decided_by: Mapped[str | None] = mapped_column(String(64), nullable=True)
    decided_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
