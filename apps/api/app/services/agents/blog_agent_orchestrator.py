from __future__ import annotations

import asyncio
from datetime import datetime, timedelta
import re
from threading import Lock
from typing import Any

from sqlalchemy import func, select
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import Session

from app.models.entities import (
    BlogBrief,
    BlogQa,
    CompetitorExtract,
    CompetitorPage,
    ContentLibraryItem,
    Draft,
    DraftStatus,
    PipelineEvent,
    PipelineRun,
    PipelineStatus,
    PlatformType,
    Project,
    PublishRecord,
    PublishStatus,
    Topic,
    TopicStatus,
)
from app.services.connectors.factory import build_connector
from app.services.agents.image_agent import generate_images_for_draft, list_draft_images
from app.services.events import log_pipeline_event
from app.services.pipeline.engine import (
    reindex_project_rag,
    reset_project_library,
    save_library_items,
    stage_brief,
    stage_draft,
    stage_qa,
    stage_research,
    stage_save_draft,
    slugify,
)
from app.services.publishers.shopify_publisher import publish_shopify_draft
from app.services.publishers.wordpress_publisher import publish_wordpress_draft
from app.services.quality.diversity_engine import (
    build_draft_metadata,
    choose_next_structure,
    no_identical_h2_sequence,
)
from app.services.quality.similarity_guard import compare_against_recent_drafts, should_regenerate
from app.services.settings import resolve_project_runtime_config

MAX_REGEN_ATTEMPTS = 2
ACTIVE_RUN_TIMEOUT_MINUTES = 30
_PROJECT_LOCK_GUARD = Lock()
_PROJECT_LOCKS: dict[int, Lock] = {}

AUTO_SYNC_LIBRARY_MAX_AGE_HOURS = 24
RECENT_DUPLICATE_WINDOW_MINUTES = 60


def _get_project_lock(project_id: int) -> Lock:
    with _PROJECT_LOCK_GUARD:
        lock = _PROJECT_LOCKS.get(project_id)
        if lock is None:
            lock = Lock()
            _PROJECT_LOCKS[project_id] = lock
    return lock


def _expire_or_reject_active_runs(db: Session, project_id: int) -> None:
    now = datetime.utcnow()
    cutoff = now - timedelta(minutes=ACTIVE_RUN_TIMEOUT_MINUTES)
    active = db.execute(
        select(PipelineRun)
        .where(
            PipelineRun.project_id == project_id,
            PipelineRun.status.in_([PipelineStatus.queued, PipelineStatus.running]),
            PipelineRun.finished_at.is_(None),
        )
        .order_by(PipelineRun.id.desc())
    ).scalars().all()

    changed = False
    for run in active:
        started_at = run.started_at or now
        if started_at < cutoff:
            run.status = PipelineStatus.failed
            run.stage = 'failed'
            run.error_message = 'Auto-expired stale run before new generation request'
            run.finished_at = now
            changed = True
            topic = db.get(Topic, run.topic_id)
            if topic and topic.status in {TopicStatus.pending, TopicStatus.running}:
                topic.status = TopicStatus.failed
                db.add(topic)
        else:
            raise RuntimeError(
                f'Generation already in progress for this project (run #{run.id}). Please wait for completion.'
            )
    if changed:
        db.commit()


def _mark_latest_active_run_failed(db: Session, project_id: int, message: str) -> None:
    run = db.execute(
        select(PipelineRun)
        .where(
            PipelineRun.project_id == project_id,
            PipelineRun.status.in_([PipelineStatus.queued, PipelineStatus.running]),
            PipelineRun.finished_at.is_(None),
        )
        .order_by(PipelineRun.id.desc())
        .limit(1)
    ).scalar_one_or_none()
    if not run:
        return

    run.status = PipelineStatus.failed
    run.stage = 'failed'
    run.error_message = str(message or 'Generation failed')
    run.finished_at = datetime.utcnow()
    db.add(run)

    topic = db.get(Topic, run.topic_id)
    if topic and topic.status in {TopicStatus.pending, TopicStatus.running}:
        topic.status = TopicStatus.failed
        db.add(topic)

    db.commit()
    log_pipeline_event(db, run.id, 'error', 'Pipeline failed', {'error': run.error_message})


def _public_media_path(value: str | None) -> str | None:
    if not value:
        return None
    raw = str(value).strip()
    if not raw:
        return None
    if raw.startswith('http://') or raw.startswith('https://'):
        return raw

    normalized = raw.replace('\\', '/')
    marker = '/media/'
    if marker in normalized:
        suffix = normalized.split(marker, 1)[1].lstrip('/')
        return f"/media/{suffix}"
    if normalized.startswith('media/'):
        return f"/{normalized}"
    if 'storage/media/' in normalized:
        suffix = normalized.split('storage/media/', 1)[1].lstrip('/')
        return f"/media/{suffix}"
    return raw


def _html_word_count(html: str | None) -> int:
    text = re.sub(r'<[^>]+>', ' ', str(html or ''))
    return len(re.findall(r'\b\w+\b', text))


