import enum
from datetime import datetime

from sqlalchemy import (
    JSON,
    Boolean,
    DateTime,
    Enum,
    Float,
    ForeignKey,
    Integer,
    String,
    Text,
    UniqueConstraint,
)
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db.base import Base


class PlatformType(str, enum.Enum):
    wordpress = 'wordpress'
    shopify = 'shopify'


class TopicStatus(str, enum.Enum):
    pending = 'pending'
    running = 'running'
    completed = 'completed'
    failed = 'failed'


class PipelineStatus(str, enum.Enum):
    queued = 'queued'
    running = 'running'
    completed = 'completed'
    failed = 'failed'


class DraftStatus(str, enum.Enum):
    draft = 'draft'
    needs_review = 'needs_review'
    approved = 'approved'
    publishing = 'publishing'
    published = 'published'
    failed = 'failed'


class PublishStatus(str, enum.Enum):
    queued = 'queued'
    scheduled = 'scheduled'
    published = 'published'
    failed = 'failed'


class Project(Base):
    __tablename__ = 'projects'

    id: Mapped[int] = mapped_column(Integer, primary_key=True, index=True)
    name: Mapped[str] = mapped_column(String(255), nullable=False)
    platform: Mapped[PlatformType] = mapped_column(Enum(PlatformType), nullable=False)
    base_url: Mapped[str] = mapped_column(String(512), nullable=False)

    wp_user: Mapped[str | None] = mapped_column(String(255), nullable=True)
    wp_app_password_enc: Mapped[str | None] = mapped_column(Text, nullable=True)

    shopify_store: Mapped[str | None] = mapped_column(String(255), nullable=True)
    shopify_token_enc: Mapped[str | None] = mapped_column(Text, nullable=True)

    settings_json: Mapped[dict] = mapped_column(JSON, default=dict)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)

    library_items: Mapped[list['ContentLibraryItem']] = relationship(back_populates='project', cascade='all, delete-orphan')
    topics: Mapped[list['Topic']] = relationship(back_populates='project', cascade='all, delete-orphan')
    drafts: Mapped[list['Draft']] = relationship(back_populates='project', cascade='all, delete-orphan')
    patterns: Mapped[list['ContentPattern']] = relationship(back_populates='project', cascade='all, delete-orphan')
    backlink_campaigns: Mapped[list['BacklinkCampaign']] = relationship(
        back_populates='project', cascade='all, delete-orphan'
    )


class ContentLibraryItem(Base):
    __tablename__ = 'content_library_items'

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    project_id: Mapped[int] = mapped_column(ForeignKey('projects.id', ondelete='CASCADE'), index=True)
    type: Mapped[str] = mapped_column(String(50), nullable=False)
    title: Mapped[str] = mapped_column(String(512), nullable=False)
    url: Mapped[str] = mapped_column(String(1024), nullable=False)
    handle: Mapped[str | None] = mapped_column(String(255), nullable=True)
    tags_json: Mapped[list] = mapped_column(JSON, default=list)
    last_synced_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)

    project: Mapped['Project'] = relationship(back_populates='library_items')


class Topic(Base):
    __tablename__ = 'topics'

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    project_id: Mapped[int] = mapped_column(ForeignKey('projects.id', ondelete='CASCADE'), index=True)
    title: Mapped[str] = mapped_column(String(512), nullable=False)
    primary_keyword: Mapped[str] = mapped_column(String(255), nullable=False)
    secondary_keywords_json: Mapped[list] = mapped_column(JSON, default=list)
    status: Mapped[TopicStatus] = mapped_column(Enum(TopicStatus), default=TopicStatus.pending)
    desired_word_count: Mapped[int] = mapped_column(Integer, default=1200)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)

    project: Mapped['Project'] = relationship(back_populates='topics')


