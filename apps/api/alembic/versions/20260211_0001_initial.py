"""initial schema

Revision ID: 20260211_0001
Revises:
Create Date: 2026-02-11 00:00:01.000000
"""

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = '20260211_0001'
down_revision: Union[str, None] = None
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


platform_enum = sa.Enum('wordpress', 'shopify', name='platformtype')
topic_status_enum = sa.Enum('pending', 'running', 'completed', 'failed', name='topicstatus')
pipeline_status_enum = sa.Enum('queued', 'running', 'completed', 'failed', name='pipelinestatus')
draft_status_enum = sa.Enum('draft', 'approved', 'publishing', 'published', 'failed', name='draftstatus')
publish_status_enum = sa.Enum('queued', 'published', 'failed', name='publishstatus')


def upgrade() -> None:
    op.create_table(
        'projects',
        sa.Column('id', sa.Integer(), primary_key=True),
        sa.Column('name', sa.String(length=255), nullable=False),
        sa.Column('platform', platform_enum, nullable=False),
        sa.Column('base_url', sa.String(length=512), nullable=False),
        sa.Column('wp_user', sa.String(length=255), nullable=True),
        sa.Column('wp_app_password_enc', sa.Text(), nullable=True),
        sa.Column('shopify_store', sa.String(length=255), nullable=True),
        sa.Column('shopify_token_enc', sa.Text(), nullable=True),
        sa.Column('settings_json', sa.JSON(), nullable=False),
        sa.Column('created_at', sa.DateTime(), nullable=False),
    )
    op.create_index('ix_projects_id', 'projects', ['id'], unique=False)

    op.create_table(
        'content_library_items',
        sa.Column('id', sa.Integer(), primary_key=True),
        sa.Column('project_id', sa.Integer(), sa.ForeignKey('projects.id', ondelete='CASCADE'), nullable=False),
        sa.Column('type', sa.String(length=50), nullable=False),
        sa.Column('title', sa.String(length=512), nullable=False),
        sa.Column('url', sa.String(length=1024), nullable=False),
        sa.Column('handle', sa.String(length=255), nullable=True),
        sa.Column('tags_json', sa.JSON(), nullable=False),
        sa.Column('last_synced_at', sa.DateTime(), nullable=True),
    )
    op.create_index('ix_content_library_items_project_id', 'content_library_items', ['project_id'], unique=False)

    op.create_table(
        'topics',
        sa.Column('id', sa.Integer(), primary_key=True),
        sa.Column('project_id', sa.Integer(), sa.ForeignKey('projects.id', ondelete='CASCADE'), nullable=False),
        sa.Column('title', sa.String(length=512), nullable=False),
        sa.Column('primary_keyword', sa.String(length=255), nullable=False),
        sa.Column('secondary_keywords_json', sa.JSON(), nullable=False),
        sa.Column('status', topic_status_enum, nullable=False),
        sa.Column('desired_word_count', sa.Integer(), nullable=False),
        sa.Column('created_at', sa.DateTime(), nullable=False),
    )
    op.create_index('ix_topics_project_id', 'topics', ['project_id'], unique=False)

    op.create_table(
        'pipeline_runs',
        sa.Column('id', sa.Integer(), primary_key=True),
        sa.Column('topic_id', sa.Integer(), sa.ForeignKey('topics.id', ondelete='CASCADE'), nullable=False),
        sa.Column('project_id', sa.Integer(), sa.ForeignKey('projects.id', ondelete='CASCADE'), nullable=False),
        sa.Column('status', pipeline_status_enum, nullable=False),
        sa.Column('stage', sa.String(length=64), nullable=False),
        sa.Column('started_at', sa.DateTime(), nullable=True),
        sa.Column('finished_at', sa.DateTime(), nullable=True),
        sa.Column('error_message', sa.Text(), nullable=True),
    )
    op.create_index('ix_pipeline_runs_topic_id', 'pipeline_runs', ['topic_id'], unique=False)
    op.create_index('ix_pipeline_runs_project_id', 'pipeline_runs', ['project_id'], unique=False)

    op.create_table(
        'pipeline_events',
        sa.Column('id', sa.Integer(), primary_key=True),
        sa.Column('pipeline_run_id', sa.Integer(), sa.ForeignKey('pipeline_runs.id', ondelete='CASCADE'), nullable=False),
        sa.Column('level', sa.String(length=20), nullable=False),
        sa.Column('message', sa.Text(), nullable=False),
        sa.Column('meta_json', sa.JSON(), nullable=False),
        sa.Column('created_at', sa.DateTime(), nullable=False),
    )
    op.create_index('ix_pipeline_events_pipeline_run_id', 'pipeline_events', ['pipeline_run_id'], unique=False)

    op.create_table(
        'drafts',
        sa.Column('id', sa.Integer(), primary_key=True),
        sa.Column('topic_id', sa.Integer(), sa.ForeignKey('topics.id', ondelete='CASCADE'), nullable=False),
        sa.Column('project_id', sa.Integer(), sa.ForeignKey('projects.id', ondelete='CASCADE'), nullable=False),
        sa.Column('title', sa.String(length=512), nullable=False),
        sa.Column('slug', sa.String(length=255), nullable=False),
        sa.Column('html', sa.Text(), nullable=False),
        sa.Column('meta_title', sa.String(length=255), nullable=False),
        sa.Column('meta_description', sa.String(length=512), nullable=False),
        sa.Column('internal_links_json', sa.JSON(), nullable=False),
        sa.Column('sources_json', sa.JSON(), nullable=False),
        sa.Column('image_path', sa.String(length=1024), nullable=True),
        sa.Column('image_prompt', sa.Text(), nullable=True),
        sa.Column('alt_text', sa.String(length=255), nullable=True),
        sa.Column('caption', sa.String(length=255), nullable=True),
        sa.Column('pattern_key', sa.String(length=64), nullable=True),
        sa.Column('fingerprint', sa.String(length=255), nullable=True),
        sa.Column('token_input', sa.Integer(), nullable=False),
        sa.Column('token_output', sa.Integer(), nullable=False),
        sa.Column('cost_estimate_usd', sa.Float(), nullable=False),
        sa.Column('status', draft_status_enum, nullable=False),
        sa.Column('created_at', sa.DateTime(), nullable=False),
    )
    op.create_index('ix_drafts_topic_id', 'drafts', ['topic_id'], unique=False)
    op.create_index('ix_drafts_project_id', 'drafts', ['project_id'], unique=False)

    op.create_table(
        'publish_records',
        sa.Column('id', sa.Integer(), primary_key=True),
        sa.Column('draft_id', sa.Integer(), sa.ForeignKey('drafts.id', ondelete='CASCADE'), nullable=False),
        sa.Column('project_id', sa.Integer(), sa.ForeignKey('projects.id', ondelete='CASCADE'), nullable=False),
        sa.Column('platform_post_id', sa.String(length=128), nullable=True),
        sa.Column('platform_url', sa.String(length=1024), nullable=True),
        sa.Column('status', publish_status_enum, nullable=False),
        sa.Column('scheduled_at', sa.DateTime(), nullable=True),
        sa.Column('published_at', sa.DateTime(), nullable=True),
        sa.Column('error_message', sa.Text(), nullable=True),
    )
    op.create_index('ix_publish_records_draft_id', 'publish_records', ['draft_id'], unique=False)
    op.create_index('ix_publish_records_project_id', 'publish_records', ['project_id'], unique=False)

    op.create_table(
        'content_patterns',
        sa.Column('id', sa.Integer(), primary_key=True),
        sa.Column('project_id', sa.Integer(), sa.ForeignKey('projects.id', ondelete='CASCADE'), nullable=False),
        sa.Column('pattern_key', sa.String(length=64), nullable=False),
        sa.Column('enabled', sa.Boolean(), nullable=False),
        sa.Column('usage_count', sa.Integer(), nullable=False),
        sa.Column('last_used_at', sa.DateTime(), nullable=True),
        sa.UniqueConstraint('project_id', 'pattern_key', name='uq_project_pattern'),
    )
    op.create_index('ix_content_patterns_project_id', 'content_patterns', ['project_id'], unique=False)