def _find_recent_duplicate_draft(
    db: Session,
    *,
    project_id: int,
    topic_title: str,
    primary_keyword: str,
    minutes: int = RECENT_DUPLICATE_WINDOW_MINUTES,
) -> Draft | None:
    cutoff = datetime.utcnow() - timedelta(minutes=max(1, minutes))
    return db.execute(
        select(Draft)
        .join(Topic, Topic.id == Draft.topic_id)
        .where(
            Draft.project_id == project_id,
            Draft.created_at >= cutoff,
            Topic.project_id == project_id,
            Topic.title == topic_title,
            Topic.primary_keyword == primary_keyword,
        )
        .order_by(Draft.id.desc())
        .limit(1)
    ).scalar_one_or_none()


def _find_recent_duplicate_by_keyword(
    db: Session,
    *,
    project_id: int,
    primary_keyword: str,
    minutes: int = RECENT_DUPLICATE_WINDOW_MINUTES,
) -> Draft | None:
    cutoff = datetime.utcnow() - timedelta(minutes=max(1, minutes))
    return db.execute(
        select(Draft)
        .join(Topic, Topic.id == Draft.topic_id)
        .where(
            Draft.project_id == project_id,
            Draft.created_at >= cutoff,
            Topic.project_id == project_id,
            Topic.primary_keyword == primary_keyword,
        )
        .order_by(Draft.id.desc())
        .limit(1)
    ).scalar_one_or_none()


def _should_reuse_duplicate(draft: Draft) -> bool:
    title = str(draft.title or '').lower()
    html = str(draft.html or '').lower()
    bad_title_signals = [
        'complete guide to',
        'for my seo blog',
    ]
    bad_html_signals = [
        'single-generate-dedupe-keyword',
        'outline generated. run full generation to create content.',
    ]
    if any(signal in title for signal in bad_title_signals):
        return False
    if any(signal in html for signal in bad_html_signals):
        return False
    if draft.status in {DraftStatus.failed}:
        return False
    return True


def _create_topic_and_run(
    db: Session,
    *,
    project_id: int,
    topic: str,
    primary_keyword: str,
    secondary_keywords: list[str],
    desired_word_count: int,
) -> tuple[Topic, PipelineRun]:
    _expire_or_reject_active_runs(db, project_id)
    topic_row = Topic(
        project_id=project_id,
        title=topic,
        primary_keyword=primary_keyword,
        secondary_keywords_json=secondary_keywords,
        desired_word_count=desired_word_count,
        status=TopicStatus.pending,
    )
    db.add(topic_row)
    db.commit()
    db.refresh(topic_row)

    run = PipelineRun(
        topic_id=topic_row.id,
        project_id=project_id,
        status=PipelineStatus.queued,
        stage='queued',
        started_at=datetime.utcnow(),
    )
    db.add(run)
    db.commit()
    db.refresh(run)
    return topic_row, run


def _normalize_platform(project: Project, requested_platform: str | None) -> str:
    platform = (requested_platform or 'none').strip().lower()
    if platform == 'none':
        return project.platform.value if isinstance(project.platform, PlatformType) else str(project.platform)
    return platform


def _normalize_keywords(primary_keyword: str | None, secondary_keywords: list[str] | None) -> tuple[str, list[str]]:
    secondary = [str(item).strip() for item in (secondary_keywords or []) if str(item).strip()]
    primary = str(primary_keyword or '').strip()
    if not primary and secondary:
        primary = secondary[0]
        secondary = secondary[1:]
    if not primary:
        raise RuntimeError('Provide at least one keyword (primary or secondary).')
    return primary, secondary


def _normalize_keyword_key(value: str) -> str:
    return str(value or '').strip().lower()


def _get_project_keyword_allowlist(project: Project) -> set[str]:
    settings_json = project.settings_json or {}
    raw = settings_json.get('blog_agent_keyword_allowlist') or []
    if not isinstance(raw, list):
        return set()
    return {_normalize_keyword_key(item) for item in raw if _normalize_keyword_key(str(item))}


def _enforce_project_keyword_allowlist(project: Project, primary_keyword: str, secondary_keywords: list[str]) -> None:
    allowlist = _get_project_keyword_allowlist(project)
    if not allowlist:
        return
    requested = [primary_keyword, *(secondary_keywords or [])]
    disallowed = []
    seen = set()
    for item in requested:
        normalized = _normalize_keyword_key(item)
        if not normalized or normalized in allowlist or normalized in seen:
            continue
        seen.add(normalized)
        disallowed.append(str(item or '').strip())
    if disallowed:
        raise RuntimeError(f"These keywords are not allowed for this project: {', '.join(disallowed)}")


def _infer_tone(
    project: Project,
    *,
    primary_keyword: str,
    secondary_keywords: list[str],
    requested_tone: str | None,
) -> str:
    explicit = str(requested_tone or '').strip().lower()
    if explicit and explicit not in {'auto', 'default'}:
        return explicit

    project_tone = str((project.settings_json or {}).get('tone') or '').strip().lower()
    if project_tone and project_tone not in {'auto', 'default'}:
        return project_tone

    signal_text = f"{primary_keyword} {' '.join(secondary_keywords)}".lower()
    if any(token in signal_text for token in ['vs', 'compare', 'comparison', 'best', 'top']):
        return 'authoritative'
    if any(token in signal_text for token in ['how to', 'guide', 'step', 'process', 'checklist']):
        return 'professional'
    if any(token in signal_text for token in ['myth', 'mistake', 'problem', 'warning']):
        return 'conversational'

    tone_pool = ['professional', 'authoritative', 'friendly', 'conversational']
    seed = abs(hash(primary_keyword)) % len(tone_pool)
    return tone_pool[seed]


