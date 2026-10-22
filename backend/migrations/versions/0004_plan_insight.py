"""Why this plan: each plan keeps the choices the planner weighed.

Revision ID: 0004_plan_insight
Revises: 0003_morning_trigger
Create Date: 2026-10-22
"""

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision = "0004_plan_insight"
down_revision = "0003_morning_trigger"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # Older plans have none: the app says so instead of inventing one.
    op.add_column("plans", sa.Column("insight", postgresql.JSONB, nullable=True))


def downgrade() -> None:
    op.drop_column("plans", "insight")
