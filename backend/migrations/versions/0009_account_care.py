"""Looking after an account: verifying its email, resetting its password by email, and deleting it.

Revision ID: 0009_account_care
Revises: 0008_own_places
Create Date: 2026-11-23
"""

import sqlalchemy as sa
from alembic import op

revision = "0009_account_care"
down_revision = "0008_own_places"
branch_labels = None
depends_on = None

TS = sa.DateTime(timezone=True)


def upgrade() -> None:
    op.add_column("users", sa.Column("email_verified_at", TS, nullable=True))
    op.add_column("users", sa.Column("password_changed_at", TS, nullable=True))
    # Google checked the address of everyone who signed in with it, and the demo accounts are ours.
    op.execute("UPDATE users SET email_verified_at = created_at WHERE google_sub IS NOT NULL OR is_demo")

    op.create_table(
        "email_tokens",
        sa.Column("token_id", sa.String(40), primary_key=True),
        sa.Column("user_id", sa.String(40), sa.ForeignKey("users.user_id", ondelete="CASCADE"), nullable=False),
        sa.Column("purpose", sa.String(10), nullable=False),
        sa.Column("token_hash", sa.String(64), nullable=False, unique=True),
        sa.Column("email", sa.String(320), nullable=False),
        sa.Column("expires_at", TS, nullable=False),
        sa.Column("used_at", TS, nullable=True),
        sa.Column("created_at", TS, nullable=False, server_default=sa.func.now()),
        sa.CheckConstraint("purpose IN ('verify', 'reset')", name="ck_email_tokens_purpose"),
    )
    op.create_index("ix_email_tokens_user_id", "email_tokens", ["user_id"])

    # A place a moderator approved is everyone's now: it outlives its owner too, without its note.
    op.execute(
        """
        CREATE OR REPLACE FUNCTION places_outlive_owner() RETURNS trigger AS $$
        BEGIN
          UPDATE places p SET owner_id = NULL, note = NULL
           WHERE p.owner_id = OLD.user_id
             AND (p.status = 'approved'
               OR EXISTS (SELECT 1 FROM tasks t JOIN trips r ON r.trip_id = t.trip_id WHERE t.place_id = p.place_id AND r.user_id <> OLD.user_id)
               OR EXISTS (SELECT 1 FROM trips r WHERE r.stay_place_id = p.place_id AND r.user_id <> OLD.user_id));
          RETURN OLD;
        END;
        $$ LANGUAGE plpgsql;
        """
    )


def downgrade() -> None:
    op.execute(
        """
        CREATE OR REPLACE FUNCTION places_outlive_owner() RETURNS trigger AS $$
        BEGIN
          UPDATE places p SET owner_id = NULL, note = NULL
           WHERE p.owner_id = OLD.user_id
             AND (EXISTS (SELECT 1 FROM tasks t JOIN trips r ON r.trip_id = t.trip_id WHERE t.place_id = p.place_id AND r.user_id <> OLD.user_id)
               OR EXISTS (SELECT 1 FROM trips r WHERE r.stay_place_id = p.place_id AND r.user_id <> OLD.user_id));
          RETURN OLD;
        END;
        $$ LANGUAGE plpgsql;
        """
    )
    op.drop_index("ix_email_tokens_user_id", table_name="email_tokens")
    op.drop_table("email_tokens")
    op.drop_column("users", "password_changed_at")
    op.drop_column("users", "email_verified_at")