def _resolve_country(project: Project, requested_country: str | None) -> str:
    explicit = str(requested_country or '').strip().lower()
    if explicit:
        return explicit
    from_project = str((project.settings_json or {}).get('country') or '').strip().lower()
    if from_project:
        return from_project
    return 'in'


def _resolve_language(project: Project, requested_language: str | None) -> str:
    explicit = str(requested_language or '').strip().lower()
    if explicit:
        return explicit
    from_project = str((project.settings_json or {}).get('language') or '').strip().lower()
    if from_project:
        return from_project
    return 'en'


def _cap_tags(tags: list[str], max_items: int = 5) -> list[str]:
    deduped = []
    seen = set()
    for item in tags:
        value = str(item or '').strip()
        if not value:
            continue
        key = value.lower()
        if key in seen:
            continue
        seen.add(key)
        deduped.append(value)
        if len(deduped) >= max_items:
            break
    return deduped


def _preferred_publish_slug(draft: Draft, topic: Topic | None) -> str:
    current = str(draft.slug or '').strip()
    title_slug = slugify(draft.title or '')
    keyword_slug = slugify(topic.primary_keyword) if topic and topic.primary_keyword else ''
    if current and current != title_slug:
        return current
    if keyword_slug:
        return keyword_slug
    return current or title_slug or 'post'


def _synthesize_topic(project: Project, primary_keyword: str, secondary_keywords: list[str], raw_topic: str | None) -> str:
    topic = str(raw_topic or '').strip()
    if topic:
        return topic

    primary = primary_keyword.strip()
    secondary = [str(item).strip() for item in (secondary_keywords or []) if str(item).strip()]
    secondary_hint = secondary[0] if secondary else ''

    templates = [
        "{primary}: What It Is, Benefits, and Who It Helps",
        "How {primary} Works: Step-by-Step Process",
        "Best {primary} Options: What to Choose and Why",
        "{primary} vs {secondary}: Key Differences and Use Cases",
        "Common Mistakes With {primary} and How to Avoid Them",
        "{primary} Checklist: Prep, Procedure, Recovery, Results",
    ]

    seed = abs(hash(primary)) % len(templates)
    chosen = templates[seed]
    if "{secondary}" in chosen and not secondary_hint:
        chosen = templates[(seed + 1) % len(templates)]

    return chosen.format(primary=primary, secondary=secondary_hint).strip()


def _library_is_stale(db: Session, project_id: int) -> bool:
    row = db.execute(
        select(
            func.count(ContentLibraryItem.id),
            func.max(ContentLibraryItem.last_synced_at),
        ).where(ContentLibraryItem.project_id == project_id)
    ).one()
    count = int(row[0] or 0)
    last_synced = row[1]
    if count == 0:
        return True
    if not last_synced:
        return True
    stale_cutoff = datetime.utcnow() - timedelta(hours=AUTO_SYNC_LIBRARY_MAX_AGE_HOURS)
    return last_synced < stale_cutoff


async def _auto_sync_library_if_needed(db: Session, project: Project, run: PipelineRun) -> None:
    if not _library_is_stale(db, project.id):
        return
    try:
        connector = build_connector(project)
        items = await connector.sync_library()
        reset_project_library(db, project.id)
        save_library_items(db, project.id, items)
        try:
            reindex_project_rag(db, project.id)
        except Exception as rag_exc:
            log_pipeline_event(
                db,
                run.id,
                'warning',
                'Auto reindex failed after library sync',
                {'error': str(rag_exc)},
            )
        log_pipeline_event(
            db,
            run.id,
            'info',
            'Auto library sync completed',
            {'synced_items': len(items)},
        )
    except Exception as exc:
        log_pipeline_event(
            db,
            run.id,
            'warning',
            'Auto library sync skipped due connector issue',
            {'error': str(exc)},
        )


def _apply_outline_override(payload: dict[str, Any], outline_override: list[str] | None) -> None:
    if not outline_override:
        return
    cleaned = [str(item).strip() for item in outline_override if str(item).strip()]
    if not cleaned:
        return
    split = max(1, min(5, len(cleaned)))
    brief = payload.get('brief', {})
    brief['h2'] = cleaned[:split]
    brief['h3'] = cleaned[split:]
    payload['brief'] = brief


def _recent_outlines(db: Session, project_id: int, window_n: int) -> list[list[str]]:
    rows = db.execute(
        select(Draft.outline_json)
        .where(Draft.project_id == project_id)
        .order_by(Draft.id.desc())
        .limit(max(1, window_n))
    ).all()
    result: list[list[str]] = []
    for row in rows:
        outline = row.outline_json or []
        result.append([str(item) for item in outline])
    return result


def _outline_draft(
    *,
    project_id: int,
    topic_id: int,
    topic: str,
    brief: dict[str, Any],
    platform: str,
) -> Draft:
    outline = (brief.get('h2', []) or []) + (brief.get('h3', []) or [])
    return Draft(
        project_id=project_id,
        topic_id=topic_id,
        title=topic,
        slug=slugify(topic),
        outline_json=outline,
        html=f"<article><h1>{topic}</h1><p>Outline generated. Run full generation to create content.</p></article>",
        meta_title=topic,
        meta_description=f"Outline for {topic}",
        faq_json=brief.get('faqs', []),
        schema_jsonld={},
        internal_links_json=[],
        sources_json=[],
        pattern_key=brief.get('pattern_key'),
        structure_type=brief.get('structure_type'),
        outline_fingerprint=brief.get('fingerprint'),
        intro_style=brief.get('intro_style'),
        cta_style=brief.get('cta_style'),
        faq_count=len(brief.get('faqs', [])),
        similarity_score=0.0,
        platform=platform,
        status=DraftStatus.draft,
    )


