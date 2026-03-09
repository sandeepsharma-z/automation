import asyncio
import sys
from datetime import datetime
from pathlib import Path

from celery import chain
from sqlalchemy import select

ROOT = Path(__file__).resolve().parents[4]
API_PATH = ROOT / 'apps' / 'api'
if str(API_PATH) not in sys.path:
    sys.path.insert(0, str(API_PATH))

from app.db.session import SessionLocal
from app.models.entities import (
    Draft,
    DraftStatus,
    PipelineRun,
    PipelineStatus,
    Project,
    PublishRecord,
    PublishStatus,
    Topic,
    TopicStatus,
)
from app.services.connectors.factory import build_connector
from app.services.events import log_pipeline_event
from app.services.agents.blog_agent_orchestrator import (
    run_full_sync,
    run_images_sync,
    run_outline_sync,
    run_publish_sync,
    run_regenerate_sync,
)
from app.services.pipeline.engine import (
    reindex_project_rag,
    reset_project_library,
    save_library_items,
    stage_brief,
    stage_draft,
    stage_image,
    stage_qa,
    stage_research,
    stage_save_draft,
)
from apps.worker.app.celery_app import celery_app


@celery_app.task(name='apps.worker.app.tasks.pipeline_tasks.run_pipeline_chain_task')
def run_pipeline_chain_task(run_id: int) -> dict:
    workflow = chain(
        research_stage_task.s(),
        brief_stage_task.s(),
        draft_stage_task.s(),
        qa_stage_task.s(),
        image_stage_task.s(),
        save_draft_stage_task.s(),
    )
    result = workflow.apply_async(args=[{'run_id': run_id}])
    return {'run_id': run_id, 'chain_id': result.id}


@celery_app.task(name='apps.worker.app.tasks.pipeline_tasks.research_stage_task')
def research_stage_task(payload: dict) -> dict:
    db = SessionLocal()
    try:
        run = db.get(PipelineRun, payload['run_id'])
        if not run:
            raise RuntimeError('Pipeline run not found')
        return asyncio.run(stage_research(db, run, payload))
    except Exception as exc:
        _mark_pipeline_failed(db, payload.get('run_id'), str(exc))
        raise
    finally:
        db.close()


@celery_app.task(name='apps.worker.app.tasks.pipeline_tasks.brief_stage_task')
def brief_stage_task(payload: dict) -> dict:
    db = SessionLocal()
    try:
        run = db.get(PipelineRun, payload['run_id'])
        if not run:
            raise RuntimeError('Pipeline run not found')
        return asyncio.run(stage_brief(db, run, payload))
    except Exception as exc:
        _mark_pipeline_failed(db, payload.get('run_id'), str(exc))
        raise
    finally:
        db.close()


@celery_app.task(name='apps.worker.app.tasks.pipeline_tasks.draft_stage_task')
def draft_stage_task(payload: dict) -> dict:
    db = SessionLocal()
    try:
        run = db.get(PipelineRun, payload['run_id'])
        if not run:
            raise RuntimeError('Pipeline run not found')
        return asyncio.run(stage_draft(db, run, payload))
    except Exception as exc:
        _mark_pipeline_failed(db, payload.get('run_id'), str(exc))
        raise
    finally:
        db.close()


@celery_app.task(name='apps.worker.app.tasks.pipeline_tasks.qa_stage_task')
def qa_stage_task(payload: dict) -> dict:
    db = SessionLocal()
    try:
        run = db.get(PipelineRun, payload['run_id'])
        if not run:
            raise RuntimeError('Pipeline run not found')
        return asyncio.run(stage_qa(db, run, payload))
    except Exception as exc:
        _mark_pipeline_failed(db, payload.get('run_id'), str(exc))
        raise
    finally:
        db.close()


@celery_app.task(name='apps.worker.app.tasks.pipeline_tasks.image_stage_task')
def image_stage_task(payload: dict) -> dict:
    db = SessionLocal()
    try:
        run = db.get(PipelineRun, payload['run_id'])
        if not run:
            raise RuntimeError('Pipeline run not found')
        return asyncio.run(stage_image(db, run, payload))
    except Exception as exc:
        _mark_pipeline_failed(db, payload.get('run_id'), str(exc))
        raise
    finally:
        db.close()


@celery_app.task(name='apps.worker.app.tasks.pipeline_tasks.save_draft_stage_task')
def save_draft_stage_task(payload: dict) -> dict:
    db = SessionLocal()
    try:
        run = db.get(PipelineRun, payload['run_id'])
        if not run:
            raise RuntimeError('Pipeline run not found')
        return asyncio.run(stage_save_draft(db, run, payload))
    except Exception as exc:
        _mark_pipeline_failed(db, payload.get('run_id'), str(exc))
        raise
    finally:
        db.close()


