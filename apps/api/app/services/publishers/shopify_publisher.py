from __future__ import annotations

from typing import Any
from urllib.parse import urlparse

from bs4 import BeautifulSoup

from app.models.entities import Draft, Project
from app.core.config import get_settings
from app.services.connectors.factory import build_connector


def _public_api_base() -> str:
    settings = get_settings()
    host = str(settings.api_host or '127.0.0.1').strip()
    if host in {'0.0.0.0', '::'}:
        host = '127.0.0.1'
    port = int(settings.api_port or 8000)
    return f'http://{host}:{port}'


def _to_absolute_media_url(value: str) -> str:
    raw = str(value or '').strip()
    if not raw:
        return raw
    if raw.startswith('http://') or raw.startswith('https://'):
        return raw
    normalized = raw.replace('\\', '/')
    if '/media/' in normalized:
        suffix = normalized.split('/media/', 1)[1].lstrip('/')
        return f"{_public_api_base()}/media/{suffix}"
    if normalized.startswith('media/'):
        return f"{_public_api_base()}/{normalized}"
    if 'storage/media/' in normalized:
        suffix = normalized.split('storage/media/', 1)[1].lstrip('/')
        return f"{_public_api_base()}/media/{suffix}"
    if normalized.startswith('/'):
        return f"{_public_api_base()}{normalized}"
    return f"{_public_api_base()}/{normalized}"


def _normalize_shopify_html(html: str) -> str:
    source_html = str(html or '')
    if not source_html:
        return source_html
    soup = BeautifulSoup(source_html, 'html.parser')
    for image in soup.find_all('img'):
        src = str(image.get('src') or '').strip()
        if not src:
            continue
        image['src'] = _to_absolute_media_url(src)
    return str(soup)


async def publish_shopify_draft(
    project: Project,
    draft: Draft,
    *,
    mode: str,
    scheduled_at: str | None = None,
    tags: list[str] | None = None,
    blog_id: int | None = None,
) -> dict[str, Any]:
    connector = build_connector(project)
    settings_json = dict(project.settings_json or {})
    existing_article_id = int(draft.platform_post_id) if str(draft.platform_post_id or '').isdigit() else None

    combined_tags = list(tags or [])
    default_tags = settings_json.get('shopify_tags') or []
    if isinstance(default_tags, list):
        combined_tags.extend([str(tag).strip() for tag in default_tags if str(tag or '').strip()])

    payload = {
        'title': draft.title,
        'html': _normalize_shopify_html(draft.html),
        'slug': draft.slug,
        'meta_title': draft.meta_title,
        'meta_description': draft.meta_description,
        'excerpt': draft.meta_description,
        'status': 'published' if mode in {'publish_now', 'scheduled'} else 'draft',
        'scheduled_at': scheduled_at if mode == 'scheduled' else None,
        'tags': list(dict.fromkeys(combined_tags)),
        'blog_id': blog_id or settings_json.get('shopify_blog_id'),
        'author': settings_json.get('shopify_author') or 'ContentOps AI',
        'article_id': existing_article_id,
        'image_path': draft.image_path,
        'alt_text': draft.alt_text,
    }
    return await connector.publish(payload)
