"""add global settings, pattern editor fields, and publish payload

Revision ID: 20260211_0003
Revises: 20260211_0002
Create Date: 2026-02-11 15:05:00.000000
"""

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = '20260211_0003'
down_revision: Union[str, None] = '20260211_0002'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        'settings',
        sa.Column('id', sa.Integer(), primary_key=True),
        sa.Column('key', sa.String(length=128), nullable=False),
        sa.Column('value_encrypted', sa.Text(), nullable=True),
        sa.Column('value_masked', sa.Text(), nullable=True),
        sa.Column('updated_at', sa.DateTime(), nullable=False),
        sa.UniqueConstraint('key', name='uq_settings_key'),
    )
    op.create_index('ix_settings_key', 'settings', ['key'], unique=True)

    op.add_column('content_patterns', sa.Column('outline_json', sa.JSON(), nullable=True))
    op.add_column('content_patterns', sa.Column('cta_text', sa.Text(), nullable=True))
    op.add_column('content_patterns', sa.Column('faq_schema_enabled', sa.Boolean(), nullable=True))

    op.add_column('publish_records', sa.Column('payload_json', sa.JSON(), nullable=True))

    bind = op.get_bind()
    if bind.dialect.name == 'mysql':
        op.execute(
            """
            ALTER TABLE publish_records
            MODIFY COLUMN status ENUM('queued','scheduled','published','failed')
            NOT NULL DEFAULT 'queued'
            """
        )


def downgrade() -> None:
    bind = op.get_bind()
    if bind.dialect.name == 'mysql':
        op.execute(
            """
            ALTER TABLE publish_records
            MODIFY COLUMN status ENUM('queued','published','failed')
            NOT NULL DEFAULT 'queued'
            """
        )

    op.drop_column('publish_records', 'payload_json')

    op.drop_column('content_patterns', 'faq_schema_enabled')
    op.drop_column('content_patterns', 'cta_text')
    op.drop_column('content_patterns', 'outline_json')

    op.drop_index('ix_settings_key', table_name='settings')
    op.drop_table('settings')
