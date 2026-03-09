from sqlalchemy import create_engine
from sqlalchemy.orm import Session, sessionmaker

from app.core.config import get_settings
from app.core.security import encrypt_secret
from app.db.base import Base
from app.models.entities import PlatformType, Project
from app.services.settings import get_setting_value, resolve_project_runtime_config, upsert_setting


def make_session() -> Session:
    engine = create_engine('sqlite+pysqlite:///:memory:', future=True)
    Base.metadata.create_all(engine)
    return sessionmaker(bind=engine, future=True)()


def test_project_overrides_global_settings(monkeypatch):
    monkeypatch.setenv('OPENAI_MODEL', 'env-model')
    monkeypatch.setenv('INTERNAL_LINKS_MAX', '5')
    get_settings.cache_clear()

    db = make_session()
    upsert_setting(db, 'openai_model', 'global-model')
    upsert_setting(db, 'internal_links_max', 4)

    project = Project(
        name='Project A',
        platform=PlatformType.wordpress,
        base_url='https://example.com',
        settings_json={
            'openai_model': 'project-model',
            'internal_links_max': 3,
            'openai_api_key_enc': encrypt_secret('project-key'),
        },
    )
    db.add(project)
    db.commit()
    db.refresh(project)

    runtime = resolve_project_runtime_config(db, project)
    assert runtime['openai_model'] == 'project-model'
    assert runtime['internal_links_max'] == 3
    assert runtime['openai_api_key'] == 'project-key'


def test_settings_secret_values_are_masked():
    db = make_session()
    upsert_setting(db, 'openai_api_key', 'sk-test-123456')
    masked = get_setting_value(db, 'openai_api_key', decrypt_secrets=False, include_env_fallback=False)
    clear = get_setting_value(db, 'openai_api_key', decrypt_secrets=True, include_env_fallback=False)

    assert masked != 'sk-test-123456'
    assert clear == 'sk-test-123456'
