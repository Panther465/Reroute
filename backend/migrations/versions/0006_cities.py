"""Cities beyond Bengaluru: any Indian city or town, kept the first time someone picks it.

Revision ID: 0006_cities
Revises: 0005_accounts_wallet
Create Date: 2026-10-22
"""

import sqlalchemy as sa
from alembic import op

revision = "0006_cities"
down_revision = "0005_accounts_wallet"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "cities",
        sa.Column("slug", sa.String(40), primary_key=True),
        sa.Column("name", sa.String(80), nullable=False),
        sa.Column("state", sa.String(80), nullable=True),
        sa.Column("utc_offset", sa.String(6), nullable=False, server_default="+05:30"),
        # west, south, east, north: the area place search and trips stay inside.
        sa.Column("west", sa.Float, nullable=False),
        sa.Column("south", sa.Float, nullable=False),
        sa.Column("east", sa.Float, nullable=False),
        sa.Column("north", sa.Float, nullable=False),
        sa.Column("osm_id", sa.String(40), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.CheckConstraint("west < east AND south < north", name="ck_cities_area"),
    )


def downgrade() -> None:
    op.drop_table("cities")
