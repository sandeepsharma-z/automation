import csv
import io
import logging
import re
import time
from datetime import datetime
from typing import Any

from fastapi import APIRouter, Depends, File, HTTPException, UploadFile
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.api.deps import get_current_admin
from app.core.celery_client import celery_client
from app.core.security import encrypt_secret
from app.db.session import get_db
from app.models.entities import ContentLibraryItem, ContentPattern, Draft, PipelineRun, PlatformType, Project, Topic
from app.schemas.entities import (
    LibraryItemResponse,
    PatternUpdate,
    PatternResponse,
    ProjectCreate,
    ProjectResponse,
    ProjectUpdate,
    RagStatusResponse,
    TopicResponse,
)
from app.services.connectors.factory import build_connector
from app.services.connectors.wordpress_runtime import (
    apply_wordpress_runtime_to_project,
    resolve_wordpress_runtime_config,
    wordpress_raw_auth_probe,
    wordpress_token_ping_probe,
    wordpress_whoami_probe,
)
from app.services.pipeline.variation import ensure_default_patterns
from app.services.rag.vectorstore import get_rag_status

router = APIRouter(prefix='/api/projects', tags=['projects'], dependencies=[Depends(get_current_admin)])
logger = logging.getLogger(__name__)

SENSITIVE_SETTING_KEYS = {'openai_api_key'}


def _looks_masked_secret(value: Any) -> bool:
    text = str(value or '').strip()
    if not text:
        return False
    if text == '***':
        return True
    if '...' in text:
        return True
    return bool(re.fullmatch(r'\*+', text))


def _prepare_settings_for_storage(settings_json: dict[str, Any], existing: dict[str, Any] | None = None) -> dict[str, Any]:
    output = dict(existing or {})
    incoming = dict(settings_json)
    for key in SENSITIVE_SETTING_KEYS:
        raw_secret = incoming.get(key)
        if raw_secret and not _looks_masked_secret(raw_secret):
            output[f'{key}_enc'] = encrypt_secret(str(incoming.pop(key)))
        elif key in incoming:
            incoming.pop(key, None)
        enc_key = f'{key}_enc'
        if incoming.get(enc_key) == '***' and existing and existing.get(enc_key):
            incoming[enc_key] = existing[enc_key]
    output.update(incoming)
    return output


def _mask_settings(settings_json: dict[str, Any]) -> dict[str, Any]:
    masked = dict(settings_json)
    for key in list(masked.keys()):
        if key.endswith('_enc'):
            masked[key] = '***'
    return masked


def _apply_shopify_settings(settings_json: dict[str, Any], payload: ProjectCreate | ProjectUpdate) -> dict[str, Any]:
    out = dict(settings_json or {})
    if getattr(payload, 'shopify_blog_id', None) is not None:
        out['shopify_blog_id'] = int(payload.shopify_blog_id)
    if getattr(payload, 'shopify_author', None) is not None:
        out['shopify_author'] = str(payload.shopify_author or '').strip()
    if getattr(payload, 'shopify_tags', None) is not None:
        out['shopify_tags'] = [str(tag).strip() for tag in list(payload.shopify_tags or []) if str(tag or '').strip()]
    if getattr(payload, 'shopify_published', None) is not None:
        out['shopify_published'] = bool(payload.shopify_published)
    return out


@router.get('', response_model=list[ProjectResponse])
def list_projects(db: Session = Depends(get_db)) -> list[Project]:
    projects = db.execute(select(Project).order_by(Project.created_at.desc())).scalars().all()
    for project in projects:
        project.settings_json = _mask_settings(project.settings_json)
    return projects


@router.post('', response_model=ProjectResponse)
def create_project(payload: ProjectCreate, db: Session = Depends(get_db)) -> Project:
    settings_json = _prepare_settings_for_storage(payload.settings_json)
    settings_json = _apply_shopify_settings(settings_json, payload)
    if payload.wp_connector_token:
        settings_json['wp_connector_token_enc'] = encrypt_secret(payload.wp_connector_token)
    if payload.wordpress_auth_mode:
        settings_json['wordpress_auth_mode'] = payload.wordpress_auth_mode
    project = Project(
        name=payload.name,
        platform=payload.platform,
        base_url=payload.base_url,
        wp_user=payload.wp_user,
        wp_app_password_enc=encrypt_secret(payload.wp_app_password) if payload.wp_app_password else None,
        shopify_store=payload.shopify_store,
        shopify_token_enc=encrypt_secret(payload.shopify_token) if payload.shopify_token else None,
        settings_json=settings_json,
        created_at=datetime.utcnow(),
    )
    db.add(project)
    db.commit()
    db.refresh(project)
    ensure_default_patterns(db, project.id)
    project.settings_json = _mask_settings(project.settings_json)
    return project


