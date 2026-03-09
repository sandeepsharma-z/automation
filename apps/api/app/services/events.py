from datetime import datetime

from sqlalchemy.orm import Session

from app.models.entities import PipelineEvent


def log_pipeline_event(db: Session, pipeline_run_id: int, level: str, message: str, meta: dict | None = None) -> None:
    event = PipelineEvent(
        pipeline_run_id=pipeline_run_id,
        level=level,
        message=message,
        meta_json=meta or {},
        created_at=datetime.utcnow(),
    )
    db.add(event)
    db.commit()