async def generate_outline(db: Session, request: dict[str, Any]) -> dict[str, Any]:
    project = db.get(Project, int(request['project_id']))
    if not project:
        raise RuntimeError('Project not found')

    primary_keyword, secondary_keywords = _normalize_keywords(
        request.get('primary_keyword'),
        request.get('secondary_keywords'),
    )
    _enforce_project_keyword_allowlist(project, primary_keyword, secondary_keywords)
    synthesized_topic = _synthesize_topic(
        project,
        primary_keyword=primary_keyword,
        secondary_keywords=secondary_keywords,
        raw_topic=request.get('topic'),
    )
    duplicate = None
    if not bool(request.get('force_new')):
        duplicate = _find_recent_duplicate_by_keyword(
            db,
            project_id=project.id,
            primary_keyword=primary_keyword,
        ) or _find_recent_duplicate_draft(
            db,
            project_id=project.id,
            topic_title=synthesized_topic,
            primary_keyword=primary_keyword,
        )
    if duplicate:
        if _should_reuse_duplicate(duplicate):
            state = get_blog_agent_state(db, duplicate.id)
            return {
                'pipeline_run_id': None,
                'draft_id': duplicate.id,
                'outline': state.get('outline_json', []),
                'faqs': state.get('faq_json', []),
                'structure_type': state.get('structure_type'),
                'seo': state.get('seo', {}),
                'reused_existing': True,
            }

    platform = _normalize_platform(project, str(request.get('platform') or 'none'))
    topic_row, run = _create_topic_and_run(
        db,
        project_id=project.id,
        topic=synthesized_topic,
        primary_keyword=primary_keyword,
        secondary_keywords=secondary_keywords,
        desired_word_count=int(request.get('desired_word_count', 1200)),
    )
    await _auto_sync_library_if_needed(db, project, run)
    resolved_tone = _infer_tone(
        project,
        primary_keyword=primary_keyword,
        secondary_keywords=secondary_keywords,
        requested_tone=request.get('tone'),
    )
    resolved_country = _resolve_country(project, request.get('country'))
    resolved_language = _resolve_language(project, request.get('language'))

    payload: dict[str, Any] = {
        'run_id': run.id,
        'project_id': project.id,
        'topic_id': topic_row.id,
        'topic': topic_row.title,
        'tone': resolved_tone,
        'country': resolved_country,
        'language': resolved_language,
        'platform': platform,
    }

    payload = await stage_research(db, run, payload)
    structure, intro_style, cta_style = choose_next_structure(db, project.id)
    payload.update(
        {
            'force_structure_type': structure,
            'force_intro_style': intro_style,
            'force_cta_style': cta_style,
        }
    )
    payload = await stage_brief(db, run, payload)
    _apply_outline_override(payload, request.get('outline_override'))

    run.status = PipelineStatus.completed
    run.stage = 'outline-completed'
    run.finished_at = datetime.utcnow()
    topic_row.status = TopicStatus.completed
    db.add(run)
    db.add(topic_row)
    db.commit()
    log_pipeline_event(db, run.id, 'info', 'Outline generated (no draft persisted)', {})

    outline = (payload['brief'].get('h2', []) or []) + (payload['brief'].get('h3', []) or [])
    return {
        'pipeline_run_id': run.id,
        'draft_id': None,
        'outline': outline,
        'faqs': payload['brief'].get('faqs', []),
        'structure_type': payload['brief'].get('structure_type'),
        'seo': {
            'meta_title': topic_row.title,
            'meta_description': f"Outline for {topic_row.title}",
            'slug': slugify(topic_row.title),
        },
    }


async def _run_generation_pass(
    db: Session,
    run: PipelineRun,
    payload: dict[str, Any],
    *,
    outline_override: list[str] | None,
    intro_style: str,
    cta_style: str,
) -> dict[str, Any]:
    payload = await stage_brief(db, run, payload)
    _apply_outline_override(payload, outline_override)
    payload = await stage_draft(db, run, payload)

    metadata = build_draft_metadata(
        structure_type=str(payload['brief'].get('structure_type') or payload['brief'].get('pattern_key') or 'how-to'),
        outline=payload['draft'].get('outline_json', []),
        faqs=payload['draft'].get('faq_json', []),
        intro_style=payload['brief'].get('intro_style') or intro_style,
        cta_style=payload['brief'].get('cta_style') or cta_style,
    )
    payload['draft'].update(metadata)
    return payload