@router.get('/{project_id}', response_model=ProjectResponse)
def get_project(project_id: int, db: Session = Depends(get_db)) -> Project:
    project = db.get(Project, project_id)
    if not project:
        raise HTTPException(status_code=404, detail='Project not found')
    project.settings_json = _mask_settings(project.settings_json)
    return project


@router.patch('/{project_id}', response_model=ProjectResponse)
def update_project(project_id: int, payload: ProjectUpdate, db: Session = Depends(get_db)) -> Project:
    project = db.get(Project, project_id)
    if not project:
        raise HTTPException(status_code=404, detail='Project not found')

    data = payload.model_dump(exclude_unset=True)
    if 'settings_json' in data and data['settings_json'] is not None:
        project.settings_json = _prepare_settings_for_storage(data['settings_json'], existing=project.settings_json)
    project.settings_json = _apply_shopify_settings(project.settings_json, payload)
    if 'wordpress_auth_mode' in data and data['wordpress_auth_mode'] is not None:
        settings_json = dict(project.settings_json or {})
        settings_json['wordpress_auth_mode'] = str(data['wordpress_auth_mode']).strip() or 'auto'
        project.settings_json = settings_json
    if data.get('wp_connector_token'):
        settings_json = dict(project.settings_json or {})
        settings_json['wp_connector_token_enc'] = encrypt_secret(data['wp_connector_token'])
        project.settings_json = settings_json
    if data.get('name'):
        project.name = data['name']
    if data.get('base_url'):
        project.base_url = data['base_url']
    if 'wp_user' in data:
        project.wp_user = data['wp_user']
    if data.get('wp_app_password'):
        project.wp_app_password_enc = encrypt_secret(data['wp_app_password'])
    if 'shopify_store' in data:
        project.shopify_store = data['shopify_store']
    if data.get('shopify_token'):
        project.shopify_token_enc = encrypt_secret(data['shopify_token'])

    db.add(project)
    db.commit()
    db.refresh(project)
    project.settings_json = _mask_settings(project.settings_json)
    return project


@router.post('/{project_id}/test-connection')
async def test_connection(project_id: int, db: Session = Depends(get_db)) -> dict:
    started = time.perf_counter()
    project = db.get(Project, project_id)
    if not project:
        raise HTTPException(status_code=404, detail='Project not found')

    runtime = None
    probe = None
    if project.platform == PlatformType.wordpress:
        runtime = resolve_wordpress_runtime_config(db, project)
        apply_wordpress_runtime_to_project(project, runtime)
        if runtime.auth_mode == 'token_connector':
            probe = await wordpress_token_ping_probe(runtime, timeout_seconds=15.0)
        else:
            probe = await wordpress_whoami_probe(runtime, timeout_seconds=15.0)

    duration_ms = int((time.perf_counter() - started) * 1000)
    log_payload = {
        'event': 'wordpress_test_connection',
        'project_id': project_id,
        'wp_url': runtime.wp_url if runtime else None,
        'wp_user_present': bool(runtime.wp_user) if runtime else bool(project.wp_user),
        'wp_pass_present': bool(runtime.wp_app_password) if runtime else bool(project.wp_app_password_enc),
        'wp_token_present': bool(runtime.wp_connector_token) if runtime else False,
        'wp_user_source': runtime.wp_user_source if runtime else 'project',
        'wp_pass_source': runtime.wp_pass_source if runtime else 'project',
        'wp_token_source': runtime.wp_token_source if runtime else 'none',
        'auth_mode': runtime.auth_mode if runtime else 'none',
        'authorization_attached': bool(probe.get('auth_header_attached')) if probe else False,
        'upstream_status': probe.get('status') if probe else None,
        'upstream_snippet': str((probe or {}).get('response_snippet') or '')[:300],
        'duration_ms': duration_ms,
    }
    try:
        if probe and (int(probe.get('status') or 0) >= 400 or int(probe.get('status') or 0) == 0):
            message = str(probe.get('wp_message') or 'WordPress auth probe failed').strip()
            code = str(probe.get('wp_code') or '').strip()
            reason = f'{code}: {message}'.strip(': ')
            raise RuntimeError(reason)

        if runtime and runtime.auth_mode == 'token_connector':
            result = {
                'ok': True,
                'mode': 'token_connector',
                'supports': probe.get('supports') or [],
                'max_upload_bytes': probe.get('max_upload_bytes'),
            }
        else:
            connector = build_connector(project)
            result = await connector.test_connection()
        if runtime and runtime.auth_mode != 'token_connector' and int(probe.get('status') or 0) == 401:
            raw_probe = await wordpress_raw_auth_probe(runtime, timeout_seconds=15.0)
            if raw_probe.get('conclusion') == 'authorization_header_likely_stripped_by_server_or_waf':
                result = {
                    **result,
                    'recommendation': 'Authorization header appears stripped. Use token_connector mode.',
                }
        logger.info('wordpress_test_connection_ok', extra={'extra': log_payload})
        return {'ok': True, 'result': result}
    except Exception as exc:
        log_payload['exception_type'] = exc.__class__.__name__
        log_payload['exception_message'] = str(exc)
        logger.exception('wordpress_test_connection_failed', extra={'extra': log_payload})
        message = str(exc) or exc.__class__.__name__
        raise HTTPException(status_code=400, detail=message) from exc


