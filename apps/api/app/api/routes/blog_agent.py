from __future__ import annotations

from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import Session

from app.api.deps import get_current_admin
from app.core.celery_client import celery_client
from app.db.session import get_db
from app.models.entities import Project
from app.models.entities import BlogBrief, BlogQa, CompetitorExtract, CompetitorPage
from app.schemas.entities import (
    BlogAgentGenerateRequest,
    BlogAgentImagesRequest,
    BlogAgentOutlineRequest,
    BlogAgentPublishRequest,
    BlogAgentRegenerateRequest,
)
from app.services.agents.blog_agent_orchestrator import (
    get_blog_agent_state,
    run_full_sync,
    run_images_sync,
    run_outline_sync,
    run_publish_sync,
    run_regenerate_sync,
)

router = APIRouter(prefix='/api/blog-agent', tags=['blog-agent'], dependencies=[Depends(get_current_admin)])


def _http_error(exc: Exception) -> HTTPException:
    message = str(exc) or exc.__class__.__name__
    return HTTPException(status_code=400, detail=message)


@router.get('/task/{task_id}')
def blog_agent_task_status(task_id: str) -> dict:
    task = celery_client.AsyncResult(task_id)
    state = str(task.state or 'PENDING').upper()
    payload: dict = {
        'task_id': task_id,
        'state': state,
        'ready': bool(task.ready()),
    }
    if state == 'SUCCESS':
        result = task.result
        payload['result'] = result if isinstance(result, dict) else {'value': str(result)}
    elif state == 'FAILURE':
        payload['error'] = str(task.result or 'Task failed')
    return payload


def _normalize_keyword_entries(raw: list[str] | str | None) -> list[str]:
    values: list[str] = []
    if isinstance(raw, list):
        values = [str(item or '').strip() for item in raw]
    else:
        text = str(raw or '')
        values = [part.strip() for part in text.replace('\n', ',').split(',')]
    seen: set[str] = set()
    out: list[str] = []
    for item in values:
        if not item:
            continue
        key = item.lower()
        if key in seen:
            continue
        seen.add(key)
        out.append(item)
    return out


def _read_project_keyword_policy(project: Project) -> dict:
    settings_json = dict(project.settings_json or {})
    keywords = _normalize_keyword_entries(settings_json.get('blog_agent_keyword_allowlist') or [])
    updated_at = str(settings_json.get('blog_agent_keyword_allowlist_updated_at') or '')
    return {
        'project_id': project.id,
        'keywords': keywords,
        'updated_at': updated_at,
    }


def _derive_requested_keywords(data: dict) -> list[str]:
    primary = str(data.get('primary_keyword') or '').strip()
    secondary = [str(item or '').strip() for item in (data.get('secondary_keywords') or []) if str(item or '').strip()]
    if not primary and secondary:
        primary = secondary[0]
        secondary = secondary[1:]
    requested = [primary, *secondary]
    out: list[str] = []
    seen: set[str] = set()
    for item in requested:
        if not item:
            continue
        key = item.lower()
        if key in seen:
            continue
        seen.add(key)
        out.append(item)
    return out


def _validate_keyword_policy_or_400(db: Session, data: dict) -> None:
    project_id = int(data.get('project_id') or 0)
    if not project_id:
        raise HTTPException(status_code=400, detail='project_id is required')
    project = db.get(Project, project_id)
    if not project:
        raise HTTPException(status_code=404, detail='Project not found')

    settings_json = dict(project.settings_json or {})
    allowlist = _normalize_keyword_entries(settings_json.get('blog_agent_keyword_allowlist') or [])
    if not allowlist:
        return
    allowset = {item.lower() for item in allowlist}
    requested = _derive_requested_keywords(data)
    disallowed = [item for item in requested if item.lower() not in allowset]
    if disallowed:
        raise HTTPException(
            status_code=400,
            detail=f"Keyword mismatch: these keywords are not allowed for this project: {', '.join(disallowed)}",
        )


@router.get('/keyword-policy')
def blog_agent_get_keyword_policy(
    project_id: int = Query(...),
    db: Session = Depends(get_db),
) -> dict:
    project = db.get(Project, project_id)
    if not project:
        raise HTTPException(status_code=404, detail='Project not found')
    return _read_project_keyword_policy(project)