async def generate_full_blog(db: Session, request: dict[str, Any]) -> dict[str, Any]:
    project = db.get(Project, int(request['project_id']))
    if not project:
        raise RuntimeError('Project not found')

    primary_keyword, secondary_keywords = _normalize_keywords(
        request.get('primary_keyword'),
        request.get('secondary_keywords'),
    )
    _enforce_project_keyword_allowlist(project, primary_keyword, secondary_keywords)
    synthesized_topic = _synthesize_topic(
        project,
        primary_keyword=primary_keyword,
        secondary_keywords=secondary_keywords,
        raw_topic=request.get('topic'),
    )
    duplicate = None
    if not bool(request.get('force_new')):
        duplicate = _find_recent_duplicate_by_keyword(
            db,
            project_id=project.id,
            primary_keyword=primary_keyword,
        ) or _find_recent_duplicate_draft(
            db,
            project_id=project.id,
            topic_title=synthesized_topic,
            primary_keyword=primary_keyword,
        )
    if duplicate:
        if _should_reuse_duplicate(duplicate):
            state = get_blog_agent_state(db, duplicate.id)
            return {
                'pipeline_run_id': None,
                'draft_id': duplicate.id,
                'status': state.get('status'),
                'similarity_score': state.get('similarity_score', 0.0),
                'state': state,
                'reused_existing': True,
            }

    platform = _normalize_platform(project, str(request.get('platform') or 'none'))
    topic_row, run = _create_topic_and_run(
        db,
        project_id=project.id,
        topic=synthesized_topic,
        primary_keyword=primary_keyword,
        secondary_keywords=secondary_keywords,
        desired_word_count=int(request.get('desired_word_count', 1200)),
    )
    await _auto_sync_library_if_needed(db, project, run)
    resolved_tone = _infer_tone(
        project,
        primary_keyword=primary_keyword,
        secondary_keywords=secondary_keywords,
        requested_tone=request.get('tone'),
    )
    resolved_country = _resolve_country(project, request.get('country'))
    resolved_language = _resolve_language(project, request.get('language'))

    runtime = resolve_project_runtime_config(db, project)
    threshold = float(runtime.get('similarity_threshold') or 0.78)
    window_n = int(runtime.get('diversity_window_n') or 25)
    structure, intro_style, cta_style = choose_next_structure(db, project.id, window_n=window_n)

    payload: dict[str, Any] = {
        'run_id': run.id,
        'project_id': project.id,
        'topic_id': topic_row.id,
        'topic': topic_row.title,
        'tone': resolved_tone,
        'country': resolved_country,
        'language': resolved_language,
        'platform': platform,
        'image_mode': request.get('image_mode', 'featured_only'),
        'inline_images_count': max(0, min(3, int(request.get('inline_images_count', 0)))),
        'force_structure_type': structure,
        'force_intro_style': intro_style,
        'force_cta_style': cta_style,
    }

    payload = await stage_research(db, run, payload)

    avoid_structures: set[str] = set()
    similarity = 0.0
    near_matches: list[dict[str, Any]] = []
    for attempt in range(MAX_REGEN_ATTEMPTS + 1):
        payload = await _run_generation_pass(
            db,
            run,
            payload,
            outline_override=request.get('outline_override'),
            intro_style=intro_style,
            cta_style=cta_style,
        )

        outline = payload['draft'].get('outline_json', [])
        previous_outlines = _recent_outlines(db, project.id, window_n)
        headings_unique = no_identical_h2_sequence(outline, previous_outlines)

        similarity, near_matches = compare_against_recent_drafts(
            db,
            project_id=project.id,
            html=payload['draft'].get('html', ''),
            outline=outline,
            window_n=window_n,
        )
        payload['similarity_score'] = similarity

        similarity_too_high = should_regenerate(similarity, threshold)
        if not similarity_too_high and headings_unique:
            break

        if attempt >= MAX_REGEN_ATTEMPTS:
            break

        current_structure = str(payload['brief'].get('structure_type') or payload['brief'].get('pattern_key') or '')
        if current_structure:
            avoid_structures.add(current_structure)

        log_pipeline_event(
            db,
            run.id,
            'warning',
            'Diversity guard triggered regeneration',
            {
                'attempt': attempt + 1,
                'similarity': similarity,
                'threshold': threshold,
                'headings_unique': headings_unique,
                'matches': near_matches,
            },
        )

        structure, intro_style, cta_style = choose_next_structure(
            db,
            project.id,
            window_n=window_n,
            avoid=avoid_structures,
        )
        payload['force_structure_type'] = structure
        payload['force_intro_style'] = intro_style
        payload['force_cta_style'] = cta_style

    payload = await stage_qa(db, run, payload)
    qa = payload.get('qa') or {'passed': True, 'warnings': [], 'stats': {}}
    if should_regenerate(float(payload.get('similarity_score', 0.0)), threshold):
        qa['passed'] = False
        qa['warnings'] = list(qa.get('warnings', [])) + [
            f"Similarity score {payload.get('similarity_score')} exceeded threshold {threshold}."
        ]
        qa_stats = dict(qa.get('stats', {}))
        qa_stats['similarity_threshold'] = threshold
        qa_stats['similarity_score'] = payload.get('similarity_score')
        qa['stats'] = qa_stats
        payload['qa'] = qa
    payload = await stage_save_draft(db, run, payload)

    draft = db.get(Draft, int(payload['draft_id']))
    if not draft:
        raise RuntimeError('Draft not found after generation')
    draft.similarity_score = float(payload.get('similarity_score', 0.0))
    draft.platform = platform
    db.add(draft)
    db.commit()

    image_mode = str(request.get('image_mode') or 'featured_only')
    inline_images_count = max(0, min(3, int(request.get('inline_images_count', 0))))
    await generate_images_for_draft(
        db,
        draft_id=draft.id,
        image_mode=image_mode,
        inline_images_count=inline_images_count,
    )

    if request.get('autopublish') and request.get('publish_status') in {'publish_now', 'schedule'}:
        publish_mode = 'scheduled' if request.get('publish_status') == 'schedule' else 'publish_now'
        publish_result = await publish_draft(
            db,
            draft_id=draft.id,
            mode=publish_mode,
            platform=platform,
            scheduled_at=request.get('schedule_datetime'),
        )
        state = get_blog_agent_state(db, draft.id)
        return {
            'pipeline_run_id': run.id,
            'draft_id': draft.id,
            'status': state.get('status'),
            'similarity_score': draft.similarity_score,
            'published': publish_result,
            'state': state,
        }

    state = get_blog_agent_state(db, draft.id)
    return {
        'pipeline_run_id': run.id,
        'draft_id': draft.id,
        'status': state.get('status'),
        'similarity_score': draft.similarity_score,
        'state': state,
    }