@router.get('/{project_id}/wordpress/debug')
async def wordpress_debug(project_id: int, db: Session = Depends(get_db)) -> dict:
    project = db.get(Project, project_id)
    if not project:
        raise HTTPException(status_code=404, detail='Project not found')
    if project.platform != PlatformType.wordpress:
        raise HTTPException(status_code=400, detail='WordPress debug is only available for WordPress projects')

    runtime = resolve_wordpress_runtime_config(db, project)
    if runtime.auth_mode == 'token_connector':
        probe = await wordpress_token_ping_probe(runtime, timeout_seconds=15.0)
    else:
        probe = await wordpress_whoami_probe(runtime, timeout_seconds=15.0)
    return {
        'project_id': project_id,
        'wp_url': runtime.wp_url,
        'wp_user_present': bool(runtime.wp_user),
        'wp_app_password_present': bool(runtime.wp_app_password),
        'wp_connector_token_present': bool(runtime.wp_connector_token),
        'wp_user_source': runtime.wp_user_source,
        'wp_pass_source': runtime.wp_pass_source,
        'wp_token_source': runtime.wp_token_source,
        'auth_mode_source': runtime.auth_mode_source,
        'configured_auth_mode': runtime.configured_auth_mode,
        'auth_mode': runtime.auth_mode,
        'request_probe': {
            'endpoint': probe.get('endpoint'),
            'status': probe.get('status'),
            'wp_code': probe.get('wp_code'),
            'wp_message': probe.get('wp_message'),
        },
    }


@router.post('/{project_id}/sync-library')
def sync_library(project_id: int, db: Session = Depends(get_db)) -> dict:
    project = db.get(Project, project_id)
    if not project:
        raise HTTPException(status_code=404, detail='Project not found')

    task = celery_client.send_task(
        'apps.worker.app.tasks.pipeline_tasks.sync_library_task',
        args=[project_id],
        queue='celery',
    )
    return {'task_id': task.id, 'message': 'Library sync queued'}


@router.post('/{project_id}/reindex-library')
def reindex_library(project_id: int, db: Session = Depends(get_db)) -> dict:
    project = db.get(Project, project_id)
    if not project:
        raise HTTPException(status_code=404, detail='Project not found')
    task = celery_client.send_task(
        'apps.worker.app.tasks.pipeline_tasks.reindex_library_task',
        args=[project_id],
        queue='celery',
    )
    return {'task_id': task.id, 'message': 'RAG reindex queued'}


@router.get('/{project_id}/rag/status', response_model=RagStatusResponse)
def rag_status(project_id: int, db: Session = Depends(get_db)) -> dict:
    project = db.get(Project, project_id)
    if not project:
        raise HTTPException(status_code=404, detail='Project not found')
    status = get_rag_status(project_id)
    status['indexed_at'] = project.settings_json.get('rag_last_indexed_at', status.get('indexed_at'))
    status['doc_count'] = int(project.settings_json.get('rag_doc_count', status.get('doc_count', 0)))
    return status


