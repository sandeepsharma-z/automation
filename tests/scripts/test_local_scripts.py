from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


def _read(path: str) -> str:
    return (ROOT / path).read_text(encoding='utf-8')


def test_powershell_local_scripts_have_expected_commands():
    setup = _read('scripts/local_setup.ps1')
    run_api = _read('scripts/local_run_api.ps1')
    run_worker = _read('scripts/local_run_worker.ps1')
    run_admin = _read('scripts/local_run_admin.ps1')

    assert 'python -m venv' in setup
    assert 'pip install -r' in setup
    assert 'alembic' in setup
    assert 'upgrade head' in setup

    assert 'uvicorn apps.api.app.main:app' in run_api
    assert 'celery -A apps.worker.app.celery_app.celery_app worker' in run_worker
    assert '--pool=solo' in run_worker
    assert 'sqla+' in run_worker
    assert 'npm run dev -- -p 3000' in run_admin


def test_bash_local_scripts_have_expected_commands():
    setup = _read('scripts/local_setup.sh')
    run_api = _read('scripts/local_run_api.sh')
    run_worker = _read('scripts/local_run_worker.sh')
    run_admin = _read('scripts/local_run_admin.sh')

    assert setup.startswith('#!/usr/bin/env bash')
    assert 'python3 -m venv' in setup
    assert 'pip install -r' in setup
    assert 'alembic' in setup
    assert 'upgrade head' in setup

    assert 'uvicorn apps.api.app.main:app' in run_api
    assert 'celery -A apps.worker.app.celery_app.celery_app worker' in run_worker
    assert '--pool=solo' in run_worker
    assert 'sqla+' in run_worker
    assert 'npm run dev -- -p 3000' in run_admin
