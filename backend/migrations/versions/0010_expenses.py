"""The expense manager: expenses (by hand, from a receipt, a booking or the plan), receipts, budgets and claims.

Revision ID: 0010_expenses
Revises: 0009_account_care
Create Date: 2026-11-24
"""

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import JSONB

revision = "0010_expenses"
down_revision = "0009_account_care"
branch_labels = None
depends_on = None

TS = sa.DateTime(timezone=True)
CATEGORIES = "('transport', 'stay', 'food', 'tickets', 'communication', 'office', 'client', 'other')"


def upgrade() -> None:
    op.create_table(
        "expense_claims",
        sa.Column("claim_id", sa.String(40), primary_key=True),
        sa.Column("trip_id", sa.String(40), sa.ForeignKey("trips.trip_id", ondelete="CASCADE"), nullable=False),
        sa.Column("reference", sa.String(20), nullable=False, unique=True),
        sa.Column("status", sa.String(12), nullable=False, server_default="submitted"),
        sa.Column("total_paise", sa.Integer, nullable=False),
        sa.Column("submitted_at", TS, nullable=False, server_default=sa.func.now()),
        sa.Column("reimbursed_at", TS, nullable=True),
        sa.CheckConstraint("status IN ('submitted', 'reimbursed')", name="ck_expense_claims_status"),
    )
    op.create_index("ix_expense_claims_trip_id", "expense_claims", ["trip_id"])

    op.create_table(
        "expenses",
        sa.Column("expense_id", sa.String(40), primary_key=True),
        sa.Column("trip_id", sa.String(40), sa.ForeignKey("trips.trip_id", ondelete="CASCADE"), nullable=False),
        sa.Column("day", sa.Date, nullable=False),
        sa.Column("category", sa.String(16), nullable=False),
        sa.Column("title", sa.String(120), nullable=False),
        sa.Column("merchant", sa.String(80), nullable=True),
        sa.Column("note", sa.String(500), nullable=True),
        sa.Column("amount_paise", sa.Integer, nullable=False),
        sa.Column("tax_paise", sa.Integer, nullable=True),
        sa.Column("gstin", sa.String(15), nullable=True),
        sa.Column("payment", sa.String(10), nullable=False),
        sa.Column("reimbursable", sa.Boolean, nullable=False, server_default=sa.true()),
        sa.Column("source", sa.String(10), nullable=False, server_default="manual"),
        sa.Column("source_ref", sa.String(160), nullable=True),
        sa.Column("estimate", sa.Boolean, nullable=False, server_default=sa.false()),
        sa.Column("edited", sa.Boolean, nullable=False, server_default=sa.false()),
        sa.Column("dismissed", sa.Boolean, nullable=False, server_default=sa.false()),
        sa.Column("claim_id", sa.String(40), sa.ForeignKey("expense_claims.claim_id", ondelete="SET NULL"), nullable=True),
        sa.Column("created_at", TS, nullable=False, server_default=sa.func.now()),
        sa.Column("updated_at", TS, nullable=False, server_default=sa.func.now()),
        sa.CheckConstraint(f"category IN {CATEGORIES}", name="ck_expenses_category"),
        sa.CheckConstraint("payment IN ('cash', 'card', 'upi', 'wallet', 'company')", name="ck_expenses_payment"),
        sa.CheckConstraint("source IN ('manual', 'receipt', 'booking', 'plan')", name="ck_expenses_source"),
        sa.CheckConstraint("amount_paise >= 0 AND amount_paise <= 100000000", name="ck_expenses_amount"),
        sa.CheckConstraint("tax_paise IS NULL OR (tax_paise >= 0 AND tax_paise <= amount_paise)", name="ck_expenses_tax"),
    )
    op.create_index("ix_expenses_trip_id", "expenses", ["trip_id"])
    op.create_index("ix_expenses_claim_id", "expenses", ["claim_id"])
    # One expense per booking or plan leg, so keeping them in step never makes two.
    op.create_index("uq_expenses_source", "expenses", ["trip_id", "source_ref"], unique=True, postgresql_where=sa.text("source_ref IS NOT NULL"))

    op.create_table(
        "expense_receipts",
        sa.Column("expense_id", sa.String(40), sa.ForeignKey("expenses.expense_id", ondelete="CASCADE"), primary_key=True),
        sa.Column("content_type", sa.String(20), nullable=False),
        sa.Column("data", sa.LargeBinary, nullable=False),
        sa.Column("size", sa.Integer, nullable=False),
        sa.Column("created_at", TS, nullable=False, server_default=sa.func.now()),
    )

    op.create_table(
        "expense_budgets",
        sa.Column("trip_id", sa.String(40), sa.ForeignKey("trips.trip_id", ondelete="CASCADE"), primary_key=True),
        sa.Column("total_paise", sa.Integer, nullable=True),
        sa.Column("daily_paise", sa.Integer, nullable=True),
        sa.Column("category_daily_paise", JSONB, nullable=False, server_default=sa.text("'{}'::jsonb")),
        sa.Column("receipt_over_paise", sa.Integer, nullable=False, server_default="50000"),
        sa.Column("updated_at", TS, nullable=False, server_default=sa.func.now()),
    )


def downgrade() -> None:
    op.drop_table("expense_budgets")
    op.drop_table("expense_receipts")
    op.drop_index("uq_expenses_source", table_name="expenses")
    op.drop_index("ix_expenses_claim_id", table_name="expenses")
    op.drop_index("ix_expenses_trip_id", table_name="expenses")
    op.drop_table("expenses")
    op.drop_index("ix_expense_claims_trip_id", table_name="expense_claims")
    op.drop_table("expense_claims")
