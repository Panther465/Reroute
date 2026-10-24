"""Places travellers add themselves: theirs alone, or everyone's once a moderator approves them.

Revision ID: 0008_own_places
Revises: 0007_push_devices
Create Date: 2026-10-25
"""

import sqlalchemy as sa
from alembic import op

revision = "0008_own_places"
down_revision = "0007_push_devices"
branch_labels = None
depends_on = None

TS = sa.DateTime(timezone=True)


def upgrade() -> None:
    # A traveller's own place is a place like any other, so a task or a stay can go there.
    op.add_column("places", sa.Column("owner_id", sa.String(40), sa.ForeignKey("users.user_id", ondelete="CASCADE"), nullable=True))
    op.add_column("places", sa.Column("category", sa.String(10), nullable=True))
    # The owner's own note: nobody else sees it, moderators included.
    op.add_column("places", sa.Column("note", sa.String(280), nullable=True))
    op.add_column("places", sa.Column("status", sa.String(10), nullable=True))
    op.add_column("places", sa.Column("reject_reason", sa.String(200), nullable=True))
    op.add_column("places", sa.Column("reviewed_by", sa.String(40), sa.ForeignKey("users.user_id", ondelete="SET NULL"), nullable=True))
    op.add_column("places", sa.Column("reviewed_at", TS, nullable=True))
    op.add_column("places", sa.Column("created_at", TS, nullable=False, server_default=sa.func.now()))
    op.create_index("ix_places_owner_id", "places", ["owner_id"])
    # The moderators' queue: shared places waiting for a decision.
    op.create_index("ix_places_waiting", "places", ["created_at"], postgresql_where=sa.text("status = 'pending'"))
    op.create_check_constraint("ck_places_category", "places", "category IS NULL OR category IN ('food', 'stay', 'sight', 'shop', 'transit', 'other')")
    op.create_check_constraint("ck_places_status", "places", "status IS NULL OR status IN ('private', 'pending', 'approved', 'rejected', 'deleted')")
    # A place a traveller added has both; no other place has either.
    op.create_check_constraint("ck_places_added", "places", "(category IS NULL) = (status IS NULL)")
    # Only a place other travellers could once find outlives its owner, in their trips.
    op.create_check_constraint("ck_places_owner", "places", "status IS NULL OR owner_id IS NOT NULL OR status IN ('approved', 'rejected', 'deleted')")

    # Deleting an account deletes the places it added, except those other travellers' trips go to: they stay
    # for those trips without their owner or note (a task's place can't be deleted from under it).
    op.execute(
        """
        CREATE FUNCTION places_outlive_owner() RETURNS trigger AS $$
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
    op.execute("CREATE TRIGGER trg_users_places BEFORE DELETE ON users FOR EACH ROW EXECUTE FUNCTION places_outlive_owner()")


def downgrade() -> None:
    op.execute("DROP TRIGGER IF EXISTS trg_users_places ON users")
    op.execute("DROP FUNCTION IF EXISTS places_outlive_owner()")
    # Without these columns every place is everyone's: remove the ones travellers added that no trip goes to.
    op.execute(
        "DELETE FROM places p WHERE p.status IS NOT NULL"
        " AND NOT EXISTS (SELECT 1 FROM tasks t WHERE t.place_id = p.place_id)"
        " AND NOT EXISTS (SELECT 1 FROM trips r WHERE r.stay_place_id = p.place_id)"
    )
    for name in ("ck_places_owner", "ck_places_added", "ck_places_status", "ck_places_category"):
        op.drop_constraint(name, "places", type_="check")
    op.drop_index("ix_places_waiting", table_name="places")
    op.drop_index("ix_places_owner_id", table_name="places")
    for column in ("created_at", "reviewed_at", "reviewed_by", "reject_reason", "status", "note", "category", "owner_id"):
        op.drop_column("places", column)
