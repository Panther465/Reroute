"""Phones that get the traveller's alerts as push notifications (the Android app, through Firebase).

Revision ID: 0007_push_devices
Revises: 0006_cities
Create Date: 2026-10-24
"""

import sqlalchemy as sa
from alembic import op

revision = "0007_push_devices"
down_revision = "0006_cities"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "push_devices",
        # The SHA-256 of the Firebase token: one row per phone, whoever registered it last.
        sa.Column("device_id", sa.String(64), primary_key=True),
        sa.Column("user_id", sa.String(40), sa.ForeignKey("users.user_id", ondelete="CASCADE"), nullable=False, index=True),
        # The sign-in that registered it (refresh token family): ending that sign-in forgets the phone.
        sa.Column("family_id", sa.String(40), nullable=True, index=True),
        sa.Column("token", sa.Text, nullable=False),
        sa.Column("platform", sa.String(12), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.Column("last_seen_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.CheckConstraint("platform IN ('android')", name="ck_push_devices_platform"),
    )


def downgrade() -> None:
    op.drop_table("push_devices")
