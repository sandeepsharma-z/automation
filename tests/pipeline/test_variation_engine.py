from sqlalchemy import create_engine
from sqlalchemy.orm import Session, sessionmaker

from app.db.base import Base
from app.models.entities import Draft, DraftStatus, PlatformType, Project
from app.services.pipeline.variation import (
    build_fingerprint,
    choose_pattern,
    ensure_default_patterns,
    fingerprint_is_recent,
    mark_pattern_used,
)


def make_session() -> Session:
    engine = create_engine('sqlite+pysqlite:///:memory:', future=True)
    Base.metadata.create_all(engine)
    return sessionmaker(bind=engine, future=True)()


def test_variation_engine_pattern_rotation():
    db = make_session()
    project = Project(name='P', platform=PlatformType.wordpress, base_url='https://example.com', settings_json={})
    db.add(project)
    db.commit()
    db.refresh(project)

    ensure_default_patterns(db, project.id)
    first = choose_pattern(db, project.id)
    mark_pattern_used(db, first)
    db.commit()

    second = choose_pattern(db, project.id)
    assert second.pattern_key != first.pattern_key


def test_fingerprint_recency_detection():
    db = make_session()
    project = Project(name='P', platform=PlatformType.wordpress, base_url='https://example.com', settings_json={})
    db.add(project)
    db.commit()
    db.refresh(project)

    fp = build_fingerprint('how-to', ['A', 'B'])
    draft = Draft(
        topic_id=1,
        project_id=project.id,
        title='T',
        slug='t',
        html='<p>x</p>',
        meta_title='mt',
        meta_description='md',
        internal_links_json=[],
        sources_json=[],
        status=DraftStatus.draft,
        fingerprint=fp,
    )
    db.add(draft)
    db.commit()

    assert fingerprint_is_recent(db, project.id, fp) is True
    assert fingerprint_is_recent(db, project.id, 'missing') is False