@router.put('/keyword-policy')
def blog_agent_put_keyword_policy(
    payload: dict,
    db: Session = Depends(get_db),
) -> dict:
    project_id = int(payload.get('project_id') or 0)
    if not project_id:
        raise HTTPException(status_code=400, detail='project_id is required')
    project = db.get(Project, project_id)
    if not project:
        raise HTTPException(status_code=404, detail='Project not found')

    keywords = _normalize_keyword_entries(payload.get('keywords') or payload.get('keywords_text') or [])
    settings_json = dict(project.settings_json or {})
    settings_json['blog_agent_keyword_allowlist'] = keywords
    settings_json['blog_agent_keyword_allowlist_updated_at'] = datetime.now(timezone.utc).isoformat()
    project.settings_json = settings_json
    db.add(project)
    db.commit()
    db.refresh(project)

    return _read_project_keyword_policy(project)


@router.post('/outline')
def blog_agent_outline(
    payload: BlogAgentOutlineRequest,
    async_job: bool = Query(default=False),
    db: Session = Depends(get_db),
) -> dict:
    data = payload.model_dump(mode='json')
    _validate_keyword_policy_or_400(db, data)
    if async_job:
        task = celery_client.send_task(
            'apps.worker.app.tasks.pipeline_tasks.generate_outline_job',
            args=[data],
            queue='celery',
        )
        return {'queued': True, 'task_id': task.id}
    try:
        return run_outline_sync(db, data)
    except Exception as exc:
        raise _http_error(exc) from exc


@router.post('/generate')
def blog_agent_generate(
    payload: BlogAgentGenerateRequest,
    async_job: bool = Query(default=False),
    db: Session = Depends(get_db),
) -> dict:
    data = payload.model_dump(mode='json')
    _validate_keyword_policy_or_400(db, data)
    if async_job:
        task = celery_client.send_task(
            'apps.worker.app.tasks.pipeline_tasks.generate_draft_job',
            args=[data],
            queue='celery',
        )
        return {'queued': True, 'task_id': task.id}
    try:
        return run_full_sync(db, data)
    except Exception as exc:
        raise _http_error(exc) from exc


@router.post('/{draft_id}/regenerate')
def blog_agent_regenerate(
    draft_id: int,
    payload: BlogAgentRegenerateRequest,
    async_job: bool = Query(default=False),
    db: Session = Depends(get_db),
) -> dict:
    data = payload.model_dump(mode='json')
    if async_job:
        task = celery_client.send_task(
            'apps.worker.app.tasks.pipeline_tasks.regenerate_draft_job',
            args=[draft_id, data],
            queue='celery',
        )
        return {'queued': True, 'task_id': task.id}
    try:
        return run_regenerate_sync(db, draft_id, data)
    except Exception as exc:
        raise _http_error(exc) from exc


@router.post('/{draft_id}/images')
def blog_agent_images(
    draft_id: int,
    payload: BlogAgentImagesRequest,
    async_job: bool = Query(default=False),
    db: Session = Depends(get_db),
) -> dict:
    data = payload.model_dump(mode='json')
    if async_job:
        task = celery_client.send_task(
            'apps.worker.app.tasks.pipeline_tasks.generate_images_job',
            args=[draft_id, data],
            queue='celery',
        )
        return {'queued': True, 'task_id': task.id}
    try:
        return run_images_sync(db, draft_id, data)
    except Exception as exc:
        raise _http_error(exc) from exc


@router.post('/{draft_id}/publish')
def blog_agent_publish(
    draft_id: int,
    payload: BlogAgentPublishRequest,
    async_job: bool = Query(default=False),
    db: Session = Depends(get_db),
) -> dict:
    data = payload.model_dump(mode='json')
    if async_job:
        task = celery_client.send_task(
            'apps.worker.app.tasks.pipeline_tasks.publish_draft_job',
            args=[draft_id, data],
            queue='celery',
        )
        return {'queued': True, 'task_id': task.id}
    try:
        return run_publish_sync(db, draft_id, data)
    except Exception as exc:
        raise _http_error(exc) from exc


@router.get('/{draft_id}')
def blog_agent_get(draft_id: int, db: Session = Depends(get_db)) -> dict:
    try:
        return get_blog_agent_state(db, draft_id)
    except Exception as exc:
        raise _http_error(exc) from exc


