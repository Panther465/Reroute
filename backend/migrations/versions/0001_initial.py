"""Initial Reroute tables, with plan immutability enforced in the database.

Revision ID: 0001_initial
Revises:
Create Date: 2026-10-18
"""

import geoalchemy2
import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision = "0001_initial"
down_revision = None
branch_labels = None
depends_on = None

TS = sa.DateTime(timezone=True)


def upgrade() -> None:
    op.execute("CREATE EXTENSION IF NOT EXISTS postgis")

    op.create_table(
        "users",
        sa.Column("user_id", sa.String(40), primary_key=True),
        sa.Column("google_sub", sa.String(255), unique=True),
        sa.Column("email", sa.String(320), nullable=False),
        sa.Column("name", sa.String(200), nullable=False),
        sa.Column("role", sa.String(20), nullable=False, server_default="traveller"),
        sa.Column("is_demo", sa.Boolean, nullable=False, server_default=sa.false()),
        sa.Column("created_at", TS, nullable=False, server_default=sa.func.now()),
        sa.CheckConstraint("role IN ('traveller', 'moderator', 'admin')", name="ck_users_role"),
    )
    op.create_table(
        "refresh_tokens",
        sa.Column("token_id", sa.String(40), primary_key=True),
        sa.Column("user_id", sa.String(40), sa.ForeignKey("users.user_id", ondelete="CASCADE"), nullable=False, index=True),
        sa.Column("family_id", sa.String(40), nullable=False, index=True),
        sa.Column("token_hash", sa.String(64), nullable=False, unique=True),
        sa.Column("expires_at", TS, nullable=False),
        sa.Column("revoked_at", TS),
        sa.Column("created_at", TS, nullable=False, server_default=sa.func.now()),
    )
    op.create_table(
        "places",
        sa.Column("place_id", sa.String(80), primary_key=True),
        sa.Column("city_slug", sa.String(40), nullable=False, index=True),
        sa.Column("name", sa.String(200), nullable=False),
        sa.Column("area", sa.String(120), nullable=False),
        sa.Column("location", geoalchemy2.Geography(geometry_type="POINT", srid=4326), nullable=False),
        sa.Column("lng", sa.Float, nullable=False),
        sa.Column("lat", sa.Float, nullable=False),
        sa.Column("osm_id", sa.String(40)),
        sa.Column("sample", sa.Boolean, nullable=False, server_default=sa.false()),
    )
    op.create_table(
        "trips",
        sa.Column("trip_id", sa.String(40), primary_key=True),
        sa.Column("user_id", sa.String(40), sa.ForeignKey("users.user_id", ondelete="CASCADE"), nullable=False, index=True),
        sa.Column("city_slug", sa.String(40), nullable=False),
        sa.Column("city_name", sa.String(80), nullable=False),
        sa.Column("start_date", sa.Date, nullable=False),
        sa.Column("end_date", sa.Date, nullable=False),
        sa.Column("utc_offset", sa.String(6), nullable=False, server_default="+05:30"),
        sa.Column("stay_place_id", sa.String(80), sa.ForeignKey("places.place_id"), nullable=False),
        sa.Column("stay_label", sa.String(200), nullable=False),
        sa.Column("sample", sa.Boolean, nullable=False, server_default=sa.false()),
        sa.Column("created_at", TS, nullable=False, server_default=sa.func.now()),
        sa.CheckConstraint("end_date >= start_date", name="ck_trips_dates"),
    )
    op.create_table(
        "tasks",
        sa.Column("task_id", sa.String(40), primary_key=True),
        sa.Column("trip_id", sa.String(40), sa.ForeignKey("trips.trip_id", ondelete="CASCADE"), nullable=False, index=True),
        sa.Column("title", sa.String(120), nullable=False),
        sa.Column("place_id", sa.String(80), sa.ForeignKey("places.place_id"), nullable=False),
        sa.Column("duration_min", sa.Integer, nullable=False),
        sa.Column("fixed_start", TS),
        sa.Column("opens_at", sa.String(5)),
        sa.Column("closes_at", sa.String(5)),
        sa.Column("day", sa.Date, nullable=False),
        sa.Column("planned_day", sa.Date, nullable=False),
        sa.Column("changed_by_plan_id", sa.String(40)),
        sa.Column("priority", sa.Integer, nullable=False, server_default="2"),
        sa.Column("state", sa.String(20), nullable=False, server_default="planned"),
        sa.Column("hours_unknown", sa.Boolean, nullable=False, server_default=sa.false()),
        sa.Column("created_at", TS, nullable=False, server_default=sa.func.now()),
        sa.Column("updated_at", TS, nullable=False, server_default=sa.func.now()),
        sa.CheckConstraint("duration_min BETWEEN 0 AND 720", name="ck_tasks_duration"),
        sa.CheckConstraint("priority BETWEEN 1 AND 3", name="ck_tasks_priority"),
        sa.CheckConstraint("state IN ('planned', 'in_progress', 'done', 'skipped', 'moved')", name="ck_tasks_state"),
        sa.CheckConstraint("NOT (fixed_start IS NOT NULL AND opens_at IS NOT NULL)", name="ck_tasks_one_timing"),
    )
    op.create_table(
        "plans",
        sa.Column("plan_id", sa.String(40), primary_key=True),
        sa.Column("trip_id", sa.String(40), sa.ForeignKey("trips.trip_id", ondelete="CASCADE"), nullable=False, index=True),
        sa.Column("day", sa.Date, nullable=False),
        sa.Column("version", sa.Integer),
        sa.Column("status", sa.String(20), nullable=False),
        sa.Column("trigger", sa.String(20), nullable=False),
        sa.Column("checkin_id", sa.String(40)),
        sa.Column("inputs_hash", sa.String(64), nullable=False),
        sa.Column("rule_version", sa.String(10), nullable=False),
        sa.Column("travel_time_snapshot_id", sa.String(80), nullable=False),
        sa.Column("inputs", postgresql.JSONB, nullable=False),
        sa.Column("legs", postgresql.JSONB, nullable=False),
        sa.Column("done_legs", postgresql.JSONB, nullable=False, server_default="[]"),
        sa.Column("moved", postgresql.JSONB, nullable=False, server_default="[]"),
        sa.Column("travel_min", sa.Integer, nullable=False),
        sa.Column("fare_inr", sa.Integer, nullable=False),
        sa.Column("wait_min", sa.Integer, nullable=False),
        sa.Column("cost", sa.Float, nullable=False),
        sa.Column("reason_codes", postgresql.ARRAY(sa.String(40)), nullable=False),
        sa.Column("explanation", sa.Text, nullable=False),
        sa.Column("approximate", sa.Boolean, nullable=False, server_default=sa.false()),
        sa.Column("option_set_id", sa.String(40), index=True),
        sa.Column("option_id", sa.String(20)),
        sa.Column("option", postgresql.JSONB),
        sa.Column("created_at", TS, nullable=False, server_default=sa.func.now()),
        sa.Column("activated_at", TS),
        sa.UniqueConstraint("trip_id", "version", name="uq_plans_trip_version"),
        sa.CheckConstraint("status IN ('proposed', 'active', 'superseded')", name="ck_plans_status"),
        sa.CheckConstraint("trigger IN ('created', 'late', 'skipped', 'edited')", name="ck_plans_trigger"),
        sa.CheckConstraint("status = 'proposed' OR version IS NOT NULL OR activated_at IS NULL", name="ck_plans_version_when_active"),
    )
    op.create_index("uq_plans_one_active", "plans", ["trip_id"], unique=True, postgresql_where=sa.text("status = 'active'"))
    op.create_table(
        "plan_legs",
        sa.Column("plan_id", sa.String(40), sa.ForeignKey("plans.plan_id", ondelete="CASCADE"), primary_key=True),
        sa.Column("seq", sa.Integer, primary_key=True),
        sa.Column("task_id", sa.String(40)),
        sa.Column("mode", sa.String(20), nullable=False),
        sa.Column("label", sa.String(80), nullable=False),
        sa.Column("leave_by", TS, nullable=False),
        sa.Column("arrive_at", TS, nullable=False),
        sa.Column("travel_min", sa.Integer, nullable=False),
        sa.Column("wait_min", sa.Integer, nullable=False),
        sa.Column("fare_inr", sa.Integer, nullable=False),
        sa.Column("transit_ref", postgresql.JSONB),
    )
    op.create_table(
        "checkins",
        sa.Column("checkin_id", sa.String(40), primary_key=True),
        sa.Column("trip_id", sa.String(40), sa.ForeignKey("trips.trip_id", ondelete="CASCADE"), nullable=False, index=True),
        sa.Column("task_id", sa.String(40), sa.ForeignKey("tasks.task_id", ondelete="CASCADE"), nullable=False),
        sa.Column("kind", sa.String(10), nullable=False),
        sa.Column("delay_min", sa.Integer),
        sa.Column("at", TS, nullable=False),
        sa.Column("idempotency_key", sa.String(128), nullable=False),
        sa.Column("result", postgresql.JSONB),
        sa.UniqueConstraint("trip_id", "idempotency_key", name="uq_checkins_idempotency"),
        sa.CheckConstraint("kind IN ('done', 'skipped', 'delay')", name="ck_checkins_kind"),
    )
    op.create_table(
        "share_links",
        sa.Column("share_id", sa.String(40), primary_key=True),
        sa.Column("trip_id", sa.String(40), sa.ForeignKey("trips.trip_id", ondelete="CASCADE"), nullable=False, index=True),
        sa.Column("token_hash", sa.String(64), nullable=False, unique=True),
        sa.Column("created_at", TS, nullable=False, server_default=sa.func.now()),
        sa.Column("expires_at", TS, nullable=False),
        sa.Column("revoked_at", TS),
    )
    op.create_table(
        "reroute_log",
        sa.Column("log_id", sa.String(40), primary_key=True),
        sa.Column("trip_id", sa.String(40), sa.ForeignKey("trips.trip_id", ondelete="CASCADE"), nullable=False, index=True),
        sa.Column("at", TS, nullable=False),
        sa.Column("kind", sa.String(20), nullable=False),
        sa.Column("text", sa.Text, nullable=False),
        sa.Column("automatic", sa.Boolean, nullable=False, server_default=sa.false()),
        sa.Column("plan_id", sa.String(40)),
        sa.Column("previous_plan_id", sa.String(40)),
        sa.Column("reason_codes", postgresql.ARRAY(sa.String(40)), nullable=False, server_default="{}"),
        sa.Column("undone_at", TS),
    )

    # A plan's content is never edited: only status, activated_at, and a version set once on acceptance.
    op.execute(
        """
        CREATE FUNCTION plans_immutable() RETURNS trigger AS $$
        BEGIN
          IF (NEW.plan_id, NEW.trip_id, NEW.day, NEW.trigger, NEW.checkin_id, NEW.inputs_hash, NEW.rule_version,
              NEW.travel_time_snapshot_id, NEW.inputs, NEW.legs, NEW.done_legs, NEW.moved, NEW.travel_min, NEW.fare_inr,
              NEW.wait_min, NEW.cost, NEW.reason_codes, NEW.explanation, NEW.approximate, NEW.option_set_id,
              NEW.option_id, NEW.option, NEW.created_at)
             IS DISTINCT FROM
             (OLD.plan_id, OLD.trip_id, OLD.day, OLD.trigger, OLD.checkin_id, OLD.inputs_hash, OLD.rule_version,
              OLD.travel_time_snapshot_id, OLD.inputs, OLD.legs, OLD.done_legs, OLD.moved, OLD.travel_min, OLD.fare_inr,
              OLD.wait_min, OLD.cost, OLD.reason_codes, OLD.explanation, OLD.approximate, OLD.option_set_id,
              OLD.option_id, OLD.option, OLD.created_at) THEN
            RAISE EXCEPTION 'plan % is immutable; only its status can change', OLD.plan_id USING ERRCODE = 'check_violation';
          END IF;
          IF OLD.version IS NOT NULL AND NEW.version IS DISTINCT FROM OLD.version THEN
            RAISE EXCEPTION 'plan % already has version %', OLD.plan_id, OLD.version USING ERRCODE = 'check_violation';
          END IF;
          RETURN NEW;
        END;
        $$ LANGUAGE plpgsql;
        """
    )
    op.execute("CREATE TRIGGER trg_plans_immutable BEFORE UPDATE ON plans FOR EACH ROW EXECUTE FUNCTION plans_immutable()")
    op.execute(
        """
        CREATE FUNCTION plan_legs_immutable() RETURNS trigger AS $$
        BEGIN
          RAISE EXCEPTION 'plan legs are immutable' USING ERRCODE = 'check_violation';
        END;
        $$ LANGUAGE plpgsql;
        """
    )
    op.execute("CREATE TRIGGER trg_plan_legs_immutable BEFORE UPDATE ON plan_legs FOR EACH ROW EXECUTE FUNCTION plan_legs_immutable()")


def downgrade() -> None:
    op.execute("DROP TRIGGER IF EXISTS trg_plan_legs_immutable ON plan_legs")
    op.execute("DROP FUNCTION IF EXISTS plan_legs_immutable()")
    op.execute("DROP TRIGGER IF EXISTS trg_plans_immutable ON plans")
    op.execute("DROP FUNCTION IF EXISTS plans_immutable()")
    for table in ("reroute_log", "share_links", "checkins", "plan_legs", "plans", "tasks", "trips", "places", "refresh_tokens", "users"):
        op.drop_table(table)
