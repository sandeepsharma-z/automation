"""add backlinks_discovered table

Revision ID: 20260310_0008
Revises: 20260226_0007
Create Date: 2026-03-10 10:00:00.000000
"""

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = '20260310_0008'
down_revision: Union[str, None] = '20260226_0007'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def _has_table(table: str) -> bool:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    return table in inspector.get_table_names()


def upgrade() -> None:
    if not _has_table('backlinks_discovered'):
        op.create_table(
            'backlinks_discovered',
            sa.Column('id', sa.Integer(), primary_key=True),
            sa.Column('source_url', sa.String(length=1024), nullable=False),
            sa.Column('target_url', sa.String(length=1024), nullable=False),
            sa.Column('anchor_text', sa.String(length=255), nullable=True),
            sa.Column('rel_type', sa.String(length=32), nullable=True),
            sa.Column('discovered_at', sa.DateTime(), nullable=False),
            sa.Column('domain_authority_placeholder', sa.Float(), nullable=True),
        )
        op.create_index('ix_backlinks_discovered_source_url', 'backlinks_discovered', ['source_url'], unique=False)
        op.create_index('ix_backlinks_discovered_target_url', 'backlinks_discovered', ['target_url'], unique=False)
        op.create_index('ix_backlinks_discovered_discovered_at', 'backlinks_discovered', ['discovered_at'], unique=False)


def downgrade() -> None:
    if _has_table('backlinks_discovered'):
        op.drop_index('ix_backlinks_discovered_discovered_at', table_name='backlinks_discovered')
        op.drop_index('ix_backlinks_discovered_target_url', table_name='backlinks_discovered')
        op.drop_index('ix_backlinks_discovered_source_url', table_name='backlinks_discovered')
        op.drop_table('backlinks_discovered')
