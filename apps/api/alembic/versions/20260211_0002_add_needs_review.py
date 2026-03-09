"""add needs_review draft status

Revision ID: 20260211_0002
Revises: 20260211_0001
Create Date: 2026-02-11 12:40:00.000000
"""

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = '20260211_0002'
down_revision: Union[str, None] = '20260211_0001'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    bind = op.get_bind()
    if bind.dialect.name == 'mysql':
        op.execute(
            """
            ALTER TABLE drafts
            MODIFY COLUMN status ENUM('draft','needs_review','approved','publishing','published','failed')
            NOT NULL DEFAULT 'draft'
            """
        )


def downgrade() -> None:
    bind = op.get_bind()
    if bind.dialect.name == 'mysql':
        op.execute(
            """
            ALTER TABLE drafts
            MODIFY COLUMN status ENUM('draft','approved','publishing','published','failed')
            NOT NULL DEFAULT 'draft'
            """
        )
