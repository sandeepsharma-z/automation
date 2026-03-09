import base64
from datetime import datetime
import mimetypes
from pathlib import Path
import re
from typing import Any
from urllib.parse import quote_plus

import httpx

from app.services.connectors.base import BaseConnector, ConnectorError
from app.services.http_client import DEFAULT_TIMEOUT, request_with_retries


class WordPressConnector(BaseConnector):
    @property
    def _auth_header(self) -> dict[str, str]:
        if not self.project.wp_user or not self.project.wp_app_password_enc:
            raise ConnectorError('Missing WordPress credentials')
        token = f"{self.project.wp_user}:{self.project.wp_app_password_enc}"
        encoded = base64.b64encode(token.encode()).decode()
        return {'Authorization': f'Basic {encoded}'}

    @property
    def _base(self) -> str:
        return self.project.base_url.rstrip('/')

    async def test_connection(self) -> dict:
        url = f"{self._base}/wp-json/wp/v2/users/me"
        async with httpx.AsyncClient(timeout=DEFAULT_TIMEOUT) as client:
            def _factory() -> httpx.Request:
                return client.build_request('GET', url, headers=self._auth_header)

            response = await request_with_retries(_factory, client)
            if response.status_code >= 400:
                raise ConnectorError(f'WordPress auth failed: {response.text}')
            data = response.json()
        return {'ok': True, 'user': data.get('name')}

    async def _fetch_collection(self, endpoint: str) -> list[dict[str, Any]]:
        url = f"{self._base}{endpoint}"
        async with httpx.AsyncClient(timeout=DEFAULT_TIMEOUT) as client:
            def _factory() -> httpx.Request:
                return client.build_request('GET', url, headers=self._auth_header)

            response = await request_with_retries(_factory, client)
            if response.status_code >= 400:
                return []
            return response.json()

    async def sync_library(self) -> list[dict]:
        posts = await self._fetch_collection('/wp-json/wp/v2/posts?per_page=100&_fields=id,link,title,slug')
        pages = await self._fetch_collection('/wp-json/wp/v2/pages?per_page=100&_fields=id,link,title,slug')
        products = await self._fetch_collection('/wp-json/wc/v3/products?per_page=100')

        items: list[dict] = []
        for post in posts:
            items.append(
                {
                    'type': 'post',
                    'title': (post.get('title') or {}).get('rendered', 'Untitled'),
                    'url': post.get('link', ''),
                    'handle': post.get('slug'),
                    'tags_json': [],
                    'last_synced_at': datetime.utcnow(),
                }
            )
        for page in pages:
            items.append(
                {
                    'type': 'page',
                    'title': (page.get('title') or {}).get('rendered', 'Untitled'),
                    'url': page.get('link', ''),
                    'handle': page.get('slug'),
                    'tags_json': [],
                    'last_synced_at': datetime.utcnow(),
                }
            )
        for product in products:
            items.append(
                {
                    'type': 'product',
                    'title': product.get('name', 'Product'),
                    'url': product.get('permalink', ''),
                    'handle': product.get('slug'),
                    'tags_json': [t.get('name') for t in product.get('tags', []) if t.get('name')],
                    'last_synced_at': datetime.utcnow(),
                }
            )
        return items

    async def upload_media_asset(
        self,
        image_path: str,
        alt_text: str | None = None,
        caption: str | None = None,
    ) -> dict | None:
        file_path = Path(image_path)
        if not file_path.exists():
            return None
        upload_url = f"{self._base}/wp-json/wp/v2/media"
        guessed_type, _ = mimetypes.guess_type(file_path.name)
        payload_headers = {
            **self._auth_header,
            'Content-Disposition': f'attachment; filename={file_path.name}',
            'Content-Type': guessed_type or 'application/octet-stream',
        }
        binary = file_path.read_bytes()
        async with httpx.AsyncClient(timeout=httpx.Timeout(60.0)) as client:
            def _factory() -> httpx.Request:
                return client.build_request('POST', upload_url, headers=payload_headers, content=binary)

            response = await request_with_retries(_factory, client)
            if response.status_code >= 400:
                raise ConnectorError(f'WordPress media upload failed: {response.status_code} {response.text}')
            media = response.json()

            if alt_text or caption:
                update_url = f"{self._base}/wp-json/wp/v2/media/{media['id']}"
                meta = {'alt_text': alt_text or '', 'caption': caption or ''}

                def _update_factory() -> httpx.Request:
                    return client.build_request('POST', update_url, headers=self._auth_header, json=meta)

                update_response = await request_with_retries(_update_factory, client)
                if update_response.status_code >= 400:
                    raise ConnectorError(f"Failed to update media metadata: {update_response.text}")

            return {'id': media.get('id'), 'source_url': media.get('source_url')}

    async def upload_media(self, image_path: str, alt_text: str | None = None, caption: str | None = None) -> int | None:
        uploaded = await self.upload_media_asset(image_path, alt_text=alt_text, caption=caption)
        if not uploaded:
            return None
        media_id = uploaded.get('id')
        return int(media_id) if media_id else None

    async def publish(self, payload: dict) -> dict:
        endpoint = f"{self._base}/wp-json/wp/v2/posts"

        async with httpx.AsyncClient(timeout=DEFAULT_TIMEOUT) as client:
            tag_ids = await self._resolve_term_ids(client, 'tags', payload.get('tags', []))
            category_ids = await self._resolve_term_ids(client, 'categories', payload.get('categories', []))
            data = {
                'title': payload['title'],
                'content': payload['html'],
                'status': payload.get('status', 'draft'),
                'slug': payload.get('slug'),
                'excerpt': payload.get('excerpt', ''),
                'categories': category_ids,
                'tags': tag_ids,
            }
            if payload.get('scheduled_at'):
                data['date'] = payload['scheduled_at']
            if payload.get('featured_media'):
                data['featured_media'] = payload['featured_media']

            def _factory() -> httpx.Request:
                return client.build_request('POST', endpoint, headers=self._auth_header, json=data)

            response = await request_with_retries(_factory, client)
            if response.status_code >= 400:
                raise ConnectorError(f'WordPress publish failed: {response.text}')
            post = response.json()

            focus_keyphrase = str(payload.get('focus_keyphrase') or payload.get('primary_keyword') or '').strip()
            seo_meta = dict(payload.get('seo_meta') or {})
            if focus_keyphrase:
                seo_meta.setdefault('_yoast_wpseo_focuskw', focus_keyphrase)
                seo_meta.setdefault('_yoast_wpseo_focuskw_text_input', focus_keyphrase)
                seo_meta.setdefault('rank_math_focus_keyword', focus_keyphrase)
                seo_meta.setdefault('rank_math_paper_focus_keyword', focus_keyphrase)
            if seo_meta:
                data['meta'] = seo_meta

            if seo_meta:
                seo_url = f"{self._base}/wp-json/wp/v2/posts/{post['id']}"
                update_payloads = [
                    {'meta': seo_meta},
                    {'meta_input': seo_meta},
                ]
                if payload.get('excerpt'):
                    update_payloads.append({'excerpt': payload.get('excerpt', '')})

                for body in update_payloads:
                    def _seo_factory(_body: dict = body) -> httpx.Request:
                        return client.build_request('POST', seo_url, headers=self._auth_header, json=_body)

                    seo_response = await request_with_retries(_seo_factory, client)
                    # Best-effort only: many WP installs don't expose SEO meta keys in REST.
                    if seo_response.status_code >= 400:
                        continue

            return {'platform_post_id': str(post['id']), 'platform_url': post.get('link')}

    async def _resolve_term_ids(self, client: httpx.AsyncClient, taxonomy: str, terms: list[Any]) -> list[int]:
        ids: list[int] = []
        for term in (terms or []):
            term_id = await self._resolve_term_id(client, taxonomy, term)
            if term_id and term_id not in ids:
                ids.append(term_id)
        return ids

    async def _resolve_term_id(self, client: httpx.AsyncClient, taxonomy: str, term: Any) -> int | None:
        if isinstance(term, int):
            return term
        text = str(term or '').strip()
        if not text:
            return None

        lookup_url = f"{self._base}/wp-json/wp/v2/{taxonomy}?search={quote_plus(text)}&per_page=100"

        def _lookup_factory() -> httpx.Request:
            return client.build_request('GET', lookup_url, headers=self._auth_header)

        lookup_response = await request_with_retries(_lookup_factory, client)
        if lookup_response.status_code < 400:
            rows = lookup_response.json() or []
            wanted_slug = self._slugify_term(text)
            for row in rows:
                if str(row.get('slug', '')).strip() == wanted_slug:
                    return int(row.get('id'))
            for row in rows:
                if str(row.get('name', '')).strip().lower() == text.lower():
                    return int(row.get('id'))
            if rows:
                return int(rows[0].get('id'))

        create_url = f"{self._base}/wp-json/wp/v2/{taxonomy}"
        create_payload = {'name': text}

        def _create_factory() -> httpx.Request:
            return client.build_request('POST', create_url, headers=self._auth_header, json=create_payload)

        create_response = await request_with_retries(_create_factory, client)
        if create_response.status_code < 400:
            created = create_response.json() or {}
            if created.get('id'):
                return int(created['id'])

        try:
            data = create_response.json()
            if isinstance(data, dict):
                term_id = data.get('data', {}).get('term_id') or data.get('term_id')
                if term_id:
                    return int(term_id)
        except Exception:
            pass
        return None

    def _slugify_term(self, text: str) -> str:
        cleaned = re.sub(r'[^a-zA-Z0-9\s-]', '', text).strip().lower()
        cleaned = re.sub(r'[\s_-]+', '-', cleaned)
        return cleaned[:190]
