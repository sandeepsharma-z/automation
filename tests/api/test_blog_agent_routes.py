import pytest

pytest.importorskip('fastapi')
from fastapi.testclient import TestClient

from app.core.security import create_access_token
from app.main import app


def auth_headers() -> dict[str, str]:
    return {'Authorization': f'Bearer {create_access_token("admin")}' }


def test_blog_agent_routes_contract(monkeypatch):
    monkeypatch.setattr(
        'app.api.routes.blog_agent.run_outline_sync',
        lambda _db, _payload: {'pipeline_run_id': 1, 'draft_id': 11, 'outline': ['A', 'B']},
    )
    monkeypatch.setattr(
        'app.api.routes.blog_agent.run_full_sync',
        lambda _db, _payload: {'pipeline_run_id': 2, 'draft_id': 22, 'state': {'status': 'draft'}},
    )
    monkeypatch.setattr(
        'app.api.routes.blog_agent.run_regenerate_sync',
        lambda _db, draft_id, _payload: {'pipeline_run_id': 3, 'draft_id': draft_id + 1},
    )
    monkeypatch.setattr(
        'app.api.routes.blog_agent.run_images_sync',
        lambda _db, draft_id, _payload: {'draft_id': draft_id, 'generated': 2},
    )
    monkeypatch.setattr(
        'app.api.routes.blog_agent.run_publish_sync',
        lambda _db, draft_id, _payload: {'draft_id': draft_id, 'status': 'published'},
    )
    monkeypatch.setattr(
        'app.api.routes.blog_agent.get_blog_agent_state',
        lambda _db, draft_id: {'draft_id': draft_id, 'title': 'Demo', 'status': 'draft'},
    )

    client = TestClient(app)

    outline_res = client.post(
        '/api/blog-agent/outline',
        headers=auth_headers(),
        json={
            'project_id': 1,
            'platform': 'wordpress',
            'topic': 'Topic',
            'primary_keyword': 'keyword',
            'secondary_keywords': ['one'],
            'tone': 'professional',
            'country': 'us',
            'language': 'en',
            'desired_word_count': 1200,
            'image_mode': 'featured_only',
            'inline_images_count': 0,
            'autopublish': False,
            'publish_status': 'draft',
        },
    )
    assert outline_res.status_code == 200
    assert outline_res.json()['draft_id'] == 11

    generate_res = client.post(
        '/api/blog-agent/generate',
        headers=auth_headers(),
        json={
            'project_id': 1,
            'platform': 'wordpress',
            'topic': 'Topic',
            'primary_keyword': 'keyword',
            'secondary_keywords': ['one'],
            'tone': 'professional',
            'country': 'us',
            'language': 'en',
            'desired_word_count': 1200,
            'image_mode': 'featured_only',
            'inline_images_count': 0,
            'autopublish': False,
            'publish_status': 'draft',
        },
    )
    assert generate_res.status_code == 200
    assert generate_res.json()['draft_id'] == 22

    regenerate_res = client.post(
        '/api/blog-agent/22/regenerate',
        headers=auth_headers(),
        json={
            'force_different_structure': True,
            'tone': 'friendly',
            'image_mode': 'featured_only',
            'inline_images_count': 0,
        },
    )
    assert regenerate_res.status_code == 200
    assert regenerate_res.json()['draft_id'] == 23

    images_res = client.post(
        '/api/blog-agent/23/images',
        headers=auth_headers(),
        json={'image_mode': 'featured+inline', 'inline_images_count': 2},
    )
    assert images_res.status_code == 200
    assert images_res.json()['generated'] == 2

    publish_res = client.post(
        '/api/blog-agent/23/publish',
        headers=auth_headers(),
        json={'mode': 'publish_now', 'platform': 'wordpress'},
    )
    assert publish_res.status_code == 200
    assert publish_res.json()['status'] == 'published'

    get_res = client.get('/api/blog-agent/23', headers=auth_headers())
    assert get_res.status_code == 200
    assert get_res.json()['draft_id'] == 23
