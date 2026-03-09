import base64
from datetime import datetime
from pathlib import Path
from typing import Any

import httpx

from app.services.connectors.base import BaseConnector, ConnectorError
from app.services.http_client import DEFAULT_TIMEOUT, request_with_retries


class ShopifyConnector(BaseConnector):
    API_VERSION = '2024-10'

    @property
    def _store(self) -> str:
        return (self.project.shopify_store or '').replace('https://', '').replace('http://', '').strip('/')

    @property
    def _base(self) -> str:
        if not self._store:
            raise ConnectorError('Missing Shopify store domain')
        return f"https://{self._store}/admin/api/{self.API_VERSION}"

    @property
    def _headers(self) -> dict[str, str]:
        if not self.project.shopify_token_enc:
            raise ConnectorError('Missing Shopify token')
        return {'X-Shopify-Access-Token': self.project.shopify_token_enc, 'Content-Type': 'application/json'}

    async def _get(self, endpoint: str) -> dict[str, Any]:
        url = f"{self._base}{endpoint}"
        async with httpx.AsyncClient(timeout=DEFAULT_TIMEOUT) as client:
            def _factory() -> httpx.Request:
                return client.build_request('GET', url, headers=self._headers)

            response = await request_with_retries(_factory, client)
            if response.status_code >= 400:
                raise ConnectorError(f'Shopify API failed ({response.status_code}): {response.text}')
            return response.json()

    async def _request_json(self, method: str, endpoint: str, *, payload: dict[str, Any] | None = None) -> dict[str, Any]:
        url = f"{self._base}{endpoint}"
        async with httpx.AsyncClient(timeout=DEFAULT_TIMEOUT) as client:
            def _factory() -> httpx.Request:
                return client.build_request(method, url, headers=self._headers, json=payload)

            response = await request_with_retries(_factory, client)
            if response.status_code >= 400:
                raise ConnectorError(f'Shopify API failed ({response.status_code}): {response.text}')
            return response.json()

    async def _upsert_article_metafield(
        self,
        *,
        blog_id: int,
        article_id: int,
        namespace: str,
        key: str,
        value: str,
        value_type: str = 'single_line_text_field',
    ) -> None:
        normalized = str(value or '').strip()
        if not normalized:
            return
        body = {'metafield': {'namespace': namespace, 'key': key, 'value': normalized, 'type': value_type}}
        endpoints = [
            f'/articles/{article_id}/metafields.json',
            f'/blogs/{blog_id}/articles/{article_id}/metafields.json',
        ]
        for endpoint in endpoints:
            try:
                existing_resp = await self._request_json('GET', endpoint)
                existing_list = list(existing_resp.get('metafields') or [])
                existing = next(
                    (
                        row
                        for row in existing_list
                        if str(row.get('namespace') or '').strip() == namespace
                        and str(row.get('key') or '').strip() == key
                    ),
                    None,
                )
                metafield_id = (existing or {}).get('id')
                if metafield_id:
                    await self._request_json('PUT', f'/metafields/{int(metafield_id)}.json', payload=body)
                else:
                    await self._request_json('POST', endpoint, payload=body)
                return
            except ConnectorError:
                continue
        # SEO metafield update is best-effort. Do not block publish success.
        return

    async def get_shop_info(self) -> dict[str, Any]:
        shop = (await self._get('/shop.json')).get('shop', {}) or {}
        return {
            'name': shop.get('name'),
            'primary_domain': (
                (shop.get('primary_domain') or {}).get('host')
                or shop.get('myshopify_domain')
                or self._store
            ),
        }

    async def list_blogs(self) -> list[dict[str, Any]]:
        blogs = (await self._get('/blogs.json?limit=250')).get('blogs', []) or []
        output: list[dict[str, Any]] = []
        for blog in blogs:
            blog_id = blog.get('id')
            if blog_id is None:
                continue
            output.append(
                {
                    'id': int(blog_id),
                    'title': str(blog.get('title') or '').strip() or 'Untitled Blog',
                    'handle': str(blog.get('handle') or '').strip(),
                }
            )
        return output

    async def test_connection(self) -> dict:
        info = await self.get_shop_info()
        return {'ok': True, 'shop': info.get('name'), 'primary_domain': info.get('primary_domain')}

    async def sync_library(self) -> list[dict]:
        items: list[dict] = []
        products = (await self._get('/products.json?limit=250')).get('products', [])
        collections = (await self._get('/custom_collections.json?limit=250')).get('custom_collections', [])
        blogs = (await self._get('/blogs.json?limit=50')).get('blogs', [])

        for product in products:
            handle = product.get('handle')
            items.append(
                {
                    'type': 'product',
                    'title': product.get('title', 'Product'),
                    'url': f"https://{self._store}/products/{handle}" if handle else '',
                    'handle': handle,
                    'tags_json': [t.strip() for t in (product.get('tags') or '').split(',') if t.strip()],
                    'last_synced_at': datetime.utcnow(),
                }
            )
        for collection in collections:
            handle = collection.get('handle')
            items.append(
                {
                    'type': 'collection',
                    'title': collection.get('title', 'Collection'),
                    'url': f"https://{self._store}/collections/{handle}" if handle else '',
                    'handle': handle,
                    'tags_json': [],
                    'last_synced_at': datetime.utcnow(),
                }
            )
        for blog in blogs:
            blog_id = blog.get('id')
            articles = (await self._get(f'/blogs/{blog_id}/articles.json?limit=50')).get('articles', [])
            for article in articles:
                handle = article.get('handle')
                items.append(
                    {
                        'type': 'blog_post',
                        'title': article.get('title', 'Article'),
                        'url': article.get('url', f"https://{self._store}/blogs/{blog.get('handle', '')}/{handle}"),
                        'handle': handle,
                        'tags_json': article.get('tags', []),
                        'last_synced_at': datetime.utcnow(),
                    }
                )
        return items

    async def _find_article_id_by_handle(self, blog_id: int, handle: str) -> int | None:
        wanted = str(handle or '').strip().lower()
        if not wanted:
            return None
        data = await self._request_json('GET', f'/blogs/{blog_id}/articles.json?limit=250')
        for article in list(data.get('articles') or []):
            article_handle = str(article.get('handle') or '').strip().lower()
            article_id = article.get('id')
            if article_handle == wanted and article_id is not None:
                try:
                    return int(article_id)
                except Exception:
                    continue
        return None

    async def publish(self, payload: dict) -> dict:
        blog_id = payload.get('blog_id') or self.project.settings_json.get('shopify_blog_id')
        if not blog_id:
            blogs = (await self._get('/blogs.json?limit=1')).get('blogs', [])
            if not blogs:
                raise ConnectorError('No Shopify blogs found for publishing')
            blog_id = blogs[0]['id']
        try:
            blog_id = int(blog_id)
        except Exception as exc:
            raise ConnectorError('Invalid Shopify blog id') from exc

        article_payload = {
            'article': {
                'title': payload['title'],
                'body_html': payload['html'],
                'summary_html': payload.get('excerpt') or payload.get('meta_description') or '',
                'tags': ','.join(payload.get('tags', [])),
                'author': payload.get('author') or self.project.settings_json.get('shopify_author') or 'ContentOps AI',
                'published': payload.get('status') == 'published',
                'published_at': payload.get('scheduled_at'),
            }
        }
        if payload.get('slug'):
            article_payload['article']['handle'] = payload.get('slug')

        image_path = payload.get('image_path')
        if image_path:
            fp = Path(image_path)
            if fp.exists():
                article_payload['article']['image'] = {
                    'attachment': base64.b64encode(fp.read_bytes()).decode(),
                    'alt': payload.get('alt_text') or '',
                }

        existing_article_id = payload.get('article_id')
        method = 'POST'
        endpoint = f'/blogs/{blog_id}/articles.json'
        if existing_article_id:
            try:
                article_id = int(existing_article_id)
            except Exception as exc:
                raise ConnectorError('Invalid Shopify article id') from exc
            method = 'PUT'
            endpoint = f'/blogs/{blog_id}/articles/{article_id}.json'

        try:
            response_json = await self._request_json(method, endpoint, payload=article_payload)
        except ConnectorError as exc:
            # Existing article can be deleted manually in Shopify.
            # In that case, transparently create a new one instead of failing publish.
            if method == 'PUT' and '404' in str(exc):
                response_json = await self._request_json(
                    'POST',
                    f'/blogs/{blog_id}/articles.json',
                    payload=article_payload,
                )
            elif method == 'POST' and 'handle' in str(exc).lower() and 'already been taken' in str(exc).lower():
                fallback_handle = str(article_payload.get('article', {}).get('handle') or '').strip()
                existing_by_handle = await self._find_article_id_by_handle(blog_id, fallback_handle)
                if existing_by_handle:
                    response_json = await self._request_json(
                        'PUT',
                        f'/blogs/{blog_id}/articles/{existing_by_handle}.json',
                        payload=article_payload,
                    )
                else:
                    raise
            else:
                raise
        article = response_json.get('article', {})
        article_id = int(article.get('id') or 0)
        if article_id > 0:
            await self._upsert_article_metafield(
                blog_id=blog_id,
                article_id=article_id,
                namespace='global',
                key='title_tag',
                value=str(payload.get('meta_title') or payload.get('title') or '').strip(),
            )
            await self._upsert_article_metafield(
                blog_id=blog_id,
                article_id=article_id,
                namespace='global',
                key='description_tag',
                value=str(payload.get('meta_description') or payload.get('excerpt') or '').strip(),
            )

        article_url = str(article.get('url') or '').strip()
        if not article_url:
            handle = str(article.get('handle') or '').strip()
            blog_handle = ''
            try:
                blogs = await self.list_blogs()
                selected = next((b for b in blogs if int(b.get('id') or 0) == int(blog_id)), None)
                blog_handle = str((selected or {}).get('handle') or '').strip()
            except Exception:
                blog_handle = ''
            if blog_handle and handle:
                article_url = f"https://{self._store}/blogs/{blog_handle}/{handle}"
        return {'platform_post_id': str(article.get('id')), 'platform_url': article_url}
