"""add blog agent draft metadata and draft images

Revision ID: 20260211_0004
Revises: 20260211_0003
Create Date: 2026-02-11 17:10:00.000000
"""

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = '20260211_0004'
down_revision: Union[str, None] = '20260211_0003'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def _has_column(table: str, column: str) -> bool:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    return any(col['name'] == column for col in inspector.get_columns(table))


def _has_table(table: str) -> bool:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    return table in inspector.get_table_names()


def upgrade() -> None:
    if not _has_column('drafts', 'outline_json'):
        op.add_column('drafts', sa.Column('outline_json', sa.JSON(), nullable=True))
    if not _has_column('drafts', 'faq_json'):
        op.add_column('drafts', sa.Column('faq_json', sa.JSON(), nullable=True))
    if not _has_column('drafts', 'schema_jsonld'):
        op.add_column('drafts', sa.Column('schema_jsonld', sa.JSON(), nullable=True))
    if not _has_column('drafts', 'structure_type'):
        op.add_column('drafts', sa.Column('structure_type', sa.String(length=64), nullable=True))
    if not _has_column('drafts', 'outline_fingerprint'):
        op.add_column('drafts', sa.Column('outline_fingerprint', sa.String(length=255), nullable=True))
    if not _has_column('drafts', 'intro_style'):
        op.add_column('drafts', sa.Column('intro_style', sa.String(length=64), nullable=True))
    if not _has_column('drafts', 'cta_style'):
        op.add_column('drafts', sa.Column('cta_style', sa.String(length=64), nullable=True))
    if not _has_column('drafts', 'faq_count'):
        op.add_column('drafts', sa.Column('faq_count', sa.Integer(), nullable=True))
    if not _has_column('drafts', 'similarity_score'):
        op.add_column('drafts', sa.Column('similarity_score', sa.Float(), nullable=True))
    if not _has_column('drafts', 'platform'):
        op.add_column('drafts', sa.Column('platform', sa.String(length=32), nullable=True))
    if not _has_column('drafts', 'platform_post_id'):
        op.add_column('drafts', sa.Column('platform_post_id', sa.String(length=128), nullable=True))
    if not _has_column('drafts', 'publish_url'):
        op.add_column('drafts', sa.Column('publish_url', sa.String(length=1024), nullable=True))

    op.execute("UPDATE drafts SET outline_json = JSON_ARRAY() WHERE outline_json IS NULL")
    op.execute("UPDATE drafts SET faq_json = JSON_ARRAY() WHERE faq_json IS NULL")
    op.execute("UPDATE drafts SET schema_jsonld = JSON_OBJECT() WHERE schema_jsonld IS NULL")
    op.execute("UPDATE drafts SET faq_count = 0 WHERE faq_count IS NULL")
    op.execute("UPDATE drafts SET similarity_score = 0.0 WHERE similarity_score IS NULL")
    op.execute("UPDATE drafts SET platform = 'none' WHERE platform IS NULL")

    op.alter_column('drafts', 'outline_json', existing_type=sa.JSON(), existing_nullable=True, nullable=False)
    op.alter_column('drafts', 'faq_json', existing_type=sa.JSON(), existing_nullable=True, nullable=False)
    op.alter_column('drafts', 'schema_jsonld', existing_type=sa.JSON(), existing_nullable=True, nullable=False)
    op.alter_column('drafts', 'faq_count', existing_type=sa.Integer(), existing_nullable=True, nullable=False)
    op.alter_column('drafts', 'similarity_score', existing_type=sa.Float(), existing_nullable=True, nullable=False)
    op.alter_column('drafts', 'platform', existing_type=sa.String(length=32), existing_nullable=True, nullable=False)

    if not _has_table('draft_images'):
        op.create_table(
            'draft_images',
            sa.Column('id', sa.Integer(), primary_key=True),
            sa.Column('draft_id', sa.Integer(), sa.ForeignKey('drafts.id', ondelete='CASCADE'), nullable=False),
            sa.Column('project_id', sa.Integer(), sa.ForeignKey('projects.id', ondelete='CASCADE'), nullable=False),
            sa.Column('kind', sa.String(length=32), nullable=False),
            sa.Column('image_path', sa.String(length=1024), nullable=False),
            sa.Column('prompt', sa.Text(), nullable=True),
            sa.Column('alt_text', sa.String(length=255), nullable=True),
            sa.Column('caption', sa.String(length=255), nullable=True),
            sa.Column('position', sa.Integer(), nullable=False),
            sa.Column('created_at', sa.DateTime(), nullable=False),
        )
        op.create_index('ix_draft_images_draft_id', 'draft_images', ['draft_id'], unique=False)
        op.create_index('ix_draft_images_project_id', 'draft_images', ['project_id'], unique=False)


def downgrade() -> None:
    if _has_table('draft_images'):
        op.drop_index('ix_draft_images_project_id', table_name='draft_images')
        op.drop_index('ix_draft_images_draft_id', table_name='draft_images')
        op.drop_table('draft_images')

    if _has_column('drafts', 'publish_url'):
        op.drop_column('drafts', 'publish_url')
    if _has_column('drafts', 'platform_post_id'):
        op.drop_column('drafts', 'platform_post_id')
    if _has_column('drafts', 'platform'):
        op.drop_column('drafts', 'platform')
    if _has_column('drafts', 'similarity_score'):
        op.drop_column('drafts', 'similarity_score')
    if _has_column('drafts', 'faq_count'):
        op.drop_column('drafts', 'faq_count')
    if _has_column('drafts', 'cta_style'):
        op.drop_column('drafts', 'cta_style')
    if _has_column('drafts', 'intro_style'):
        op.drop_column('drafts', 'intro_style')
    if _has_column('drafts', 'outline_fingerprint'):
        op.drop_column('drafts', 'outline_fingerprint')
    if _has_column('drafts', 'structure_type'):
        op.drop_column('drafts', 'structure_type')
    if _has_column('drafts', 'schema_jsonld'):
        op.drop_column('drafts', 'schema_jsonld')
    if _has_column('drafts', 'faq_json'):
        op.drop_column('drafts', 'faq_json')
    if _has_column('drafts', 'outline_json'):
        op.drop_column('drafts', 'outline_json')
