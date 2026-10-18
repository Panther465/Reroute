"""Raasta tables: stands, routes, route_stands, contributions, confirmations, fare_reports.

Revision ID: 0001_initial
Revises:
Create Date: 2026-10-18
"""

import sqlalchemy as sa
from alembic import op
from geoalchemy2 import Geography
from sqlalchemy.dialects import postgresql

revision = "0001_initial"
down_revision = None
branch_labels = None
depends_on = None

S = "raasta"


def upgrade() -> None:
    op.execute("CREATE EXTENSION IF NOT EXISTS postgis")
    op.execute(f"CREATE SCHEMA IF NOT EXISTS {S}")

    op.create_table(
        "stands",
        sa.Column("stand_id", sa.String(64), primary_key=True),
        sa.Column("city_slug", sa.String(64), nullable=False),
        sa.Column("name", sa.String(160), nullable=False),
        sa.Column("location", Geography(geometry_type="POINT", srid=4326, spatial_index=False), nullable=False),
        sa.Column("lng", sa.Float, nullable=False),
        sa.Column("lat", sa.Float, nullable=False),
        sa.Column("sample", sa.Boolean, nullable=False, server_default=sa.false()),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        schema=S,
    )
    op.create_index("ix_stands_city_slug", "stands", ["city_slug"], schema=S)
    op.create_index("ix_stands_location", "stands", ["location"], schema=S, postgresql_using="gist")

    op.create_table(
        "routes",
        sa.Column("route_id", sa.String(64), primary_key=True),
        sa.Column("city_slug", sa.String(64), nullable=False),
        sa.Column("path", Geography(geometry_type="LINESTRING", srid=4326, spatial_index=False), nullable=True),
        sa.Column("path_coords", postgresql.JSONB, nullable=True),
        sa.Column("vehicle_type", sa.String(16), nullable=False),
        sa.Column("fare_inr", sa.Integer, nullable=False),
        sa.Column("frequency_min", sa.Integer, nullable=False),
        sa.Column("first_trip", sa.Time, nullable=False),
        sa.Column("last_trip", sa.Time, nullable=False),
        sa.Column("status", sa.String(16), nullable=False, server_default="unverified"),
        sa.Column("status_changed_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.Column("source", sa.String(16), nullable=False),
        sa.Column("confidence", sa.Float, nullable=False, server_default="0.5"),
        sa.Column("last_confirmed_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("contributor_id", sa.String(64), nullable=True),
        sa.Column("sample", sa.Boolean, nullable=False, server_default=sa.false()),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.CheckConstraint("vehicle_type IN ('shared_auto', 'e_rickshaw', 'tempo')", name="ck_routes_vehicle_type"),
        sa.CheckConstraint("status IN ('unverified', 'verified', 'stale')", name="ck_routes_status"),
        sa.CheckConstraint("source IN ('stands_tapped', 'gps_ride', 'import')", name="ck_routes_source"),
        sa.CheckConstraint("fare_inr BETWEEN 0 AND 2000", name="ck_routes_fare"),
        sa.CheckConstraint("frequency_min BETWEEN 1 AND 180", name="ck_routes_frequency"),
        sa.CheckConstraint("first_trip < last_trip", name="ck_routes_service_hours"),
        schema=S,
    )
    op.create_index("ix_routes_city_status", "routes", ["city_slug", "status"], schema=S)
    op.create_index("ix_routes_path", "routes", ["path"], schema=S, postgresql_using="gist")

    op.create_table(
        "route_stands",
        sa.Column("route_id", sa.String(64), sa.ForeignKey(f"{S}.routes.route_id", ondelete="CASCADE"), primary_key=True),
        sa.Column("seq", sa.Integer, primary_key=True),
        sa.Column("stand_id", sa.String(64), sa.ForeignKey(f"{S}.stands.stand_id"), nullable=False),
        sa.UniqueConstraint("route_id", "seq", name="uq_route_stands_seq"),
        schema=S,
    )
    op.create_index("ix_route_stands_stand_id", "route_stands", ["stand_id"], schema=S)

    op.create_table(
        "contributions",
        sa.Column("contribution_id", sa.String(64), primary_key=True),
        sa.Column("contributor_id", sa.String(64), nullable=True),
        sa.Column("kind", sa.String(24), nullable=False),
        sa.Column("payload", postgresql.JSONB, nullable=False),
        sa.Column("status", sa.String(16), nullable=False, server_default="waiting"),
        sa.Column("reject_reason", sa.Text, nullable=True),
        sa.Column("route_id", sa.String(64), sa.ForeignKey(f"{S}.routes.route_id", ondelete="SET NULL"), nullable=True),
        sa.Column("decided_by", sa.String(64), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.Column("decided_at", sa.DateTime(timezone=True), nullable=True),
        sa.CheckConstraint("status IN ('waiting', 'verified', 'rejected', 'merged')", name="ck_contributions_status"),
        sa.CheckConstraint("kind IN ('stands_tapped', 'gps_ride', 'freshness_check')", name="ck_contributions_kind"),
        schema=S,
    )
    op.create_index("ix_contributions_status_created", "contributions", ["status", "created_at"], schema=S)
    op.create_index("ix_contributions_contributor_id", "contributions", ["contributor_id"], schema=S)

    op.create_table(
        "confirmations",
        sa.Column("confirmation_id", sa.Integer, primary_key=True, autoincrement=True),
        sa.Column("route_id", sa.String(64), sa.ForeignKey(f"{S}.routes.route_id", ondelete="CASCADE"), nullable=False),
        sa.Column("user_id", sa.String(64), nullable=False),
        sa.Column("at", sa.DateTime(timezone=True), nullable=False),
        schema=S,
    )
    op.create_index("ix_confirmations_route_at", "confirmations", ["route_id", "at"], schema=S)

    op.create_table(
        "fare_reports",
        sa.Column("fare_report_id", sa.String(64), primary_key=True),
        sa.Column("route_id", sa.String(64), sa.ForeignKey(f"{S}.routes.route_id", ondelete="CASCADE"), nullable=False),
        sa.Column("user_id", sa.String(64), nullable=False),
        sa.Column("fare_inr", sa.Integer, nullable=False),
        sa.Column("status", sa.String(16), nullable=False, server_default="waiting"),
        sa.Column("at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("decided_by", sa.String(64), nullable=True),
        sa.Column("decided_at", sa.DateTime(timezone=True), nullable=True),
        sa.CheckConstraint("status IN ('waiting', 'accepted', 'rejected')", name="ck_fare_reports_status"),
        sa.CheckConstraint("fare_inr BETWEEN 0 AND 2000", name="ck_fare_reports_fare"),
        schema=S,
    )
    op.create_index("ix_fare_reports_status_at", "fare_reports", ["status", "at"], schema=S)
    op.create_index("ix_fare_reports_route_at", "fare_reports", ["route_id", "at"], schema=S)


def downgrade() -> None:
    for table in ("fare_reports", "confirmations", "contributions", "route_stands", "routes", "stands"):
        op.drop_table(table, schema=S)
