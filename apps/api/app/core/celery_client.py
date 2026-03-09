from celery import Celery

from app.core.config import get_settings


def _broker_url() -> str:
    settings = get_settings()
    if settings.celery_broker_url:
        return settings.celery_broker_url
    if settings.redis_url:
        return settings.redis_url
    return f"sqla+{settings.database_url}"


def _result_backend() -> str:
    settings = get_settings()
    if settings.celery_result_backend:
        return settings.celery_result_backend
    if settings.redis_url:
        return settings.redis_url
    return f"db+{settings.database_url}"


def create_celery_app() -> Celery:
    celery_app = Celery('contentops_ai', broker=_broker_url(), backend=_result_backend())
    celery_app.conf.update(
        include=['apps.worker.app.tasks.pipeline_tasks'],
        timezone='UTC',
        enable_utc=True,
        task_serializer='json',
        result_serializer='json',
        accept_content=['json'],
        task_acks_late=True,
        worker_prefetch_multiplier=1,
        task_default_queue='celery',
        task_default_exchange='celery',
        task_default_routing_key='celery',
        task_create_missing_queues=True,
        task_routes={
            'apps.worker.app.tasks.pipeline_tasks.*': {
                'queue': 'celery',
                'routing_key': 'celery',
            },
        },
        beat_schedule={
            'daily-usage-rollup': {
                'task': 'apps.worker.app.tasks.pipeline_tasks.rollup_usage_task',
                'schedule': 3600.0,
            },
            'dispatch-scheduled-publishes': {
                'task': 'apps.worker.app.tasks.pipeline_tasks.process_scheduled_publishes_task',
                'schedule': 60.0,
            },
        },
    )
    return celery_app


celery_client = create_celery_app()
