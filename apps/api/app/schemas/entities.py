from datetime import datetime
from typing import Any

from pydantic import BaseModel, Field

from app.models.entities import DraftStatus, PipelineStatus, PlatformType, PublishStatus, TopicStatus


class TokenRequest(BaseModel):
    username: str
    password: str


class TokenResponse(BaseModel):
    access_token: str
    token_type: str = 'bearer'


class ProjectCreate(BaseModel):
    name: str
    platform: PlatformType
    base_url: str
    wp_user: str | None = None
    wp_app_password: str | None = None
    wordpress_auth_mode: str | None = None
    wp_connector_token: str | None = None
    shopify_store: str | None = None
    shopify_token: str | None = None
    shopify_blog_id: int | None = None
    shopify_author: str | None = None
    shopify_tags: list[str] | None = None
    shopify_published: bool | None = None
    settings_json: dict[str, Any] = Field(default_factory=dict)


class ProjectUpdate(BaseModel):
    name: str | None = None
    base_url: str | None = None
    wp_user: str | None = None
    wp_app_password: str | None = None
    wordpress_auth_mode: str | None = None
    wp_connector_token: str | None = None
    shopify_store: str | None = None
    shopify_token: str | None = None
    shopify_blog_id: int | None = None
    shopify_author: str | None = None
    shopify_tags: list[str] | None = None
    shopify_published: bool | None = None
    settings_json: dict[str, Any] | None = None


class ProjectResponse(BaseModel):
    id: int
    name: str
    platform: PlatformType
    base_url: str
    wp_user: str | None
    shopify_store: str | None
    settings_json: dict[str, Any]
    created_at: datetime

    model_config = {'from_attributes': True}


class TopicCreate(BaseModel):
    title: str
    primary_keyword: str
    secondary_keywords_json: list[str] = Field(default_factory=list)
    desired_word_count: int = 1200


class TopicResponse(BaseModel):
    id: int
    project_id: int
    title: str
    primary_keyword: str
    secondary_keywords_json: list[str]
    status: TopicStatus
    desired_word_count: int
    created_at: datetime

    model_config = {'from_attributes': True}


class PipelineRunResponse(BaseModel):
    id: int
    topic_id: int
    project_id: int
    status: PipelineStatus
    stage: str
    started_at: datetime | None
    finished_at: datetime | None
    error_message: str | None

    model_config = {'from_attributes': True}


class PipelineEventResponse(BaseModel):
    id: int
    pipeline_run_id: int
    level: str
    message: str
    meta_json: dict[str, Any]
    created_at: datetime

    model_config = {'from_attributes': True}


class DraftResponse(BaseModel):
    id: int
    topic_id: int
    project_id: int
    title: str
    slug: str
    html: str
    outline_json: list[str]
    meta_title: str
    meta_description: str
    faq_json: list[dict[str, Any]] | list[str]
    schema_jsonld: dict[str, Any]
    internal_links_json: list[dict[str, Any]]
    sources_json: list[dict[str, Any]]
    image_path: str | None
    image_prompt: str | None
    alt_text: str | None
    caption: str | None
    pattern_key: str | None
    structure_type: str | None = None
    outline_fingerprint: str | None = None
    intro_style: str | None = None
    cta_style: str | None = None
    faq_count: int = 0
    similarity_score: float = 0.0
    platform: str
    platform_post_id: str | None = None
    publish_url: str | None = None
    status: DraftStatus
    token_input: int
    token_output: int
    cost_estimate_usd: float
    created_at: datetime

    model_config = {'from_attributes': True}


class DraftListItemResponse(BaseModel):
    id: int
    project_id: int
    topic_id: int
    title: str
    slug: str
    status: DraftStatus
    platform: str
    similarity_score: float = 0.0
    image_path: str | None = None
    created_at: datetime

    model_config = {'from_attributes': True}


class DraftUpdate(BaseModel):
    title: str | None = None
    slug: str | None = None
    html: str | None = None
    outline_json: list[str] | None = None
    meta_title: str | None = None
    meta_description: str | None = None
    internal_links_json: list[dict[str, Any]] | None = None
    status: DraftStatus | None = None


class PublishRequest(BaseModel):
    mode: str = Field(default='draft')
    scheduled_at: datetime | None = None
    tags: list[str] = Field(default_factory=list)
    categories: list[str] = Field(default_factory=list)


class PublishRecordResponse(BaseModel):
    id: int
    draft_id: int
    project_id: int
    platform_post_id: str | None
    platform_url: str | None
    status: PublishStatus
    scheduled_at: datetime | None
    published_at: datetime | None
    error_message: str | None

    model_config = {'from_attributes': True}


class LibraryItemResponse(BaseModel):
    id: int
    project_id: int
    type: str
    title: str
    url: str
    handle: str | None
    tags_json: list[Any]
    last_synced_at: datetime | None

    model_config = {'from_attributes': True}


class PatternResponse(BaseModel):
    id: int
    project_id: int
    pattern_key: str
    enabled: bool
    outline_json: list[str] | None = Field(default_factory=list)
    cta_text: str | None = None
    faq_schema_enabled: bool | None = False
    usage_count: int
    last_used_at: datetime | None

    model_config = {'from_attributes': True}


class RagStatusResponse(BaseModel):
    project_id: int
    doc_count: int
    indexed_at: str | None = None


class PatternUpdate(BaseModel):
    enabled: bool | None = None
    outline_json: list[str] | None = None
    cta_text: str | None = None
    faq_schema_enabled: bool | None = None


