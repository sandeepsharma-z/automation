from datetime import datetime

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.api.deps import get_current_admin
from app.core.celery_client import celery_client
from app.db.session import get_db
from app.models.entities import PipelineRun, PipelineStatus, Topic
from app.schemas.entities import TopicCreate, TopicResponse

router = APIRouter(prefix='/api/topics', tags=['topics'], dependencies=[Depends(get_current_admin)])


@router.post('/project/{project_id}', response_model=TopicResponse)
def create_topic(project_id: int, payload: TopicCreate, db: Session = Depends(get_db)) -> Topic:
    topic = Topic(
        project_id=project_id,
        title=payload.title,
        primary_keyword=payload.primary_keyword,
        secondary_keywords_json=payload.secondary_keywords_json,
        desired_word_count=payload.desired_word_count,
    )
    db.add(topic)
    db.commit()
    db.refresh(topic)
    return topic


@router.post('/{topic_id}/run')
def run_topic(topic_id: int, db: Session = Depends(get_db)) -> dict:
    topic = db.get(Topic, topic_id)
    if not topic:
        raise HTTPException(status_code=404, detail='Topic not found')

    run = PipelineRun(
        topic_id=topic.id,
        project_id=topic.project_id,
        status=PipelineStatus.queued,
        stage='queued',
        started_at=datetime.utcnow(),
    )
    db.add(run)
    db.commit()
    db.refresh(run)

    task = celery_client.send_task(
        'apps.worker.app.tasks.pipeline_tasks.run_pipeline_chain_task',
        args=[run.id],
        queue='celery',
    )
    return {'pipeline_run_id': run.id, 'task_id': task.id}


@router.get('/project/{project_id}', response_model=list[TopicResponse])
def list_topics_by_project(project_id: int, db: Session = Depends(get_db)) -> list[Topic]:
    return db.execute(select(Topic).where(Topic.project_id == project_id).order_by(Topic.created_at.desc())).scalars().all()