class PipelineRun(Base):
    __tablename__ = 'pipeline_runs'

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    topic_id: Mapped[int] = mapped_column(ForeignKey('topics.id', ondelete='CASCADE'), index=True)
    project_id: Mapped[int] = mapped_column(ForeignKey('projects.id', ondelete='CASCADE'), index=True)
    status: Mapped[PipelineStatus] = mapped_column(Enum(PipelineStatus), default=PipelineStatus.queued)
    stage: Mapped[str] = mapped_column(String(64), default='queued')
    started_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    finished_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    error_message: Mapped[str | None] = mapped_column(Text, nullable=True)

    events: Mapped[list['PipelineEvent']] = relationship(back_populates='pipeline_run', cascade='all, delete-orphan')


class PipelineEvent(Base):
    __tablename__ = 'pipeline_events'

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    pipeline_run_id: Mapped[int] = mapped_column(ForeignKey('pipeline_runs.id', ondelete='CASCADE'), index=True)
    level: Mapped[str] = mapped_column(String(20), default='info')
    message: Mapped[str] = mapped_column(Text, nullable=False)
    meta_json: Mapped[dict] = mapped_column(JSON, default=dict)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)

    pipeline_run: Mapped['PipelineRun'] = relationship(back_populates='events')


class Draft(Base):
    __tablename__ = 'drafts'

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    topic_id: Mapped[int] = mapped_column(ForeignKey('topics.id', ondelete='CASCADE'), index=True)
    project_id: Mapped[int] = mapped_column(ForeignKey('projects.id', ondelete='CASCADE'), index=True)
    title: Mapped[str] = mapped_column(String(512), nullable=False)
    slug: Mapped[str] = mapped_column(String(255), nullable=False)
    outline_json: Mapped[list] = mapped_column(JSON, default=list)
    html: Mapped[str] = mapped_column(Text, nullable=False)
    meta_title: Mapped[str] = mapped_column(String(255), nullable=False)
    meta_description: Mapped[str] = mapped_column(String(512), nullable=False)
    faq_json: Mapped[list] = mapped_column(JSON, default=list)
    schema_jsonld: Mapped[dict] = mapped_column(JSON, default=dict)
    internal_links_json: Mapped[list] = mapped_column(JSON, default=list)
    sources_json: Mapped[list] = mapped_column(JSON, default=list)
    image_path: Mapped[str | None] = mapped_column(String(1024), nullable=True)
    image_prompt: Mapped[str | None] = mapped_column(Text, nullable=True)
    alt_text: Mapped[str | None] = mapped_column(String(255), nullable=True)
    caption: Mapped[str | None] = mapped_column(String(255), nullable=True)
    pattern_key: Mapped[str | None] = mapped_column(String(64), nullable=True)
    structure_type: Mapped[str | None] = mapped_column(String(64), nullable=True)
    outline_fingerprint: Mapped[str | None] = mapped_column(String(255), nullable=True)
    intro_style: Mapped[str | None] = mapped_column(String(64), nullable=True)
    cta_style: Mapped[str | None] = mapped_column(String(64), nullable=True)
    faq_count: Mapped[int] = mapped_column(Integer, default=0)
    similarity_score: Mapped[float] = mapped_column(Float, default=0.0)
    fingerprint: Mapped[str | None] = mapped_column(String(255), nullable=True)
    platform: Mapped[str] = mapped_column(String(32), default='none')
    platform_post_id: Mapped[str | None] = mapped_column(String(128), nullable=True)
    publish_url: Mapped[str | None] = mapped_column(String(1024), nullable=True)
    token_input: Mapped[int] = mapped_column(Integer, default=0)
    token_output: Mapped[int] = mapped_column(Integer, default=0)
    cost_estimate_usd: Mapped[float] = mapped_column(Float, default=0.0)
    status: Mapped[DraftStatus] = mapped_column(Enum(DraftStatus), default=DraftStatus.draft)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)

    project: Mapped['Project'] = relationship(back_populates='drafts')
    images: Mapped[list['DraftImage']] = relationship(back_populates='draft', cascade='all, delete-orphan')