async def regenerate_different_structure(
    db: Session,
    *,
    draft_id: int,
    tone: str | None = None,
    image_mode: str = 'featured_only',
    inline_images_count: int = 0,
    outline_override: list[str] | None = None,
) -> dict[str, Any]:
    draft = db.get(Draft, draft_id)
    if not draft:
        raise RuntimeError('Draft not found')
    topic = db.get(Topic, draft.topic_id)
    if not topic:
        raise RuntimeError('Topic not found')

    request = {
        'project_id': draft.project_id,
        'platform': draft.platform,
        'topic': topic.title,
        'primary_keyword': topic.primary_keyword,
        'secondary_keywords': topic.secondary_keywords_json,
        'tone': tone,
        'country': 'us',
        'language': 'en',
        'desired_word_count': topic.desired_word_count,
        'image_mode': image_mode,
        'inline_images_count': inline_images_count,
        'outline_override': outline_override,
        'autopublish': False,
        'publish_status': 'draft',
        'force_new': True,
    }
    return await generate_full_blog(db, request)


async def generate_images_only(
    db: Session,
    *,
    draft_id: int,
    image_mode: str = 'featured_only',
    inline_images_count: int = 0,
) -> dict[str, Any]:
    return await generate_images_for_draft(
        db,
        draft_id=draft_id,
        image_mode=image_mode,
        inline_images_count=inline_images_count,
    )


async def publish_draft(
    db: Session,
    *,
    draft_id: int,
    mode: str,
    platform: str,
    scheduled_at: datetime | None = None,
    tags: list[str] | None = None,
    categories: list[str] | None = None,
    blog_id: int | None = None,
) -> dict[str, Any]:
    draft = db.get(Draft, draft_id)
    if not draft:
        raise RuntimeError('Draft not found')
    project = db.get(Project, draft.project_id)
    if not project:
        raise RuntimeError('Project not found')
    topic = db.get(Topic, draft.topic_id) if draft.topic_id else None

    normalized_mode = (mode or 'draft').lower()
    if normalized_mode == 'publish':
        normalized_mode = 'publish_now'
    if normalized_mode == 'schedule':
        normalized_mode = 'scheduled'

    resolved_platform = _normalize_platform(project, platform)
    if normalized_mode == 'scheduled' and not scheduled_at:
        raise RuntimeError('scheduled_at is required for scheduled publishing')

    normalized_tags = list(tags or [])
    focus_keyphrase = topic.primary_keyword if topic else (normalized_tags[0] if normalized_tags else draft.title)
    draft.slug = _preferred_publish_slug(draft, topic)
    if topic:
        merged = [topic.primary_keyword, *(topic.secondary_keywords_json or []), *normalized_tags]
        normalized_tags = _cap_tags([str(item).strip() for item in merged if str(item).strip()], max_items=5)
    else:
        normalized_tags = _cap_tags(normalized_tags, max_items=5)

    if resolved_platform == 'wordpress':
        published = await publish_wordpress_draft(
            project,
            draft,
            mode=normalized_mode,
            scheduled_at=scheduled_at.isoformat() if scheduled_at else None,
            tags=normalized_tags,
            categories=categories,
            focus_keyphrase=focus_keyphrase,
        )
    elif resolved_platform == 'shopify':
        published = await publish_shopify_draft(
            project,
            draft,
            mode=normalized_mode,
            scheduled_at=scheduled_at.isoformat() if scheduled_at else None,
            tags=normalized_tags,
            blog_id=blog_id,
        )
    else:
        raise RuntimeError('Unsupported platform')

    record_status = PublishStatus.scheduled if normalized_mode == 'scheduled' else PublishStatus.published
    record = PublishRecord(
        draft_id=draft.id,
        project_id=draft.project_id,
        platform_post_id=published.get('platform_post_id'),
        platform_url=published.get('platform_url'),
        status=record_status,
        scheduled_at=scheduled_at,
        published_at=None if normalized_mode == 'scheduled' else datetime.utcnow(),
        payload_json={
            'mode': normalized_mode,
            'tags': normalized_tags,
            'categories': categories or [],
            'blog_id': blog_id,
        },
    )
    draft.platform = resolved_platform
    draft.platform_post_id = published.get('platform_post_id')
    draft.publish_url = published.get('platform_url')
    draft.status = DraftStatus.published if normalized_mode in {'publish_now', 'scheduled'} else DraftStatus.approved
    db.add(record)
    db.add(draft)
    db.commit()
    return {
        'draft_id': draft.id,
        'platform': resolved_platform,
        'platform_post_id': draft.platform_post_id,
        'publish_url': draft.publish_url,
        'status': draft.status.value,
    }


