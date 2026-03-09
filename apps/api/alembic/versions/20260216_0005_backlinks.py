"""add backlinks module tables

Revision ID: 20260216_0005
Revises: 20260211_0004
Create Date: 2026-02-16 10:00:00.000000
"""

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = '20260216_0005'
down_revision: Union[str, None] = '20260211_0004'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def _has_table(table: str) -> bool:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    return table in inspector.get_table_names()


def upgrade() -> None:
    if not _has_table('backlink_campaigns'):
        op.create_table(
            'backlink_campaigns',
            sa.Column('id', sa.Integer(), primary_key=True),
            sa.Column('project_id', sa.Integer(), sa.ForeignKey('projects.id', ondelete='CASCADE'), nullable=False),
            sa.Column('name', sa.String(length=255), nullable=False),
            sa.Column('website_url', sa.String(length=1024), nullable=False),
            sa.Column('business_name', sa.String(length=255), nullable=True),
            sa.Column('contact_email', sa.String(length=255), nullable=True),
            sa.Column('phone', sa.String(length=64), nullable=True),
            sa.Column('address', sa.String(length=512), nullable=True),
            sa.Column('profile_notes', sa.Text(), nullable=True),
            sa.Column('status', sa.String(length=32), nullable=False),
            sa.Column('created_at', sa.DateTime(), nullable=False),
            sa.Column('updated_at', sa.DateTime(), nullable=False),
        )
        op.create_index('ix_backlink_campaigns_project_id', 'backlink_campaigns', ['project_id'], unique=False)

    if not _has_table('backlink_targets'):
        op.create_table(
            'backlink_targets',
            sa.Column('id', sa.Integer(), primary_key=True),
            sa.Column(
                'campaign_id',
                sa.Integer(),
                sa.ForeignKey('backlink_campaigns.id', ondelete='CASCADE'),
                nullable=False,
            ),
            sa.Column('target_url', sa.String(length=1024), nullable=False),
            sa.Column('anchor_text', sa.String(length=255), nullable=True),
            sa.Column('notes', sa.Text(), nullable=True),
            sa.Column('priority', sa.Integer(), nullable=False),
            sa.Column('created_at', sa.DateTime(), nullable=False),
            sa.Column('updated_at', sa.DateTime(), nullable=False),
        )
        op.create_index('ix_backlink_targets_campaign_id', 'backlink_targets', ['campaign_id'], unique=False)

    if not _has_table('backlink_opportunities'):
        op.create_table(
            'backlink_opportunities',
            sa.Column('id', sa.Integer(), primary_key=True),
            sa.Column(
                'campaign_id',
                sa.Integer(),
                sa.ForeignKey('backlink_campaigns.id', ondelete='CASCADE'),
                nullable=False,
            ),
            sa.Column(
                'target_id',
                sa.Integer(),
                sa.ForeignKey('backlink_targets.id', ondelete='SET NULL'),
                nullable=True,
            ),
            sa.Column('domain', sa.String(length=255), nullable=False),
            sa.Column('source_url', sa.String(length=1024), nullable=True),
            sa.Column('source_type', sa.String(length=64), nullable=False),
            sa.Column('profile_title', sa.String(length=255), nullable=True),
            sa.Column('profile_description', sa.Text(), nullable=True),
            sa.Column('suggested_anchor', sa.String(length=255), nullable=True),
            sa.Column('suggested_target_url', sa.String(length=1024), nullable=True),
            sa.Column('action_steps_json', sa.JSON(), nullable=False),
            sa.Column('status', sa.String(length=32), nullable=False),
            sa.Column('placed_url', sa.String(length=1024), nullable=True),
            sa.Column('notes', sa.Text(), nullable=True),
            sa.Column('created_at', sa.DateTime(), nullable=False),
            sa.Column('updated_at', sa.DateTime(), nullable=False),
        )
        op.create_index('ix_backlink_opportunities_campaign_id', 'backlink_opportunities', ['campaign_id'], unique=False)
        op.create_index('ix_backlink_opportunities_target_id', 'backlink_opportunities', ['target_id'], unique=False)


def downgrade() -> None:
    if _has_table('backlink_opportunities'):
        op.drop_index('ix_backlink_opportunities_target_id', table_name='backlink_opportunities')
        op.drop_index('ix_backlink_opportunities_campaign_id', table_name='backlink_opportunities')
        op.drop_table('backlink_opportunities')

    if _has_table('backlink_targets'):
        op.drop_index('ix_backlink_targets_campaign_id', table_name='backlink_targets')
        op.drop_table('backlink_targets')

    if _has_table('backlink_campaigns'):
        op.drop_index('ix_backlink_campaigns_project_id', table_name='backlink_campaigns')
        op.drop_table('backlink_campaigns')