@router.get('/{draft_id}/audit')
def blog_agent_get_audit(draft_id: int, db: Session = Depends(get_db)) -> dict:
    state = get_blog_agent_state(db, draft_id)
    run_id = int(state.get('pipeline_run_id') or 0)
    crawl_candidates_json: dict = {'items': []}
    extracts_json: list[dict] = []
    brief_json: dict = {}
    qa_json: dict = {}
    intelligence_error = ''
    if run_id > 0:
        try:
            page_rows = (
                db.query(CompetitorPage)
                .filter(CompetitorPage.pipeline_run_id == run_id)
                .order_by(CompetitorPage.competitive_strength_score.desc(), CompetitorPage.id.asc())
                .all()
            )
            extract_rows = db.query(CompetitorExtract).filter(CompetitorExtract.pipeline_run_id == run_id).order_by(CompetitorExtract.id.asc()).all()
            brief_row = db.query(BlogBrief).filter(BlogBrief.pipeline_run_id == run_id).order_by(BlogBrief.id.desc()).first()
            crawl_candidates_json = {
                'items': [
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
            }
            extracts_json = [
                {
                    'url': row.url,
                    'headings': row.headings_json or {},
                    'entities': row.entities_json or [],
                    'faqs': row.faqs_json or [],
                    'metrics': row.metrics_json or {},
                    'trust_signals': row.trust_signals_json or {},
                }
                for row in extract_rows
            ]
            brief_json = dict((brief_row.brief_json or {}) if brief_row else {})
        except SQLAlchemyError as exc:
            intelligence_error = str(exc)
            crawl_candidates_json = {'items': []}
            extracts_json = []
            brief_json = {}
    try:
        qa_row = db.query(BlogQa).filter(BlogQa.draft_id == draft_id).order_by(BlogQa.id.desc()).first()
        if qa_row:
            qa_json = qa_row.qa_json or {}
            qa_json.setdefault('qa_competitive', {})
            qa_json['qa_competitive'].update(
                {
                    'completeness_score': float(qa_row.completeness_score or 0.0),
                    'readability_score': float(qa_row.readability_score or 0.0),
                    'practicality_score': float(qa_row.practicality_score or 0.0),
                    'eeat_score': float(qa_row.eeat_score or 0.0),
                    'domain_mismatch_score': float(qa_row.domain_mismatch_score or 100.0),
                    'overall_score': float(qa_row.overall_score or 0.0),
                }
            )
    except SQLAlchemyError as exc:
        intelligence_error = intelligence_error or str(exc)
        qa_json = {}
    return {
        'draft_id': draft_id,
        'pipeline_run_id': run_id or None,
        'crawl_candidates_json': crawl_candidates_json,
        'extracts_json': extracts_json,
        'brief_json': brief_json,
        'qa_json': qa_json,
        'intelligence_error': intelligence_error,
    }


@router.post('/demo')
def blog_agent_demo(payload: dict, db: Session = Depends(get_db)) -> dict:
    project_id = int(payload.get('project_id') or 0)
    keyword = str(payload.get('keyword') or payload.get('primary_keyword') or '').strip()
    if not project_id:
        raise HTTPException(status_code=400, detail='project_id is required')
    if not keyword:
        raise HTTPException(status_code=400, detail='keyword is required')
    project = db.get(Project, project_id)
    if not project:
        raise HTTPException(status_code=404, detail='Project not found')
    request_payload = {
        'project_id': project_id,
        'platform': str(payload.get('platform') or project.platform.value),
        'topic': str(payload.get('topic') or '').strip() or None,
        'primary_keyword': keyword,
        'secondary_keywords': list(payload.get('secondary_keywords') or []),
        'tone': str(payload.get('tone') or 'auto'),
        'country': str(payload.get('country') or 'us'),
        'language': str(payload.get('language') or 'en'),
        'desired_word_count': int(payload.get('desired_word_count') or 1200),
        'image_mode': 'prompts_only',
        'inline_images_count': 0,
        'autopublish': False,
        'publish_status': 'draft',
        'force_new': True,
    }
    result = run_full_sync(db, request_payload)
    state = result.get('state') or get_blog_agent_state(db, int(result.get('draft_id') or 0))
    audit = blog_agent_get_audit(int(state.get('draft_id') or 0), db)
    return {
        'top_sources': (audit.get('crawl_candidates_json') or {}).get('items', [])[:10],
        'brief': audit.get('brief_json') or {},
        'final_blog': {
            'draft_id': state.get('draft_id'),
            'title': state.get('title'),
            'slug': state.get('slug'),
            'meta_title': state.get('meta_title'),
            'meta_description': state.get('meta_description'),
            'html': state.get('content_html'),
        },
        'qa_scores': ((audit.get('qa_json') or {}).get('qa_competitive') or {}),
    }