def get_blog_agent_state(db: Session, draft_id: int) -> dict[str, Any]:
    draft = db.get(Draft, draft_id)
    if not draft:
        raise RuntimeError('Draft not found')
    images = list_draft_images(db, draft_id)
    image_payload = [
        {
            'id': image.id,
            'kind': image.kind,
            'image_path': _public_media_path(image.image_path),
            'image_file_path': image.image_path,
            'prompt': image.prompt,
            'alt_text': image.alt_text,
            'caption': image.caption,
            'position': image.position,
        }
        for image in images
    ]
    run = db.execute(
        select(PipelineRun)
        .where(PipelineRun.topic_id == draft.topic_id, PipelineRun.project_id == draft.project_id)
        .order_by(PipelineRun.id.desc())
        .limit(1)
    ).scalar_one_or_none()
    events: list[dict[str, Any]] = []
    research_meta: dict[str, Any] = {}
    if run:
        rows = db.execute(
            select(PipelineEvent)
            .where(PipelineEvent.pipeline_run_id == run.id)
            .order_by(PipelineEvent.id.asc())
            .limit(80)
        ).scalars().all()
        events = [
            {
                'id': row.id,
                'level': row.level,
                'message': row.message,
                'meta_json': row.meta_json or {},
                'created_at': row.created_at.isoformat() if row.created_at else None,
            }
            for row in rows
        ]
        for row in reversed(rows):
            if str(row.message or '').lower().startswith('research stage completed'):
                research_meta = dict(row.meta_json or {})
                break
    sources = draft.sources_json or []
    crawl_sources: list[dict[str, Any]] = []
    evidence_panel: list[dict[str, Any]] = []
    content_brief: dict[str, Any] = {}
    qa_scores: dict[str, Any] = {}
    intelligence_error = ''
    if run:
        try:
            page_rows = db.execute(
                select(CompetitorPage)
                .where(CompetitorPage.pipeline_run_id == run.id)
                .order_by(CompetitorPage.competitive_strength_score.desc(), CompetitorPage.id.asc())
            ).scalars().all()
            extract_rows = db.execute(
                select(CompetitorExtract)
                .where(CompetitorExtract.pipeline_run_id == run.id)
                .order_by(CompetitorExtract.id.asc())
            ).scalars().all()
            extract_by_url = {str(row.url or ''): row for row in extract_rows}
            crawl_sources = [
                {
                    'discovery_order': row.discovery_order,
                    'title': row.title,
                    'url': row.url,
                    'domain': row.domain,
                    'snippet': row.snippet,
                    'competitive_strength_score': float(row.competitive_strength_score or 0.0),
                    'freshness_score': float(row.freshness_score or 0.0),
                    'inlink_count': row.inlink_count,
                    'fetch_status': row.fetch_status,
                    'fetch_error_type': str(row.fetch_error_type or ''),
                    'discovered_at': row.discovered_at.isoformat() if row.discovered_at else None,
                    'last_seen_at': row.last_seen_at.isoformat() if row.last_seen_at else None,
                    'date_fetched': row.fetched_at.isoformat() if row.fetched_at else None,
                }
                for row in page_rows
            ]
            evidence_panel = []
            for row in page_rows:
                extracted = extract_by_url.get(str(row.url or ''))
                if not extracted:
                    continue
                evidence_panel.append(
                    {
                        'url': row.url,
                        'title': row.title,
                        'domain': row.domain,
                        'discovery_order': row.discovery_order,
                        'headings': extracted.headings_json or {},
                        'entities': extracted.entities_json or [],
                        'faqs': extracted.faqs_json or [],
                        'content_length_estimate': int((extracted.metrics_json or {}).get('word_count_estimate') or 0),
                        'media_count': int((extracted.metrics_json or {}).get('media_count') or 0),
                        'table_count': int((extracted.metrics_json or {}).get('table_count') or 0),
                        'trust_signals': extracted.trust_signals_json or {},
                        'competitive_strength_score': float(row.competitive_strength_score or 0.0),
                        'freshness_score': float(row.freshness_score or 0.0),
                        'inlink_count': row.inlink_count,
                        'fetch_status': row.fetch_status,
                        'fetch_error_type': str(row.fetch_error_type or ''),
                    }
                )
            brief_row = db.execute(
                select(BlogBrief).where(BlogBrief.pipeline_run_id == run.id).order_by(BlogBrief.id.desc()).limit(1)
            ).scalar_one_or_none()
            content_brief = dict((brief_row.brief_json or {}) if brief_row else {})
        except SQLAlchemyError as exc:
            intelligence_error = str(exc)
            crawl_sources = []
            evidence_panel = []
            content_brief = {}

    try:
        qa_row = db.execute(
            select(BlogQa).where(BlogQa.draft_id == draft.id).order_by(BlogQa.id.desc()).limit(1)
        ).scalar_one_or_none()
        if qa_row:
            qa_scores = {
                'completeness_score': float(qa_row.completeness_score or 0.0),
                'readability_score': float(qa_row.readability_score or 0.0),
                'practicality_score': float(qa_row.practicality_score or 0.0),
                'eeat_score': float(qa_row.eeat_score or 0.0),
                'domain_mismatch_score': float(qa_row.domain_mismatch_score or 100.0),
                'overall_score': float(qa_row.overall_score or 0.0),
                'qa_json': qa_row.qa_json or {},
            }
    except SQLAlchemyError as exc:
        intelligence_error = intelligence_error or str(exc)
        qa_scores = {}
    source_domains = sorted(
        {
            str(item.get('domain') or '').strip().lower()
            for item in sources
            if isinstance(item, dict) and str(item.get('domain') or '').strip()
        }
    )
    return {
        'draft_id': draft.id,
        'project_id': draft.project_id,
        'title': draft.title,
        'slug': draft.slug,
        'outline_json': draft.outline_json,
        'content_html': draft.html,
        'meta_title': draft.meta_title,
        'meta_description': draft.meta_description,
        'seo': {
            'meta_title': draft.meta_title,
            'meta_description': draft.meta_description,
            'slug': draft.slug,
        },
        'faq_json': draft.faq_json,
        'schema_jsonld': draft.schema_jsonld,
        'internal_links_json': draft.internal_links_json,
        'similarity_score': draft.similarity_score,
        'structure_type': draft.structure_type,
        'intro_style': draft.intro_style,
        'cta_style': draft.cta_style,
        'image_path': _public_media_path(draft.image_path),
        'image_file_path': draft.image_path,
        'image_prompt': draft.image_prompt,
        'alt_text': draft.alt_text,
        'caption': draft.caption,
        'images': image_payload,
        'word_count': _html_word_count(draft.html),
        'status': draft.status.value,
        'platform': draft.platform,
        'platform_post_id': draft.platform_post_id,
        'publish_url': draft.publish_url,
        'pipeline_run_id': run.id if run else None,
        'pipeline_status': run.status.value if run else None,
        'pipeline_stage': run.stage if run else None,
        'pipeline_error': run.error_message if run else None,
        'pipeline_events': events,
        'crawl_sources': crawl_sources,
        'evidence_panel': evidence_panel,
        'content_brief': content_brief,
        'qa_scores': qa_scores,
        'intelligence_error': intelligence_error,
        'research_summary': {
            'source_count': len(sources),
            'source_domains': source_domains,
            'internal_link_count': len(draft.internal_links_json or []),
            'internal_candidate_count': int(research_meta.get('internal_candidates') or 0),
            'internal_plan_count': int(research_meta.get('internal_plan_count') or 0),
            'library_items_count': int(research_meta.get('library_items_count') or 0),
            'sitemap_urls_count': int(research_meta.get('sitemap_urls_count') or 0),
            'competitor_domains': list(research_meta.get('competitor_domains') or []),
            'top_competitor_urls': list(research_meta.get('top_competitor_urls') or []),
        },
        'created_at': draft.created_at.isoformat() if draft.created_at else None,
    }


