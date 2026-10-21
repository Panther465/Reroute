"""Simulated bookings: train tickets and cab rides (a demo; nothing real is booked).

Revision ID: 0002_bookings
Revises: 0001_initial
Create Date: 2026-10-21
"""

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision = "0002_bookings"
down_revision = "0001_initial"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "bookings",
        sa.Column("booking_id", sa.String(40), primary_key=True),
        sa.Column("trip_id", sa.String(40), sa.ForeignKey("trips.trip_id", ondelete="CASCADE"), nullable=False, index=True),
        sa.Column("kind", sa.String(10), nullable=False),
        sa.Column("task_id", sa.String(40)),
        sa.Column("to_id", sa.String(40)),
        sa.Column("provider", sa.String(20), nullable=False),
        sa.Column("status", sa.String(12), nullable=False, server_default="confirmed"),
        sa.Column("reference", sa.String(20), nullable=False),
        sa.Column("fare_inr", sa.Integer, nullable=False),
        sa.Column("details", postgresql.JSONB, nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
    )


def downgrade() -> None:
    op.drop_table("bookings")
