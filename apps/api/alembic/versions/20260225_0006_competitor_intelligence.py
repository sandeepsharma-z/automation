"""add competitor intelligence tables

Revision ID: 20260225_0006
Revises: 20260216_0005
Create Date: 2026-02-25 18:10:00
"""

from alembic import op
import sqlalchemy as sa


revision = '20260225_0006'
down_revision = '20260216_0005'
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        'serp_runs',
        sa.Column('id', sa.Integer(), nullable=False),
        sa.Column('project_id', sa.Integer(), nullable=True),
        sa.Column('cache_key', sa.String(length=191), nullable=False),
        sa.Column('keyword', sa.String(length=255), nullable=False),
        sa.Column('country', sa.String(length=16), nullable=False),
        sa.Column('language', sa.String(length=16), nullable=False),
        sa.Column('device', sa.String(length=16), nullable=False),
        sa.Column('provider', sa.String(length=64), nullable=False),
        sa.Column('serp_json', sa.JSON(), nullable=False),
        sa.Column('fetched_at', sa.DateTime(), nullable=False),
        sa.Column('expires_at', sa.DateTime(), nullable=False),
        sa.ForeignKeyConstraint(['project_id'], ['projects.id'], ondelete='SET NULL'),
        sa.PrimaryKeyConstraint('id'),
    )
    op.create_index('ix_serp_runs_cache_key', 'serp_runs', ['cache_key'], unique=True)
    op.create_index('ix_serp_runs_project_id', 'serp_runs', ['project_id'], unique=False)
    op.create_index('ix_serp_runs_fetched_at', 'serp_runs', ['fetched_at'], unique=False)
    op.create_index('ix_serp_runs_expires_at', 'serp_runs', ['expires_at'], unique=False)

    op.create_table(
        'competitor_pages',
        sa.Column('id', sa.Integer(), nullable=False),
        sa.Column('pipeline_run_id', sa.Integer(), nullable=False),
        sa.Column('project_id', sa.Integer(), nullable=False),
        sa.Column('url', sa.String(length=1024), nullable=False),
        sa.Column('domain', sa.String(length=255), nullable=False),
        sa.Column('title', sa.String(length=512), nullable=False),
        sa.Column('snippet', sa.Text(), nullable=False),
        sa.Column('position', sa.Integer(), nullable=False),
        sa.Column('fetch_status', sa.String(length=32), nullable=False),
        sa.Column('http_status', sa.Integer(), nullable=True),
        sa.Column('fetch_error_type', sa.String(length=64), nullable=True),
        sa.Column('error_message', sa.Text(), nullable=True),
        sa.Column('html_snapshot', sa.Text(), nullable=True),
        sa.Column('fetched_at', sa.DateTime(), nullable=False),
        sa.ForeignKeyConstraint(['pipeline_run_id'], ['pipeline_runs.id'], ondelete='CASCADE'),
        sa.ForeignKeyConstraint(['project_id'], ['projects.id'], ondelete='CASCADE'),
        sa.PrimaryKeyConstraint('id'),
    )
    op.create_index('ix_competitor_pages_pipeline_run_id', 'competitor_pages', ['pipeline_run_id'], unique=False)
    op.create_index('ix_competitor_pages_project_id', 'competitor_pages', ['project_id'], unique=False)

    op.create_table(
        'competitor_extracts',
        sa.Column('id', sa.Integer(), nullable=False),
        sa.Column('competitor_page_id', sa.Integer(), nullable=False),
        sa.Column('pipeline_run_id', sa.Integer(), nullable=False),
        sa.Column('project_id', sa.Integer(), nullable=False),
        sa.Column('url', sa.String(length=1024), nullable=False),
        sa.Column('headings_json', sa.JSON(), nullable=False),
        sa.Column('entities_json', sa.JSON(), nullable=False),
        sa.Column('faqs_json', sa.JSON(), nullable=False),
        sa.Column('metrics_json', sa.JSON(), nullable=False),
        sa.Column('trust_signals_json', sa.JSON(), nullable=False),
        sa.Column('plain_text', sa.Text(), nullable=True),
        sa.Column('extracted_at', sa.DateTime(), nullable=False),
        sa.ForeignKeyConstraint(['competitor_page_id'], ['competitor_pages.id'], ondelete='CASCADE'),
        sa.ForeignKeyConstraint(['pipeline_run_id'], ['pipeline_runs.id'], ondelete='CASCADE'),
        sa.ForeignKeyConstraint(['project_id'], ['projects.id'], ondelete='CASCADE'),
        sa.PrimaryKeyConstraint('id'),
    )
    op.create_index('ix_competitor_extracts_competitor_page_id', 'competitor_extracts', ['competitor_page_id'], unique=False)
    op.create_index('ix_competitor_extracts_pipeline_run_id', 'competitor_extracts', ['pipeline_run_id'], unique=False)
    op.create_index('ix_competitor_extracts_project_id', 'competitor_extracts', ['project_id'], unique=False)

    op.create_table(
        'blog_briefs',
        sa.Column('id', sa.Integer(), nullable=False),
        sa.Column('pipeline_run_id', sa.Integer(), nullable=False),
        sa.Column('project_id', sa.Integer(), nullable=False),
        sa.Column('keyword', sa.String(length=255), nullable=False),
        sa.Column('intent_mix_json', sa.JSON(), nullable=False),
        sa.Column('required_sections_json', sa.JSON(), nullable=False),
        sa.Column('differentiators_json', sa.JSON(), nullable=False),
        sa.Column('internal_link_plan_json', sa.JSON(), nullable=False),
        sa.Column('cta_plan_json', sa.JSON(), nullable=False),
        sa.Column('brief_json', sa.JSON(), nullable=False),
        sa.Column('created_at', sa.DateTime(), nullable=False),
        sa.ForeignKeyConstraint(['pipeline_run_id'], ['pipeline_runs.id'], ondelete='CASCADE'),
        sa.ForeignKeyConstraint(['project_id'], ['projects.id'], ondelete='CASCADE'),
        sa.PrimaryKeyConstraint('id'),
    )
    op.create_index('ix_blog_briefs_pipeline_run_id', 'blog_briefs', ['pipeline_run_id'], unique=False)
    op.create_index('ix_blog_briefs_project_id', 'blog_briefs', ['project_id'], unique=False)

    op.create_table(
        'blog_qa',
        sa.Column('id', sa.Integer(), nullable=False),
        sa.Column('draft_id', sa.Integer(), nullable=False),
        sa.Column('pipeline_run_id', sa.Integer(), nullable=False),
        sa.Column('project_id', sa.Integer(), nullable=False),
        sa.Column('completeness_score', sa.Float(), nullable=False),
        sa.Column('readability_score', sa.Float(), nullable=False),
        sa.Column('practicality_score', sa.Float(), nullable=False),
        sa.Column('eeat_score', sa.Float(), nullable=False),
        sa.Column('domain_mismatch_score', sa.Float(), nullable=False),
        sa.Column('overall_score', sa.Float(), nullable=False),
        sa.Column('qa_json', sa.JSON(), nullable=False),
        sa.Column('created_at', sa.DateTime(), nullable=False),
        sa.ForeignKeyConstraint(['draft_id'], ['drafts.id'], ondelete='CASCADE'),
        sa.ForeignKeyConstraint(['pipeline_run_id'], ['pipeline_runs.id'], ondelete='CASCADE'),
        sa.ForeignKeyConstraint(['project_id'], ['projects.id'], ondelete='CASCADE'),
        sa.PrimaryKeyConstraint('id'),
    )
    op.create_index('ix_blog_qa_draft_id', 'blog_qa', ['draft_id'], unique=False)
    op.create_index('ix_blog_qa_pipeline_run_id', 'blog_qa', ['pipeline_run_id'], unique=False)
    op.create_index('ix_blog_qa_project_id', 'blog_qa', ['project_id'], unique=False)