@router.get('/{project_id}/library', response_model=list[LibraryItemResponse])
def list_library(project_id: int, db: Session = Depends(get_db)) -> list[ContentLibraryItem]:
    items = db.execute(
        select(ContentLibraryItem)
        .where(ContentLibraryItem.project_id == project_id)
        .order_by(ContentLibraryItem.last_synced_at.desc().nulls_last())
    ).scalars().all()
    return items


@router.get('/{project_id}/topics', response_model=list[TopicResponse])
def list_topics(project_id: int, db: Session = Depends(get_db)) -> list[Topic]:
    return db.execute(
        select(Topic).where(Topic.project_id == project_id).order_by(Topic.created_at.desc())
    ).scalars().all()


@router.post('/{project_id}/topics/import')
def import_topics(project_id: int, file: UploadFile = File(...), db: Session = Depends(get_db)) -> dict:
    if not file.filename.lower().endswith('.csv'):
        raise HTTPException(status_code=400, detail='Only CSV files are supported')

    content = file.file.read().decode('utf-8')
    reader = csv.DictReader(io.StringIO(content))
    inserted = 0
    for row in reader:
        title = row.get('title') or row.get('topic')
        primary = row.get('primary_keyword') or row.get('keyword')
        if not title or not primary:
            continue
        secondary = [s.strip() for s in (row.get('secondary_keywords') or '').split(',') if s.strip()]
        desired_word_count = int(row.get('desired_word_count') or 1200)
        db.add(
            Topic(
                project_id=project_id,
                title=title,
                primary_keyword=primary,
                secondary_keywords_json=secondary,
                desired_word_count=desired_word_count,
            )
        )
        inserted += 1
    db.commit()
    return {'inserted': inserted}


@router.get('/{project_id}/patterns', response_model=list[PatternResponse])
def list_patterns(project_id: int, db: Session = Depends(get_db)) -> list[ContentPattern]:
    ensure_default_patterns(db, project_id)
    return db.execute(
        select(ContentPattern)
        .where(ContentPattern.project_id == project_id)
        .order_by(ContentPattern.pattern_key.asc())
    ).scalars().all()


@router.post('/{project_id}/patterns/{pattern_id}/toggle', response_model=PatternResponse)
def toggle_pattern(project_id: int, pattern_id: int, db: Session = Depends(get_db)) -> ContentPattern:
    pattern = db.get(ContentPattern, pattern_id)
    if not pattern or pattern.project_id != project_id:
        raise HTTPException(status_code=404, detail='Pattern not found')
    pattern.enabled = not pattern.enabled
    db.add(pattern)
    db.commit()
    db.refresh(pattern)
    return pattern


@router.put('/{project_id}/patterns/{pattern_id}', response_model=PatternResponse)
def update_pattern(
    project_id: int,
    pattern_id: int,
    payload: PatternUpdate,
    db: Session = Depends(get_db),
) -> ContentPattern:
    pattern = db.get(ContentPattern, pattern_id)
    if not pattern or pattern.project_id != project_id:
        raise HTTPException(status_code=404, detail='Pattern not found')

    data = payload.model_dump(exclude_unset=True)
    for key, value in data.items():
        setattr(pattern, key, value)

    db.add(pattern)
    db.commit()
    db.refresh(pattern)
    return pattern


@router.get('/{project_id}/usage')
def usage_summary(project_id: int, db: Session = Depends(get_db)) -> dict:
    topic_count = db.execute(select(func.count(Topic.id)).where(Topic.project_id == project_id)).scalar_one()
    run_count = db.execute(select(func.count(PipelineRun.id)).where(PipelineRun.project_id == project_id)).scalar_one()
    total_tokens_in, total_tokens_out, total_cost = db.execute(
        select(
            func.coalesce(func.sum(Draft.token_input), 0),
            func.coalesce(func.sum(Draft.token_output), 0),
            func.coalesce(func.sum(Draft.cost_estimate_usd), 0.0),
        ).where(Draft.project_id == project_id)
    ).one()
    return {
        'topics': int(topic_count),
        'pipeline_runs': int(run_count),
        'token_input': int(total_tokens_in),
        'token_output': int(total_tokens_out),
        'cost_estimate_usd': float(total_cost),
    }