class SettingValueUpdate(BaseModel):
    value: Any


class SettingItemResponse(BaseModel):
    key: str
    value: Any
    is_secret: bool
    updated_at: datetime | None = None


class SettingsListResponse(BaseModel):
    items: list[SettingItemResponse]
    provider_health: dict[str, Any]


class BlogAgentGenerateRequest(BaseModel):
    project_id: int
    platform: str = 'none'
    topic: str | None = None
    primary_keyword: str | None = None
    secondary_keywords: list[str] = Field(default_factory=list)
    tone: str = 'professional'
    country: str = 'us'
    language: str = 'en'
    desired_word_count: int = Field(default=1200, ge=300, le=5000)
    image_mode: str = 'featured_only'
    inline_images_count: int = Field(default=0, ge=0, le=3)
    outline_override: list[str] | None = None
    autopublish: bool = False
    publish_status: str = 'draft'
    schedule_datetime: datetime | None = None
    force_new: bool = False


class BlogAgentOutlineRequest(BlogAgentGenerateRequest):
    pass


class BlogAgentRegenerateRequest(BaseModel):
    force_different_structure: bool = True
    tone: str | None = None
    image_mode: str = 'featured_only'
    inline_images_count: int = Field(default=0, ge=0, le=3)
    outline_override: list[str] | None = None


class BlogAgentImagesRequest(BaseModel):
    image_mode: str = 'featured_only'
    inline_images_count: int = Field(default=0, ge=0, le=3)


class BlogAgentPublishRequest(BaseModel):
    mode: str = 'draft'
    platform: str = 'none'
    scheduled_at: datetime | None = None
    tags: list[str] = Field(default_factory=list)
    categories: list[str] = Field(default_factory=list)
    blog_id: int | None = None


class CompetitorComposeRequest(BaseModel):
    keyword: str
    competitor_urls: list[str] = Field(default_factory=list)
    brand_voice: str | None = None
    target_audience: str | None = None
    locale: str | None = None
    run_id: str | None = None


class CompetitorComposeResponse(BaseModel):
    keyword: str
    competitor_pack: dict[str, Any]
    winning_outline: dict[str, Any]
    blog: dict[str, Any]
    debug: dict[str, Any]


class SeoReportRunRequest(BaseModel):
    website_url: str
    keywords: list[str] = Field(default_factory=list)
    country: str = 'in'
    language: str = 'en'


class SeoReportRunResponse(BaseModel):
    website_url: str
    domain: str
    provider: str
    country: str
    language: str
    summary: dict[str, Any]
    items: list[dict[str, Any]]


class BacklinkCampaignCreate(BaseModel):
    name: str
    website_url: str
    business_name: str | None = None
    contact_email: str | None = None
    phone: str | None = None
    address: str | None = None
    profile_notes: str | None = None
    status: str = 'draft'


class BacklinkCampaignResponse(BaseModel):
    id: int
    project_id: int
    name: str
    website_url: str
    business_name: str | None = None
    contact_email: str | None = None
    phone: str | None = None
    address: str | None = None
    profile_notes: str | None = None
    status: str
    created_at: datetime
    updated_at: datetime

    model_config = {'from_attributes': True}


class BacklinkTargetInput(BaseModel):
    target_url: str
    anchor_text: str | None = None
    notes: str | None = None
    priority: int = 1


class BacklinkTargetsUpsertRequest(BaseModel):
    targets: list[BacklinkTargetInput] = Field(default_factory=list)


class BacklinkTargetResponse(BaseModel):
    id: int
    campaign_id: int
    target_url: str
    anchor_text: str | None = None
    notes: str | None = None
    priority: int
    created_at: datetime
    updated_at: datetime

    model_config = {'from_attributes': True}


class BacklinkPlanRequest(BaseModel):
    target_domains: list[str] = Field(default_factory=list)
    objective: str | None = None


class BacklinkOpportunityUpdate(BaseModel):
    status: str | None = None
    placed_url: str | None = None
    notes: str | None = None


class BacklinkOpportunityResponse(BaseModel):
    id: int
    campaign_id: int
    target_id: int | None = None
    domain: str
    source_url: str | None = None
    source_type: str
    profile_title: str | None = None
    profile_description: str | None = None
    suggested_anchor: str | None = None
    suggested_target_url: str | None = None
    action_steps_json: list[Any] = Field(default_factory=list)
    status: str
    placed_url: str | None = None
    notes: str | None = None
    created_at: datetime
    updated_at: datetime

    model_config = {'from_attributes': True}


class BacklinkCampaignDetailResponse(BaseModel):
    campaign: BacklinkCampaignResponse
    targets: list[BacklinkTargetResponse] = Field(default_factory=list)
    opportunities: list[BacklinkOpportunityResponse] = Field(default_factory=list)


class BacklinkDiscoveredCreate(BaseModel):
    source_url: str
    target_url: str
    anchor_text: str | None = None
    rel_type: str | None = None
    discovered_at: datetime | None = None
    domain_authority_placeholder: float | None = 0.0


class BacklinkDiscoveredBatchRequest(BaseModel):
    items: list[BacklinkDiscoveredCreate] = Field(default_factory=list)


class BacklinkDiscoveredResponse(BaseModel):
    id: int
    source_url: str
    target_url: str
    anchor_text: str | None = None
    rel_type: str | None = None
    discovered_at: datetime
    domain_authority_placeholder: float | None = None

    model_config = {'from_attributes': True}