class PublishRecord(Base):
    __tablename__ = 'publish_records'

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    draft_id: Mapped[int] = mapped_column(ForeignKey('drafts.id', ondelete='CASCADE'), index=True)
    project_id: Mapped[int] = mapped_column(ForeignKey('projects.id', ondelete='CASCADE'), index=True)
    platform_post_id: Mapped[str | None] = mapped_column(String(128), nullable=True)
    platform_url: Mapped[str | None] = mapped_column(String(1024), nullable=True)
    status: Mapped[PublishStatus] = mapped_column(Enum(PublishStatus), default=PublishStatus.queued)
    scheduled_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    published_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    error_message: Mapped[str | None] = mapped_column(Text, nullable=True)
    payload_json: Mapped[dict] = mapped_column(JSON, default=dict)


class ContentPattern(Base):
    __tablename__ = 'content_patterns'
    __table_args__ = (UniqueConstraint('project_id', 'pattern_key', name='uq_project_pattern'),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    project_id: Mapped[int] = mapped_column(ForeignKey('projects.id', ondelete='CASCADE'), index=True)
    pattern_key: Mapped[str] = mapped_column(String(64), nullable=False)
    enabled: Mapped[bool] = mapped_column(Boolean, default=True)
    outline_json: Mapped[list] = mapped_column(JSON, default=list)
    cta_text: Mapped[str | None] = mapped_column(Text, nullable=True)
    faq_schema_enabled: Mapped[bool] = mapped_column(Boolean, default=False)
    usage_count: Mapped[int] = mapped_column(Integer, default=0)
    last_used_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)

    project: Mapped['Project'] = relationship(back_populates='patterns')


class Setting(Base):
    __tablename__ = 'settings'

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    key: Mapped[str] = mapped_column(String(128), nullable=False, unique=True, index=True)
    value_encrypted: Mapped[str | None] = mapped_column(Text, nullable=True)
    value_masked: Mapped[str | None] = mapped_column(Text, nullable=True)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)


class DraftImage(Base):
    __tablename__ = 'draft_images'

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    draft_id: Mapped[int] = mapped_column(ForeignKey('drafts.id', ondelete='CASCADE'), index=True)
    project_id: Mapped[int] = mapped_column(ForeignKey('projects.id', ondelete='CASCADE'), index=True)
    kind: Mapped[str] = mapped_column(String(32), default='featured')
    image_path: Mapped[str] = mapped_column(String(1024), nullable=False)
    prompt: Mapped[str | None] = mapped_column(Text, nullable=True)
    alt_text: Mapped[str | None] = mapped_column(String(255), nullable=True)
    caption: Mapped[str | None] = mapped_column(String(255), nullable=True)
    position: Mapped[int] = mapped_column(Integer, default=0)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)

    draft: Mapped['Draft'] = relationship(back_populates='images')


class CrawlRun(Base):
    __tablename__ = 'crawl_runs'

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    project_id: Mapped[int | None] = mapped_column(ForeignKey('projects.id', ondelete='SET NULL'), nullable=True, index=True)
    cache_key: Mapped[str] = mapped_column(String(191), nullable=False, unique=True, index=True)
    keyword: Mapped[str] = mapped_column(String(255), nullable=False)
    country: Mapped[str] = mapped_column(String(16), nullable=False, default='us')
    language: Mapped[str] = mapped_column(String(16), nullable=False, default='en')
    provider: Mapped[str] = mapped_column(String(64), nullable=False, default='opencrawl')
    crawl_json: Mapped[dict] = mapped_column(JSON, default=dict)
    fetched_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow, index=True)
    expires_at: Mapped[datetime] = mapped_column(DateTime, nullable=False, index=True)


