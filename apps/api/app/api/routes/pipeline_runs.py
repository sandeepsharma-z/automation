from datetime import datetime

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.api.deps import get_current_admin
from app.db.session import get_db
from app.models.entities import PipelineEvent, PipelineRun, PipelineStatus, Topic, TopicStatus
from app.schemas.entities import PipelineEventResponse, PipelineRunResponse
from app.services.events import log_pipeline_event

router = APIRouter(prefix='/api/pipeline-runs', tags=['pipeline-runs'], dependencies=[Depends(get_current_admin)])


@router.get('/{run_id}')
def get_pipeline_run(run_id: int, db: Session = Depends(get_db)) -> dict:
    run = db.get(PipelineRun, run_id)
    if not run:
        raise HTTPException(status_code=404, detail='Pipeline run not found')

    events = db.execute(
        select(PipelineEvent)
        .where(PipelineEvent.pipeline_run_id == run_id)
        .order_by(PipelineEvent.created_at.asc())
    ).scalars().all()

    return {
        'run': PipelineRunResponse.model_validate(run).model_dump(),
        'events': [PipelineEventResponse.model_validate(event).model_dump() for event in events],
    }


@router.get('')
def list_pipeline_runs(project_id: int, db: Session = Depends(get_db)) -> list[PipelineRunResponse]:
    runs = db.execute(
        select(PipelineRun).where(PipelineRun.project_id == project_id).order_by(PipelineRun.id.desc())
    ).scalars().all()
    return [PipelineRunResponse.model_validate(run) for run in runs]


@router.post('/{run_id}/cancel', response_model=PipelineRunResponse)
def cancel_pipeline_run(run_id: int, db: Session = Depends(get_db)) -> PipelineRunResponse:
    run = db.get(PipelineRun, run_id)
    if not run:
        raise HTTPException(status_code=404, detail='Pipeline run not found')

    if run.status in {PipelineStatus.completed, PipelineStatus.failed}:
        return PipelineRunResponse.model_validate(run)

    run.status = PipelineStatus.failed
    run.stage = 'failed'
    run.error_message = 'Cancelled by user from Blog Agent.'
    run.finished_at = datetime.utcnow()
    db.add(run)

    topic = db.get(Topic, run.topic_id)
    if topic and topic.status in {TopicStatus.pending, TopicStatus.running}:
        topic.status = TopicStatus.failed
        db.add(topic)

    db.commit()
    db.refresh(run)
    log_pipeline_event(
        db,
        run.id,
        'warning',
        'Pipeline cancelled by user',
        {'reason': 'manual_stop_from_blog_agent'},
    )
    return PipelineRunResponse.model_validate(run)
