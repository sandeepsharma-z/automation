import asyncio
import logging
import re
import time
from datetime import datetime

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.api.deps import get_current_admin
from app.db.session import get_db
from app.models.entities import Draft, DraftStatus, Project, PublishRecord, PublishStatus, Topic
from app.schemas.entities import DraftListItemResponse, DraftResponse, DraftUpdate, PublishRequest
from app.services.publishers.shopify_publisher import publish_shopify_draft
from app.services.publishers.wordpress_publisher import publish_wordpress_draft
from app.services.connectors.wordpress_runtime import resolve_wordpress_runtime_config, wordpress_whoami_probe
from app.services.settings import resolve_project_runtime_config

router = APIRouter(prefix='/api/drafts', tags=['drafts'], dependencies=[Depends(get_current_admin)])
logger = logging.getLogger(__name__)


def _error_text(exc: Exception) -> str:
    message = str(exc).strip()
    if message:
        return message
    detail = getattr(exc, 'detail', None)
    if detail:
        return str(detail)
    return f'{exc.__class__.__name__}: publish failed'


def _resolve_unique_slug(db: Session, draft: Draft) -> str:
    base_slug = (draft.slug or 'post').strip().strip('-') or 'post'
    candidate = base_slug[:240]
    suffix = 2
    while db.execute(
        select(Draft.id).where(
            Draft.project_id == draft.project_id,
            Draft.slug == candidate,
            Draft.id != draft.id,
        )
    ).first():
        candidate = f"{base_slug[:220]}-{suffix}"
        suffix += 1
    return candidate


def _slugify_text(text: str) -> str:
    slug = re.sub(r'[^a-zA-Z0-9\s-]', '', str(text or '')).strip().lower()
    slug = re.sub(r'[\s_-]+', '-', slug).strip('-')
    return slug[:80] or 'post'


def _preferred_publish_slug(draft: Draft, topic: Topic | None) -> str:
    current = str(draft.slug or '').strip()
    title_slug = _slugify_text(draft.title or '')
    keyword_slug = _slugify_text(topic.primary_keyword) if topic and topic.primary_keyword else ''
    if current and current != title_slug:
        return current
    if keyword_slug:
        return keyword_slug
    return current or title_slug or 'post'


def _cap_tags(values: list[str], max_items: int = 5) -> list[str]:
    deduped: list[str] = []
    seen: set[str] = set()
    for value in values:
        tag = str(value or '').strip()
        if not tag:
            continue
        key = tag.lower()
        if key in seen:
            continue
        seen.add(key)
        deduped.append(tag)
        if len(deduped) >= max_items:
            break
    return deduped


@router.get('', response_model=list[DraftListItemResponse])
def list_drafts(
    project_id: int | None = Query(default=None),
    limit: int = Query(default=20, ge=1, le=200),
    db: Session = Depends(get_db),
) -> list[Draft]:
    query = select(Draft).order_by(Draft.created_at.desc())
    if project_id is not None:
        query = query.where(Draft.project_id == project_id)
    return db.execute(query.limit(limit)).scalars().all()


@router.get('/{draft_id}', response_model=DraftResponse)
def get_draft(draft_id: int, db: Session = Depends(get_db)) -> Draft:
    draft = db.get(Draft, draft_id)
    if not draft:
        raise HTTPException(status_code=404, detail='Draft not found')
    return draft


@router.put('/{draft_id}', response_model=DraftResponse)
def update_draft(draft_id: int, payload: DraftUpdate, db: Session = Depends(get_db)) -> Draft:
    draft = db.get(Draft, draft_id)
    if not draft:
        raise HTTPException(status_code=404, detail='Draft not found')

    for key, value in payload.model_dump(exclude_unset=True).items():
        setattr(draft, key, value)

    db.add(draft)
    db.commit()
    db.refresh(draft)
    return draft


@router.post('/{draft_id}/approve', response_model=DraftResponse)
def approve_draft(draft_id: int, db: Session = Depends(get_db)) -> Draft:
    draft = db.get(Draft, draft_id)
    if not draft:
        raise HTTPException(status_code=404, detail='Draft not found')
    if draft.status == DraftStatus.published:
        # Idempotent behavior for UX simplicity.
        return draft

    draft.status = DraftStatus.approved
    db.add(draft)
    db.commit()
    db.refresh(draft)
    return draft


