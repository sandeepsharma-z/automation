import asyncio

import httpx

from app.models.entities import PlatformType, Project
from app.services.connectors.wordpress import WordPressConnector


def test_wordpress_test_connection(monkeypatch):
    project = Project(
        name='WP',
        platform=PlatformType.wordpress,
        base_url='https://example.com',
        wp_user='editor',
        wp_app_password_enc='app-pass',
        settings_json={},
    )
    connector = WordPressConnector(project)

    async def fake_request(request_factory, client, retries=3, backoff_base=0.5):
        request = request_factory()
        assert request.url.path.endswith('/wp-json/wp/v2/users/me')
        return httpx.Response(200, request=request, json={'name': 'Editor'})

    monkeypatch.setattr('app.services.connectors.wordpress.request_with_retries', fake_request)

    result = asyncio.run(connector.test_connection())
    assert result['ok'] is True
    assert result['user'] == 'Editor'


def test_wordpress_publish(monkeypatch):
    project = Project(
        name='WP',
        platform=PlatformType.wordpress,
        base_url='https://example.com',
        wp_user='editor',
        wp_app_password_enc='app-pass',
        settings_json={},
    )
    connector = WordPressConnector(project)

    async def fake_request(request_factory, client, retries=3, backoff_base=0.5):
        request = request_factory()
        if request.url.path.endswith('/wp-json/wp/v2/posts'):
            return httpx.Response(201, request=request, json={'id': 77, 'link': 'https://example.com/post'})
        return httpx.Response(200, request=request, json={})

    monkeypatch.setattr('app.services.connectors.wordpress.request_with_retries', fake_request)

    published = asyncio.run(
        connector.publish(
            {
                'title': 'Hello',
                'html': '<p>World</p>',
                'status': 'draft',
                'slug': 'hello',
                'categories': [],
                'tags': [],
            }
        )
    )
    assert published['platform_post_id'] == '77'
    assert published['platform_url'] == 'https://example.com/post'
