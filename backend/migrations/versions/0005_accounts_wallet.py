"""Accounts with a password, and a simulated wallet that pays for simulated bookings.

Revision ID: 0005_accounts_wallet
Revises: 0004_plan_insight
Create Date: 2026-10-22
"""

import sqlalchemy as sa
from alembic import op

revision = "0005_accounts_wallet"
down_revision = "0004_plan_insight"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # Only a scrypt hash is stored. One password account per email address, whatever its case.
    op.add_column("users", sa.Column("password_hash", sa.Text, nullable=True))
    op.create_index("uq_users_password_email", "users", [sa.text("lower(email)")], unique=True, postgresql_where=sa.text("password_hash IS NOT NULL"))
    op.create_table(
        "wallet_entries",
        sa.Column("entry_id", sa.String(40), primary_key=True),
        sa.Column("user_id", sa.String(40), sa.ForeignKey("users.user_id", ondelete="CASCADE"), nullable=False, index=True),
        # Money in is positive, a booking is negative; the balance is the sum.
        sa.Column("amount_inr", sa.Integer, nullable=False),
        sa.Column("kind", sa.String(12), nullable=False),
        sa.Column("label", sa.String(200), nullable=False),
        sa.Column("booking_id", sa.String(40), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.CheckConstraint("kind IN ('welcome', 'topup', 'booking', 'refund')", name="ck_wallet_entries_kind"),
    )


def downgrade() -> None:
    op.drop_table("wallet_entries")
    op.drop_index("uq_users_password_email", table_name="users")
    op.drop_column("users", "password_hash")