class CompetitorPage(Base):
    __tablename__ = 'competitor_pages'

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    pipeline_run_id: Mapped[int] = mapped_column(ForeignKey('pipeline_runs.id', ondelete='CASCADE'), index=True)
    project_id: Mapped[int] = mapped_column(ForeignKey('projects.id', ondelete='CASCADE'), index=True)
    url: Mapped[str] = mapped_column(String(1024), nullable=False)
    domain: Mapped[str] = mapped_column(String(255), nullable=False, default='')
    title: Mapped[str] = mapped_column(String(512), nullable=False, default='')
    snippet: Mapped[str] = mapped_column(Text, nullable=False, default='')
    discovery_order: Mapped[int] = mapped_column(Integer, default=0)
    competitive_strength_score: Mapped[float] = mapped_column(Float, default=0.0)
    freshness_score: Mapped[float] = mapped_column(Float, default=0.0)
    inlink_count: Mapped[int | None] = mapped_column(Integer, nullable=True)
    discovered_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    last_seen_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    fetch_status: Mapped[str] = mapped_column(String(32), default='pending')
    http_status: Mapped[int | None] = mapped_column(Integer, nullable=True)
    fetch_error_type: Mapped[str | None] = mapped_column(String(64), nullable=True)
    error_message: Mapped[str | None] = mapped_column(Text, nullable=True)
    html_snapshot: Mapped[str | None] = mapped_column(Text, nullable=True)
    fetched_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)


class CompetitorExtract(Base):
    __tablename__ = 'competitor_extracts'

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    competitor_page_id: Mapped[int] = mapped_column(ForeignKey('competitor_pages.id', ondelete='CASCADE'), index=True)
    pipeline_run_id: Mapped[int] = mapped_column(ForeignKey('pipeline_runs.id', ondelete='CASCADE'), index=True)
    project_id: Mapped[int] = mapped_column(ForeignKey('projects.id', ondelete='CASCADE'), index=True)
    url: Mapped[str] = mapped_column(String(1024), nullable=False)
    headings_json: Mapped[dict] = mapped_column(JSON, default=dict)
    entities_json: Mapped[list] = mapped_column(JSON, default=list)
    faqs_json: Mapped[list] = mapped_column(JSON, default=list)
    metrics_json: Mapped[dict] = mapped_column(JSON, default=dict)
    trust_signals_json: Mapped[dict] = mapped_column(JSON, default=dict)
    plain_text: Mapped[str | None] = mapped_column(Text, nullable=True)
    extracted_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)


class BlogBrief(Base):
    __tablename__ = 'blog_briefs'

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    pipeline_run_id: Mapped[int] = mapped_column(ForeignKey('pipeline_runs.id', ondelete='CASCADE'), index=True)
    project_id: Mapped[int] = mapped_column(ForeignKey('projects.id', ondelete='CASCADE'), index=True)
    keyword: Mapped[str] = mapped_column(String(255), nullable=False)
    intent_mix_json: Mapped[dict] = mapped_column(JSON, default=dict)
    required_sections_json: Mapped[list] = mapped_column(JSON, default=list)
    differentiators_json: Mapped[list] = mapped_column(JSON, default=list)
    internal_link_plan_json: Mapped[list] = mapped_column(JSON, default=list)
    cta_plan_json: Mapped[dict] = mapped_column(JSON, default=dict)
    brief_json: Mapped[dict] = mapped_column(JSON, default=dict)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)


