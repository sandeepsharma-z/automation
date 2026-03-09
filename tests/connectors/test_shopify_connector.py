import asyncio

import httpx

from app.models.entities import PlatformType, Project
from app.services.connectors.shopify import ShopifyConnector


def test_shopify_sync_library(monkeypatch):
    project = Project(
        name='Shop',
        platform=PlatformType.shopify,
        base_url='https://placeholder',
        shopify_store='demo.myshopify.com',
        shopify_token_enc='token',
        settings_json={},
    )
    connector = ShopifyConnector(project)

    async def fake_request(request_factory, client, retries=3, backoff_base=0.5):
        request = request_factory()
        path = request.url.path
        if path.endswith('/products.json'):
            return httpx.Response(200, request=request, json={'products': [{'title': 'A', 'handle': 'a', 'tags': 'x,y'}]})
        if path.endswith('/custom_collections.json'):
            return httpx.Response(200, request=request, json={'custom_collections': [{'title': 'C', 'handle': 'c'}]})
        if path.endswith('/blogs.json'):
            return httpx.Response(200, request=request, json={'blogs': [{'id': 1, 'handle': 'news'}]})
        if path.endswith('/blogs/1/articles.json'):
            return httpx.Response(200, request=request, json={'articles': [{'title': 'Post', 'handle': 'post'}]})
        return httpx.Response(200, request=request, json={})

    monkeypatch.setattr('app.services.connectors.shopify.request_with_retries', fake_request)

    items = asyncio.run(connector.sync_library())
    assert len(items) == 3
    assert any(item['type'] == 'product' for item in items)
    assert any(item['type'] == 'collection' for item in items)
    assert any(item['type'] == 'blog_post' for item in items)


def test_shopify_publish(monkeypatch):
    project = Project(
        name='Shop',
        platform=PlatformType.shopify,
        base_url='https://placeholder',
        shopify_store='demo.myshopify.com',
        shopify_token_enc='token',
        settings_json={'shopify_blog_id': 4},
    )
    connector = ShopifyConnector(project)

    async def fake_request(request_factory, client, retries=3, backoff_base=0.5):
        request = request_factory()
        if request.url.path.endswith('/blogs/4/articles.json'):
            return httpx.Response(201, request=request, json={'article': {'id': 44, 'url': 'https://demo/blog/post'}})
        return httpx.Response(200, request=request, json={})

    monkeypatch.setattr('app.services.connectors.shopify.request_with_retries', fake_request)

    result = asyncio.run(
        connector.publish(
            {
                'title': 'Demo',
                'html': '<p>Hello</p>',
                'status': 'draft',
                'tags': ['x'],
            }
        )
    )
    assert result['platform_post_id'] == '44'
    assert result['platform_url'] == 'https://demo/blog/post'
