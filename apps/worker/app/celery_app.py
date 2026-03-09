import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
API_PATH = ROOT / 'apps' / 'api'
if str(API_PATH) not in sys.path:
    sys.path.insert(0, str(API_PATH))

from app.core.celery_client import create_celery_app

celery_app = create_celery_app()
celery_app.autodiscover_tasks(['apps.worker.app.tasks'])

# Registers worker ready/shutdown signal handlers for DB-backed heartbeats.
from apps.worker.app import worker_heartbeat  # noqa: E402,F401
