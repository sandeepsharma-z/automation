"""migrate serp cache to crawl discovery schema

Revision ID: 20260226_0007
Revises: 20260225_0006
Create Date: 2026-02-26 10:45:00
"""

from alembic import op
import sqlalchemy as sa


revision = '20260226_0007'
down_revision = '20260225_0006'
branch_labels = None
depends_on = None


def _table_exists(inspector, table_name: str) -> bool:
    return table_name in set(inspector.get_table_names())


def _column_names(inspector, table_name: str) -> set[str]:
    if not _table_exists(inspector, table_name):
        return set()
    return {str(col.get('name') or '') for col in inspector.get_columns(table_name)}


def _index_names(inspector, table_name: str) -> set[str]:
    if not _table_exists(inspector, table_name):
        return set()
    return {str(idx.get('name') or '') for idx in inspector.get_indexes(table_name)}


def upgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    table_names = set(inspector.get_table_names())

    if 'crawl_runs' not in table_names:
        op.create_table(
            'crawl_runs',
            sa.Column('id', sa.Integer(), nullable=False),
            sa.Column('project_id', sa.Integer(), nullable=True),
            sa.Column('cache_key', sa.String(length=191), nullable=False),
            sa.Column('keyword', sa.String(length=255), nullable=False),
            sa.Column('country', sa.String(length=16), nullable=False),
            sa.Column('language', sa.String(length=16), nullable=False),
            sa.Column('provider', sa.String(length=64), nullable=False),
            sa.Column('crawl_json', sa.JSON(), nullable=False),
            sa.Column('fetched_at', sa.DateTime(), nullable=False),
            sa.Column('expires_at', sa.DateTime(), nullable=False),
            sa.ForeignKeyConstraint(['project_id'], ['projects.id'], ondelete='SET NULL'),
            sa.PrimaryKeyConstraint('id'),
        )
        op.create_index('ix_crawl_runs_cache_key', 'crawl_runs', ['cache_key'], unique=True)
        op.create_index('ix_crawl_runs_project_id', 'crawl_runs', ['project_id'], unique=False)
        op.create_index('ix_crawl_runs_fetched_at', 'crawl_runs', ['fetched_at'], unique=False)
        op.create_index('ix_crawl_runs_expires_at', 'crawl_runs', ['expires_at'], unique=False)

    inspector = sa.inspect(bind)
    table_names = set(inspector.get_table_names())

    if 'serp_runs' in table_names:
        op.execute(
            sa.text(
                """
                INSERT INTO crawl_runs
                (project_id, cache_key, keyword, country, language, provider, crawl_json, fetched_at, expires_at)
                SELECT
                    s.project_id,
                    s.cache_key,
                    s.keyword,
                    s.country,
                    s.language,
                    COALESCE(NULLIF(s.provider, ''), 'opencrawl'),
                    s.serp_json,
                    s.fetched_at,
                    s.expires_at
                FROM serp_runs s
                LEFT JOIN crawl_runs c ON c.cache_key = s.cache_key
                WHERE c.id IS NULL
                """
            )
        )

        op.drop_table('serp_runs')

    inspector = sa.inspect(bind)
    competitor_cols = _column_names(inspector, 'competitor_pages')
    if competitor_cols:
        with op.batch_alter_table('competitor_pages') as batch:
            if 'discovery_order' not in competitor_cols:
                batch.add_column(sa.Column('discovery_order', sa.Integer(), nullable=False, server_default='0'))
            if 'competitive_strength_score' not in competitor_cols:
                batch.add_column(
                    sa.Column('competitive_strength_score', sa.Float(), nullable=False, server_default='0')
                )
            if 'freshness_score' not in competitor_cols:
                batch.add_column(sa.Column('freshness_score', sa.Float(), nullable=False, server_default='0'))
            if 'inlink_count' not in competitor_cols:
                batch.add_column(sa.Column('inlink_count', sa.Integer(), nullable=True))
            if 'discovered_at' not in competitor_cols:
                batch.add_column(sa.Column('discovered_at', sa.DateTime(), nullable=True))
            if 'last_seen_at' not in competitor_cols:
                batch.add_column(sa.Column('last_seen_at', sa.DateTime(), nullable=True))

        inspector = sa.inspect(bind)
        competitor_cols = _column_names(inspector, 'competitor_pages')
        if 'position' in competitor_cols and 'discovery_order' in competitor_cols:
            op.execute(sa.text('UPDATE competitor_pages SET discovery_order = position WHERE position IS NOT NULL'))
            with op.batch_alter_table('competitor_pages') as batch:
                batch.drop_column('position')


def downgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)

    if _table_exists(inspector, 'serp_runs'):
        return

    op.create_table(
        'serp_runs',
        sa.Column('id', sa.Integer(), nullable=False),
        sa.Column('project_id', sa.Integer(), nullable=True),
        sa.Column('cache_key', sa.String(length=191), nullable=False),
        sa.Column('keyword', sa.String(length=255), nullable=False),
        sa.Column('country', sa.String(length=16), nullable=False),
        sa.Column('language', sa.String(length=16), nullable=False),
        sa.Column('device', sa.String(length=16), nullable=False, server_default='desktop'),
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

    if _table_exists(sa.inspect(bind), 'crawl_runs'):
        op.execute(
            sa.text(
                """
                INSERT INTO serp_runs
                (project_id, cache_key, keyword, country, language, device, provider, serp_json, fetched_at, expires_at)
                SELECT
                    c.project_id,
                    c.cache_key,
                    c.keyword,
                    c.country,
                    c.language,
                    'desktop',
                    c.provider,
                    c.crawl_json,
                    c.fetched_at,
                    c.expires_at
                FROM crawl_runs c
                LEFT JOIN serp_runs s ON s.cache_key = c.cache_key
                WHERE s.id IS NULL
                """
            )
        )

    inspector = sa.inspect(bind)
    competitor_cols = _column_names(inspector, 'competitor_pages')
    if competitor_cols:
        with op.batch_alter_table('competitor_pages') as batch:
            if 'position' not in competitor_cols:
                batch.add_column(sa.Column('position', sa.Integer(), nullable=False, server_default='0'))
        if 'discovery_order' in _column_names(sa.inspect(bind), 'competitor_pages'):
            op.execute(sa.text('UPDATE competitor_pages SET position = discovery_order WHERE discovery_order IS NOT NULL'))
            with op.batch_alter_table('competitor_pages') as batch:
                if 'competitive_strength_score' in _column_names(sa.inspect(bind), 'competitor_pages'):
                    batch.drop_column('competitive_strength_score')
                if 'freshness_score' in _column_names(sa.inspect(bind), 'competitor_pages'):
                    batch.drop_column('freshness_score')
                if 'inlink_count' in _column_names(sa.inspect(bind), 'competitor_pages'):
                    batch.drop_column('inlink_count')
                if 'discovered_at' in _column_names(sa.inspect(bind), 'competitor_pages'):
                    batch.drop_column('discovered_at')
                if 'last_seen_at' in _column_names(sa.inspect(bind), 'competitor_pages'):
                    batch.drop_column('last_seen_at')
                batch.drop_column('discovery_order')

    if _table_exists(sa.inspect(bind), 'crawl_runs'):
        op.drop_table('crawl_runs')
