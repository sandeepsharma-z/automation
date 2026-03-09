from sqlalchemy import create_engine
from sqlalchemy.orm import Session, sessionmaker

from app.db.base import Base
from app.models.entities import Draft, DraftStatus, PlatformType, Project
from app.services.quality.diversity_engine import choose_next_structure
from app.services.quality.similarity_guard import compare_against_recent_drafts, should_regenerate


def make_session() -> Session:
    engine = create_engine('sqlite+pysqlite:///:memory:', future=True)
    Base.metadata.create_all(engine)
    return sessionmaker(bind=engine, future=True)()


def test_similarity_guard_triggers_regeneration():
    db = make_session()
    project = Project(name='P', platform=PlatformType.wordpress, base_url='https://example.com', settings_json={})
    db.add(project)
    db.commit()
    db.refresh(project)

    html = '<article><h1>SEO Plan</h1><h2>Step One</h2><p>Repeatable content operations workflow.</p></article>'
    draft = Draft(
        topic_id=1,
        project_id=project.id,
        title='A',
        slug='a',
        html=html,
        outline_json=['Step One'],
        meta_title='mt',
        meta_description='md',
        internal_links_json=[],
        sources_json=[],
        status=DraftStatus.draft,
    )
    db.add(draft)
    db.commit()

    score, near = compare_against_recent_drafts(
        db,
        project_id=project.id,
        html=html,
        outline=['Step One'],
        window_n=10,
    )

    assert score > 0.9
    assert near and near[0]['draft_id'] == draft.id
    assert should_regenerate(score, 0.78) is True


def test_diversity_rotation_prefers_less_used_structure_and_new_intro():
    db = make_session()
    project = Project(name='P', platform=PlatformType.wordpress, base_url='https://example.com', settings_json={})
    db.add(project)
    db.commit()
    db.refresh(project)

    for index in range(4):
        db.add(
            Draft(
                topic_id=index + 1,
                project_id=project.id,
                title=f'Draft {index}',
                slug=f'draft-{index}',
                html='<article><h1>X</h1><h2>A</h2><p>Body</p></article>',
                outline_json=['A'],
                meta_title='mt',
                meta_description='md',
                internal_links_json=[],
                sources_json=[],
                status=DraftStatus.draft,
                structure_type='how-to' if index < 3 else 'listicle',
                intro_style='problem-agitate-solve',
                cta_style='soft-next-step',
            )
        )
    db.commit()

    structure, intro, _cta = choose_next_structure(db, project.id, window_n=10)

    assert structure not in {'how-to', 'listicle'}
    assert intro != 'problem-agitate-solve'