@celery_app.task(
    bind=True,
    name='apps.worker.app.tasks.pipeline_tasks.sync_library_task',
    autoretry_for=(Exception,),
    retry_backoff=True,
    retry_kwargs={'max_retries': 3},
)
def sync_library_task(self, project_id: int) -> dict:
    db = SessionLocal()
    try:
        project = db.get(Project, project_id)
        if not project:
            raise RuntimeError('Project not found')

        connector = build_connector(project)
        items = asyncio.run(connector.sync_library())
        reset_project_library(db, project_id)
        total = save_library_items(db, project_id, items)

        reindex_task = reindex_library_task.delay(project_id)
        return {'project_id': project_id, 'synced': total, 'reindex_task_id': reindex_task.id}
    finally:
        db.close()


@celery_app.task(
    bind=True,
    name='apps.worker.app.tasks.pipeline_tasks.reindex_library_task',
    autoretry_for=(Exception,),
    retry_backoff=True,
    retry_kwargs={'max_retries': 3},
)
def reindex_library_task(self, project_id: int) -> dict:
    db = SessionLocal()
    try:
        result = reindex_project_rag(db, project_id=project_id)
        return {'project_id': project_id, **result}
    finally:
        db.close()


@celery_app.task(
    bind=True,
    name='apps.worker.app.tasks.pipeline_tasks.test_connection_task',
    autoretry_for=(Exception,),
    retry_backoff=True,
    retry_kwargs={'max_retries': 2},
)
def test_connection_task(self, project_id: int) -> dict:
    db = SessionLocal()
    try:
        project = db.get(Project, project_id)
        if not project:
            raise RuntimeError('Project not found')
        connector = build_connector(project)
        return asyncio.run(connector.test_connection())
    finally:
        db.close()


def _resolve_unique_slug(db, draft: Draft) -> str:
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


def _preferred_publish_slug(draft: Draft, topic: Topic | None) -> str:
    current = str(draft.slug or '').strip()
    title_slug = slugify(draft.title or '')
    keyword_slug = slugify(topic.primary_keyword) if topic and topic.primary_keyword else ''
    if current and current != title_slug:
        return current
    if keyword_slug:
        return keyword_slug
    return current or title_slug or 'post'


@celery_app.task(
    bind=True,
    name='apps.worker.app.tasks.pipeline_tasks.publish_draft_task',
    autoretry_for=(Exception,),
    retry_backoff=True,
    retry_kwargs={'max_retries': 4},
)
def publish_draft_task(self, publish_record_id: int, publish_payload: dict) -> dict:
    db = SessionLocal()
    try:
        record = db.get(PublishRecord, publish_record_id)
        if not record:
            raise RuntimeError('Publish record not found')

        draft = db.get(Draft, record.draft_id)
        project = db.get(Project, record.project_id)
        topic = db.get(Topic, draft.topic_id) if draft and draft.topic_id else None
        if not draft or not project:
            raise RuntimeError('Draft or project not found')

        mode = str((publish_payload or {}).get('mode') or 'draft').lower()
        if mode == 'publish':
            mode = 'publish_now'

        draft.status = DraftStatus.publishing
        draft.slug = _preferred_publish_slug(draft, topic)
        draft.slug = _resolve_unique_slug(db, draft)
        db.add(draft)
        record.status = PublishStatus.queued
        db.add(record)
        db.commit()

        connector = build_connector(project)

        if mode in {'publish_now', 'scheduled'}:
            platform_status = 'publish' if project.platform.value == 'wordpress' else 'published'
        else:
            platform_status = 'draft'

        featured_media = None
        if project.platform.value == 'wordpress' and draft.image_path:
            featured_media = asyncio.run(connector.upload_media(draft.image_path, draft.alt_text, draft.caption))

        payload = {
            'title': draft.title,
            'html': draft.html,
            'slug': draft.slug,
            'excerpt': draft.meta_description,
            'meta_title': draft.meta_title,
            'meta_description': draft.meta_description,
            'tags': publish_payload.get('tags', []),
            'categories': publish_payload.get('categories', []),
            'status': platform_status,
            'scheduled_at': None,
            'featured_media': featured_media,
            'enable_seo_meta': bool(project.settings_json.get('wordpress_seo_meta_enabled', False)),
            'seo_meta': {
                '_yoast_wpseo_title': draft.meta_title,
                '_yoast_wpseo_metadesc': draft.meta_description,
                'rank_math_title': draft.meta_title,
                'rank_math_description': draft.meta_description,
            },
            'image_path': draft.image_path,
            'alt_text': draft.alt_text,
        }

        published = asyncio.run(connector.publish(payload))

        record.platform_post_id = published.get('platform_post_id')
        record.platform_url = published.get('platform_url')
        record.status = PublishStatus.published
        record.published_at = datetime.utcnow()
        record.error_message = None

        draft.status = DraftStatus.published if mode in {'publish_now', 'scheduled'} else DraftStatus.approved
        db.add(record)
        db.add(draft)
        db.commit()
        return {'publish_record_id': record.id, 'status': record.status.value}
    except Exception as exc:
        if 'record' in locals() and record:
            record.status = PublishStatus.failed
            record.error_message = str(exc)
            db.add(record)
        if 'draft' in locals() and draft:
            draft.status = DraftStatus.failed
            db.add(draft)
        db.commit()
        raise
    finally:
        db.close()