def run_outline_sync(db: Session, request: dict[str, Any]) -> dict[str, Any]:
    project_id = int(request['project_id'])
    lock = _get_project_lock(project_id)
    if not lock.acquire(blocking=False):
        raise RuntimeError('Another request is already running for this project. Please wait.')
    try:
        return asyncio.run(generate_outline(db, request))
    finally:
        lock.release()


def run_full_sync(db: Session, request: dict[str, Any]) -> dict[str, Any]:
    project_id = int(request['project_id'])
    lock = _get_project_lock(project_id)
    if not lock.acquire(blocking=False):
        raise RuntimeError('Another full generation is already running for this project. Please wait.')
    try:
        return asyncio.run(generate_full_blog(db, request))
    except Exception as exc:
        _mark_latest_active_run_failed(db, project_id, str(exc))
        raise
    finally:
        lock.release()


def run_regenerate_sync(db: Session, draft_id: int, payload: dict[str, Any]) -> dict[str, Any]:
    return asyncio.run(
        regenerate_different_structure(
            db,
            draft_id=draft_id,
            tone=payload.get('tone'),
            image_mode=payload.get('image_mode', 'featured_only'),
            inline_images_count=int(payload.get('inline_images_count', 0)),
            outline_override=payload.get('outline_override'),
        )
    )


def run_images_sync(db: Session, draft_id: int, payload: dict[str, Any]) -> dict[str, Any]:
    return asyncio.run(
        generate_images_only(
            db,
            draft_id=draft_id,
            image_mode=payload.get('image_mode', 'featured_only'),
            inline_images_count=int(payload.get('inline_images_count', 0)),
        )
    )


def _parse_schedule(value: Any) -> datetime | None:
    if value in (None, ''):
        return None
    if isinstance(value, datetime):
        return value
    text = str(value).strip().replace('Z', '+00:00')
    return datetime.fromisoformat(text)


def run_publish_sync(db: Session, draft_id: int, payload: dict[str, Any]) -> dict[str, Any]:
    return asyncio.run(
        publish_draft(
            db,
            draft_id=draft_id,
            mode=payload.get('mode', 'draft'),
            platform=payload.get('platform', 'none'),
            scheduled_at=_parse_schedule(payload.get('scheduled_at')),
            tags=payload.get('tags', []),
            categories=payload.get('categories', []),
            blog_id=payload.get('blog_id'),
        )
    )