@router.post('/{draft_id}/publish')
def publish_draft(draft_id: int, payload: PublishRequest, db: Session = Depends(get_db)) -> dict:
    started = time.perf_counter()
    wp_log_context: dict | None = None
    draft = db.get(Draft, draft_id)
    if not draft:
        raise HTTPException(status_code=404, detail='Draft not found')

    project = db.get(Project, draft.project_id)
    if not project:
        raise HTTPException(status_code=404, detail='Project not found')
    topic = db.get(Topic, draft.topic_id) if draft.topic_id else None

    runtime = resolve_project_runtime_config(db, project)
    # Allow direct publish from any draft state for operator-first workflow.
    # Approval remains useful for editorial control, but is not mandatory at publish time.

    requested_mode = payload.mode or runtime.get('default_publish_mode', 'draft')
    normalized_mode = str(requested_mode).lower()
    if normalized_mode == 'publish':
        normalized_mode = 'publish_now'
    if normalized_mode not in {'draft', 'publish_now', 'scheduled'}:
        raise HTTPException(status_code=400, detail='Invalid publish mode')

    now = datetime.utcnow()
    record_status = PublishStatus.queued
    if normalized_mode == 'scheduled':
        if not payload.scheduled_at:
            raise HTTPException(status_code=400, detail='scheduled_at is required for scheduled mode')
        if payload.scheduled_at <= now:
            raise HTTPException(status_code=400, detail='scheduled_at must be in the future')
        record_status = PublishStatus.scheduled

    record = PublishRecord(
        draft_id=draft.id,
        project_id=draft.project_id,
        status=record_status,
        scheduled_at=payload.scheduled_at,
        payload_json={**payload.model_dump(mode='json'), 'mode': normalized_mode},
    )
    db.add(record)
    db.commit()
    db.refresh(record)

    if record_status == PublishStatus.scheduled:
        return {'publish_record_id': record.id, 'status': 'scheduled'}

    try:
        draft.status = DraftStatus.publishing
        draft.slug = _preferred_publish_slug(draft, topic)
        draft.slug = _resolve_unique_slug(db, draft)
        db.add(draft)
        db.commit()

        tags_payload = list(payload.tags or [])
        if not tags_payload and topic:
            tags_payload = [topic.primary_keyword, *(topic.secondary_keywords_json or [])]
        tags_payload = _cap_tags(tags_payload, max_items=5)
        categories_payload = list(payload.categories or [])
        focus_keyphrase = topic.primary_keyword if topic else (tags_payload[0] if tags_payload else draft.title)

        if project.platform.value == 'wordpress':
            wp_runtime = resolve_wordpress_runtime_config(db, project)
            probe = asyncio.run(wordpress_whoami_probe(wp_runtime, timeout_seconds=15.0))
            wp_log_context = {
                'event': 'wordpress_publish',
                'project_id': project.id,
                'draft_id': draft.id,
                'wp_url': wp_runtime.wp_url,
                'auth_mode': wp_runtime.auth_mode,
                'wp_user_present': bool(wp_runtime.wp_user),
                'wp_pass_present': bool(wp_runtime.wp_app_password),
                'wp_token_present': bool(wp_runtime.wp_connector_token),
                'wp_user_source': wp_runtime.wp_user_source,
                'wp_pass_source': wp_runtime.wp_pass_source,
                'wp_token_source': wp_runtime.wp_token_source,
                'authorization_attached': bool(probe.get('auth_header_attached')),
                'upstream_status': probe.get('status'),
                'upstream_snippet': str(probe.get('response_snippet') or '')[:300],
            }
            published = asyncio.run(
                publish_wordpress_draft(
                    project,
                    draft,
                    mode=normalized_mode,
                    scheduled_at=payload.scheduled_at.isoformat() if payload.scheduled_at else None,
                    tags=tags_payload,
                    categories=categories_payload,
                    focus_keyphrase=focus_keyphrase,
                    runtime_config=wp_runtime,
                )
            )
            wp_log_context['duration_ms'] = int((time.perf_counter() - started) * 1000)
            logger.info('wordpress_publish_ok', extra={'extra': wp_log_context})
        elif project.platform.value == 'shopify':
            published = asyncio.run(
                publish_shopify_draft(
                    project,
                    draft,
                    mode=normalized_mode,
                    scheduled_at=payload.scheduled_at.isoformat() if payload.scheduled_at else None,
                    tags=tags_payload,
                    blog_id=None,
                )
            )
        else:
            raise RuntimeError('Unsupported platform for publishing')

        record.platform_post_id = published.get('platform_post_id')
        record.platform_url = published.get('platform_url')
        record.status = PublishStatus.published
        record.published_at = datetime.utcnow()
        record.error_message = None

        draft.status = DraftStatus.published if normalized_mode in {'publish_now', 'scheduled'} else DraftStatus.approved
        draft.platform_post_id = published.get('platform_post_id')
        draft.publish_url = published.get('platform_url')
        db.add(record)
        db.add(draft)
        db.commit()
        return {
            'publish_record_id': record.id,
            'status': 'published',
            'platform_post_id': record.platform_post_id,
            'platform_url': record.platform_url,
            'shopify_article_id': record.platform_post_id if project.platform.value == 'shopify' else None,
            'published_url': record.platform_url,
        }
    except Exception as exc:
        error_text = _error_text(exc)
        if project.platform.value == 'wordpress':
            log_payload = dict(wp_log_context or {})
            log_payload.update(
                {
                    'event': 'wordpress_publish',
                    'project_id': project.id,
                    'draft_id': draft.id,
                    'duration_ms': int((time.perf_counter() - started) * 1000),
                    'upstream_snippet': error_text[:300],
                    'exception_type': exc.__class__.__name__,
                    'exception_message': str(exc),
                }
            )
            logger.exception(
                'wordpress_publish_failed',
                extra={'extra': log_payload},
            )
        record.status = PublishStatus.failed
        record.error_message = error_text
        draft.status = DraftStatus.failed
        db.add(record)
        db.add(draft)
        db.commit()
        raise HTTPException(status_code=400, detail=error_text) from exc