def downgrade() -> None:
    op.drop_index('ix_blog_qa_project_id', table_name='blog_qa')
    op.drop_index('ix_blog_qa_pipeline_run_id', table_name='blog_qa')
    op.drop_index('ix_blog_qa_draft_id', table_name='blog_qa')
    op.drop_table('blog_qa')

    op.drop_index('ix_blog_briefs_project_id', table_name='blog_briefs')
    op.drop_index('ix_blog_briefs_pipeline_run_id', table_name='blog_briefs')
    op.drop_table('blog_briefs')

    op.drop_index('ix_competitor_extracts_project_id', table_name='competitor_extracts')
    op.drop_index('ix_competitor_extracts_pipeline_run_id', table_name='competitor_extracts')
    op.drop_index('ix_competitor_extracts_competitor_page_id', table_name='competitor_extracts')
    op.drop_table('competitor_extracts')

    op.drop_index('ix_competitor_pages_project_id', table_name='competitor_pages')
    op.drop_index('ix_competitor_pages_pipeline_run_id', table_name='competitor_pages')
    op.drop_table('competitor_pages')

    op.drop_index('ix_serp_runs_expires_at', table_name='serp_runs')
    op.drop_index('ix_serp_runs_fetched_at', table_name='serp_runs')
    op.drop_index('ix_serp_runs_project_id', table_name='serp_runs')
    op.drop_index('ix_serp_runs_cache_key', table_name='serp_runs')
    op.drop_table('serp_runs')