def downgrade() -> None:
    op.drop_index('ix_content_patterns_project_id', table_name='content_patterns')
    op.drop_table('content_patterns')

    op.drop_index('ix_publish_records_project_id', table_name='publish_records')
    op.drop_index('ix_publish_records_draft_id', table_name='publish_records')
    op.drop_table('publish_records')

    op.drop_index('ix_drafts_project_id', table_name='drafts')
    op.drop_index('ix_drafts_topic_id', table_name='drafts')
    op.drop_table('drafts')

    op.drop_index('ix_pipeline_events_pipeline_run_id', table_name='pipeline_events')
    op.drop_table('pipeline_events')

    op.drop_index('ix_pipeline_runs_project_id', table_name='pipeline_runs')
    op.drop_index('ix_pipeline_runs_topic_id', table_name='pipeline_runs')
    op.drop_table('pipeline_runs')

    op.drop_index('ix_topics_project_id', table_name='topics')
    op.drop_table('topics')

    op.drop_index('ix_content_library_items_project_id', table_name='content_library_items')
    op.drop_table('content_library_items')

    op.drop_index('ix_projects_id', table_name='projects')
    op.drop_table('projects')

    publish_status_enum.drop(op.get_bind(), checkfirst=True)
    draft_status_enum.drop(op.get_bind(), checkfirst=True)
    pipeline_status_enum.drop(op.get_bind(), checkfirst=True)
    topic_status_enum.drop(op.get_bind(), checkfirst=True)
    platform_enum.drop(op.get_bind(), checkfirst=True)
