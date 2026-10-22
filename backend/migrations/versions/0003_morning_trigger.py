"""Plans made by the morning run: the plan trigger may be 'morning'.

Revision ID: 0003_morning_trigger
Revises: 0002_bookings
Create Date: 2026-10-22
"""

from alembic import op

revision = "0003_morning_trigger"
down_revision = "0002_bookings"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.drop_constraint("ck_plans_trigger", "plans", type_="check")
    op.create_check_constraint("ck_plans_trigger", "plans", "trigger IN ('created', 'late', 'skipped', 'edited', 'morning')")


def downgrade() -> None:
    # Morning plans become 'created' ones: the trigger column is the one part of a plan that may change here.
    op.execute("ALTER TABLE plans DISABLE TRIGGER trg_plans_immutable")
    op.execute("UPDATE plans SET trigger = 'created' WHERE trigger = 'morning'")
    op.execute("ALTER TABLE plans ENABLE TRIGGER trg_plans_immutable")
    op.drop_constraint("ck_plans_trigger", "plans", type_="check")
    op.create_check_constraint("ck_plans_trigger", "plans", "trigger IN ('created', 'late', 'skipped', 'edited')")
