from __future__ import annotations

from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from app.api.deps import get_current_admin
from app.db.session import get_db
from app.services.worker_health import get_worker_health_snapshot

router = APIRouter(prefix="/api/debug", tags=["debug"], dependencies=[Depends(get_current_admin)])


@router.get("/worker")
def debug_worker(db: Session = Depends(get_db)) -> dict:
    return get_worker_health_snapshot(db)