@celery_app.task(name='apps.worker.app.tasks.pipeline_tasks.process_scheduled_publishes_task')
def process_scheduled_publishes_task() -> dict:
    db = SessionLocal()
    try:
        now = datetime.utcnow()
        records = db.execute(
            select(PublishRecord)
            .where(PublishRecord.status == PublishStatus.scheduled)
            .where(PublishRecord.scheduled_at.is_not(None))
            .where(PublishRecord.scheduled_at <= now)
            .order_by(PublishRecord.scheduled_at.asc())
            .limit(50)
        ).scalars().all()

        dispatched = 0
        for record in records:
            payload = dict(record.payload_json or {})
            if not payload:
                payload = {'mode': 'publish_now'}
            payload['mode'] = 'publish_now'
            record.status = PublishStatus.queued
            db.add(record)
            db.commit()
            publish_draft_task.delay(record.id, payload)
            dispatched += 1

        return {'status': 'ok', 'dispatched': dispatched}
    finally:
        db.close()


@celery_app.task(name='apps.worker.app.tasks.pipeline_tasks.rollup_usage_task')
def rollup_usage_task() -> dict:
    return {'status': 'ok', 'timestamp': datetime.utcnow().isoformat()}


@celery_app.task(
    bind=True,
    name='apps.worker.app.tasks.pipeline_tasks.generate_outline_job',
    autoretry_for=(Exception,),
    retry_backoff=True,
    retry_kwargs={'max_retries': 3},
)
def generate_outline_job(self, payload: dict) -> dict:
    db = SessionLocal()
    try:
        return run_outline_sync(db, payload)
    finally:
        db.close()


@celery_app.task(
    bind=True,
    name='apps.worker.app.tasks.pipeline_tasks.generate_draft_job',
)
def generate_draft_job(self, payload: dict) -> dict:
    db = SessionLocal()
    try:
        return run_full_sync(db, payload)
    finally:
        db.close()


@celery_app.task(
    bind=True,
    name='apps.worker.app.tasks.pipeline_tasks.regenerate_draft_job',
)
def regenerate_draft_job(self, draft_id: int, payload: dict) -> dict:
    db = SessionLocal()
    try:
        return run_regenerate_sync(db, draft_id, payload)
    finally:
        db.close()


@celery_app.task(
    bind=True,
    name='apps.worker.app.tasks.pipeline_tasks.generate_images_job',
    autoretry_for=(Exception,),
    retry_backoff=True,
    retry_kwargs={'max_retries': 3},
)
def generate_images_job(self, draft_id: int, payload: dict) -> dict:
    db = SessionLocal()
    try:
        return run_images_sync(db, draft_id, payload)
    finally:
        db.close()


@celery_app.task(
    bind=True,
    name='apps.worker.app.tasks.pipeline_tasks.publish_draft_job',
    autoretry_for=(Exception,),
    retry_backoff=True,
    retry_kwargs={'max_retries': 3},
)
def publish_draft_job(self, draft_id: int, payload: dict) -> dict:
    db = SessionLocal()
    try:
        return run_publish_sync(db, draft_id, payload)
    finally:
        db.close()


def _mark_pipeline_failed(db, run_id: int | None, message: str) -> None:
    if not run_id:
        return
    run = db.get(PipelineRun, run_id)
    if not run:
        return
    run.status = PipelineStatus.failed
    run.stage = 'failed'
    run.error_message = message
    run.finished_at = datetime.utcnow()
    db.add(run)
    topic = db.get(Topic, run.topic_id)
    if topic:
        topic.status = TopicStatus.failed
        db.add(topic)
    db.commit()
    log_pipeline_event(db, run.id, 'error', 'Pipeline task failed', {'error': message})