class BlogQa(Base):
    __tablename__ = 'blog_qa'

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    draft_id: Mapped[int] = mapped_column(ForeignKey('drafts.id', ondelete='CASCADE'), index=True)
    pipeline_run_id: Mapped[int] = mapped_column(ForeignKey('pipeline_runs.id', ondelete='CASCADE'), index=True)
    project_id: Mapped[int] = mapped_column(ForeignKey('projects.id', ondelete='CASCADE'), index=True)
    completeness_score: Mapped[float] = mapped_column(Float, default=0.0)
    readability_score: Mapped[float] = mapped_column(Float, default=0.0)
    practicality_score: Mapped[float] = mapped_column(Float, default=0.0)
    eeat_score: Mapped[float] = mapped_column(Float, default=0.0)
    domain_mismatch_score: Mapped[float] = mapped_column(Float, default=100.0)
    overall_score: Mapped[float] = mapped_column(Float, default=0.0)
    qa_json: Mapped[dict] = mapped_column(JSON, default=dict)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)


class BacklinkCampaign(Base):
    __tablename__ = 'backlink_campaigns'

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    project_id: Mapped[int] = mapped_column(ForeignKey('projects.id', ondelete='CASCADE'), index=True)
    name: Mapped[str] = mapped_column(String(255), nullable=False)
    website_url: Mapped[str] = mapped_column(String(1024), nullable=False)
    business_name: Mapped[str | None] = mapped_column(String(255), nullable=True)
    contact_email: Mapped[str | None] = mapped_column(String(255), nullable=True)
    phone: Mapped[str | None] = mapped_column(String(64), nullable=True)
    address: Mapped[str | None] = mapped_column(String(512), nullable=True)
    profile_notes: Mapped[str | None] = mapped_column(Text, nullable=True)
    status: Mapped[str] = mapped_column(String(32), default='draft')
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)

    project: Mapped['Project'] = relationship(back_populates='backlink_campaigns')
    targets: Mapped[list['BacklinkTarget']] = relationship(back_populates='campaign', cascade='all, delete-orphan')
    opportunities: Mapped[list['BacklinkOpportunity']] = relationship(
        back_populates='campaign', cascade='all, delete-orphan'
    )


class BacklinkTarget(Base):
    __tablename__ = 'backlink_targets'

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    campaign_id: Mapped[int] = mapped_column(ForeignKey('backlink_campaigns.id', ondelete='CASCADE'), index=True)
    target_url: Mapped[str] = mapped_column(String(1024), nullable=False)
    anchor_text: Mapped[str | None] = mapped_column(String(255), nullable=True)
    notes: Mapped[str | None] = mapped_column(Text, nullable=True)
    priority: Mapped[int] = mapped_column(Integer, default=1)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)

    campaign: Mapped['BacklinkCampaign'] = relationship(back_populates='targets')
    opportunities: Mapped[list['BacklinkOpportunity']] = relationship(back_populates='target', cascade='all, delete-orphan')


class BacklinkOpportunity(Base):
    __tablename__ = 'backlink_opportunities'

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    campaign_id: Mapped[int] = mapped_column(ForeignKey('backlink_campaigns.id', ondelete='CASCADE'), index=True)
    target_id: Mapped[int | None] = mapped_column(
        ForeignKey('backlink_targets.id', ondelete='SET NULL'), index=True, nullable=True
    )
    domain: Mapped[str] = mapped_column(String(255), nullable=False)
    source_url: Mapped[str | None] = mapped_column(String(1024), nullable=True)
    source_type: Mapped[str] = mapped_column(String(64), default='profile')
    profile_title: Mapped[str | None] = mapped_column(String(255), nullable=True)
    profile_description: Mapped[str | None] = mapped_column(Text, nullable=True)
    suggested_anchor: Mapped[str | None] = mapped_column(String(255), nullable=True)
    suggested_target_url: Mapped[str | None] = mapped_column(String(1024), nullable=True)
    action_steps_json: Mapped[list] = mapped_column(JSON, default=list)
    status: Mapped[str] = mapped_column(String(32), default='planned')
    placed_url: Mapped[str | None] = mapped_column(String(1024), nullable=True)
    notes: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)

    campaign: Mapped['BacklinkCampaign'] = relationship(back_populates='opportunities')
    target: Mapped['BacklinkTarget | None'] = relationship(back_populates='opportunities')
