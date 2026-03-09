from __future__ import annotations

from pathlib import Path
from urllib.parse import urlparse
from typing import Any
import base64

from bs4 import BeautifulSoup

from app.core.config import get_settings
from app.models.entities import Draft, Project
from app.services.connectors.base import ConnectorError
from app.services.connectors.factory import build_connector
from app.services.connectors.wordpress_runtime import (
    WordPressRuntimeConfig,
    apply_wordpress_runtime_to_project,
    wordpress_token_publish,
    wordpress_whoami_probe,
)


def _sanitize_wordpress_body_html(source_html: str) -> str:
    soup = BeautifulSoup(str(source_html or ''), 'html.parser')
    root = soup.find('article') or soup.body or soup

    # WP theme already renders title; keep body without H1 duplication.
    for h1 in root.find_all('h1'):
        h1.decompose()

    # Featured image should be WP featured media, not repeated inside content body.
    for figure in root.select('figure.contentops-featured-image'):
        figure.decompose()

    # Remove AI-added "Featured Images" content block if present in body.
    featured_heading_texts = {'featured image', 'featured images'}
    for heading in root.find_all(['h2', 'h3']):
        label = str(heading.get_text(' ', strip=True) or '').strip().lower()
        if label not in featured_heading_texts:
            continue
        cursor = heading.find_next_sibling()
        heading.decompose()
        # Remove nearby featured media artifacts until next heading.
        while cursor is not None:
            if getattr(cursor, 'name', '') in {'h2', 'h3'}:
                break
            nxt = cursor.find_next_sibling()
            if cursor.find('img') is not None or getattr(cursor, 'name', '') in {'figure', 'img', 'p'}:
                cursor.decompose()
                cursor = nxt
                continue
            break

    # Keep only first FAQ section in body.
    faq_heading_texts = {
        'frequently asked questions',
        'frequently asked question',
        'faq',
        'faqs',
        'faq section',
    }
    faq_headings = [
        heading
        for heading in root.find_all(['h2', 'h3'])
        if str(heading.get_text(' ', strip=True) or '').strip().lower() in faq_heading_texts
    ]
    for extra_heading in faq_headings[1:]:
        cursor = extra_heading.find_next_sibling()
        extra_heading.decompose()
        while cursor is not None:
            if getattr(cursor, 'name', '') in {'h2', 'h3'}:
                break
            nxt = cursor.find_next_sibling()
            cursor.decompose()
            cursor = nxt

    return str(soup)


async def publish_wordpress_draft(
    project: Project,
    draft: Draft,
    *,
    mode: str,
    scheduled_at: str | None = None,
    tags: list[str] | None = None,
    categories: list[str] | None = None,
    focus_keyphrase: str | None = None,
    runtime_config: WordPressRuntimeConfig | None = None,
) -> dict[str, Any]:
    is_token_mode = bool(runtime_config and runtime_config.auth_mode == 'token_connector')
    if runtime_config:
        apply_wordpress_runtime_to_project(project, runtime_config)
        if is_token_mode:
            probe = {'status': 200, 'wp_code': None, 'wp_message': None}
        else:
            probe = await wordpress_whoami_probe(runtime_config, timeout_seconds=15.0)
        status = int(probe.get('status') or 0)
        if status >= 400 or status == 0:
            wp_code = str(probe.get('wp_code') or '').strip()
            wp_message = str(probe.get('wp_message') or 'WordPress auth probe failed').strip()
            reason = f'{wp_code}: {wp_message}'.strip(': ')
            raise ConnectorError(reason)

    connector = None if is_token_mode else build_connector(project)

    def _public_media_path(value: str | None) -> str | None:
        raw = str(value or '').strip()
        if not raw:
            return None
        if raw.startswith('http://') or raw.startswith('https://'):
            return raw
        normalized = raw.replace('\\', '/')
        if '/media/' in normalized:
            suffix = normalized.split('/media/', 1)[1].lstrip('/')
            return f"/media/{suffix}"
        if normalized.startswith('media/'):
            return f"/{normalized}"
        if 'storage/media/' in normalized:
            suffix = normalized.split('storage/media/', 1)[1].lstrip('/')
            return f"/media/{suffix}"
        return normalized if normalized.startswith('/') else f"/{normalized}"

    def _local_path_from_src(src: str) -> Path | None:
        value = str(src or '').strip()
        if not value:
            return None
        if value.startswith('http://') or value.startswith('https://'):
            parsed = urlparse(value)
            value = parsed.path or ''
        normalized = value.replace('\\', '/')
        media_prefix = '/media/'
        storage_prefix = 'storage/media/'
        if media_prefix in normalized:
            suffix = normalized.split(media_prefix, 1)[1].lstrip('/')
            return get_settings().media_path / suffix
        if normalized.startswith('media/'):
            return get_settings().media_path / normalized.split('media/', 1)[1]
        if storage_prefix in normalized:
            suffix = normalized.split(storage_prefix, 1)[1].lstrip('/')
            return get_settings().media_path / suffix
        candidate = Path(normalized)
        return candidate if candidate.exists() else None

    async def _rewrite_inline_images(html: str) -> str:
        source_html = str(html or '')
        if not source_html or connector is None:
            return source_html
        soup = BeautifulSoup(source_html, 'html.parser')
        upload_cache: dict[str, str] = {}
        for image in soup.find_all('img'):
            src = str(image.get('src') or '').strip()
            if not src:
                continue
            local_file = _local_path_from_src(src)
            if not local_file or not local_file.exists():
                # For non-local or missing files, keep original URL untouched.
                continue
            cache_key = str(local_file.resolve())
            uploaded_url = upload_cache.get(cache_key)
            if not uploaded_url:
                try:
                    uploaded = await connector.upload_media_asset(
                        str(local_file),
                        alt_text=str(image.get('alt') or draft.alt_text or ''),
                        caption=draft.caption,
                    )
                    uploaded_url = str((uploaded or {}).get('source_url') or '').strip()
                    if not uploaded_url:
                        continue
                    upload_cache[cache_key] = uploaded_url
                except Exception:
                    # Best effort only: if inline upload fails (permissions/media endpoint),
                    # keep original image src so publishing can continue.
                    continue
            image['src'] = uploaded_url
        return str(soup)

    def _encode_image_for_token_publish(src: str, *, fallback_name: str = 'image.jpg') -> dict[str, Any] | None:
        local_file = _local_path_from_src(src)
        if not local_file or not local_file.exists():
            return None
        raw = local_file.read_bytes()
        encoded = base64.b64encode(raw).decode('utf-8')
        filename = local_file.name or fallback_name
        return {'source': 'base64', 'base64': encoded, 'filename': filename}

    def _prepare_token_media_payload(html: str) -> tuple[dict[str, Any] | None, list[dict[str, Any]], str]:
        featured_payload = None
        if draft.image_path:
            featured_descriptor = _encode_image_for_token_publish(
                draft.image_path,
                fallback_name='featured.jpg',
            )
            if featured_descriptor:
                featured_descriptor['alt'] = draft.alt_text or ''
                featured_payload = featured_descriptor

        inline_payloads: list[dict[str, Any]] = []
        soup = BeautifulSoup(html or '', 'html.parser')
        for index, img in enumerate(soup.find_all('img'), start=1):
            src = str(img.get('src') or '').strip()
            if not src:
                continue
            descriptor = _encode_image_for_token_publish(src, fallback_name=f'inline-{index}.jpg')
            if not descriptor:
                continue
            descriptor['match_src'] = src
            descriptor['alt'] = str(img.get('alt') or '')
            inline_payloads.append(descriptor)
        return featured_payload, inline_payloads, str(soup)

    def _ensure_inline_images(source_html: str) -> str:
        html_value = str(source_html or '')
        inline_records = [
            image
            for image in list(getattr(draft, 'images', []) or [])
            if str(getattr(image, 'kind', '')).lower() == 'inline' and getattr(image, 'image_path', None)
        ]
        if not inline_records:
            return html_value

        soup = BeautifulSoup(html_value or '<article></article>', 'html.parser')
        root = soup.find('article') or soup.body or soup
        for old in soup.select('figure.contentops-inline-image'):
            old.decompose()
        for tag in soup.find_all('img'):
            src = str(tag.get('src') or '').strip()
            if not src:
                tag.decompose()

        h2_tags = root.find_all('h2')
        for idx, image in enumerate(sorted(inline_records, key=lambda row: int(getattr(row, 'position', 0) or 0)), start=1):
            src = _public_media_path(str(getattr(image, 'image_path', '') or ''))
            if not src:
                continue
            figure = soup.new_tag('figure')
            figure['class'] = ['contentops-inline-image', 'contentops-generated-image']
            tag = soup.new_tag('img')
            tag['src'] = src
            tag['alt'] = str(getattr(image, 'alt_text', '') or f'Inline image {idx}')
            tag['loading'] = 'lazy'
            figure.append(tag)
            if idx - 1 < len(h2_tags):
                h2_tags[idx - 1].insert_after(figure)
            else:
                root.append(figure)
        return str(soup)

    html_with_inline = _ensure_inline_images(draft.html or '')
    html_with_inline = _sanitize_wordpress_body_html(html_with_inline)
    rewritten_html = html_with_inline if is_token_mode else await _rewrite_inline_images(html_with_inline)
    featured_media = None
    if draft.image_path and connector is not None:
        try:
            featured_local = _local_path_from_src(draft.image_path)
            if featured_local and featured_local.exists():
                featured_media = await connector.upload_media(str(featured_local), draft.alt_text, draft.caption)
            else:
                featured_media = None
        except Exception:
            # Continue publishing even if featured media upload fails.
            featured_media = None

    resolved_focus_keyphrase = str(focus_keyphrase or '').strip() or ((tags or [draft.title])[0] if tags else draft.title)
    payload = {
        'title': draft.title,
        'html': rewritten_html,
        'slug': draft.slug,
        'excerpt': draft.meta_description,
        'tags': tags or [],
        'categories': categories or [],
        'status': 'publish' if mode in {'publish_now', 'scheduled'} else 'draft',
        'scheduled_at': scheduled_at if mode == 'scheduled' else None,
        'featured_media': featured_media,
        'enable_seo_meta': bool(project.settings_json.get('wordpress_seo_meta_enabled', True)),
        'focus_keyphrase': resolved_focus_keyphrase,
        'primary_keyword': resolved_focus_keyphrase,
        'seo_meta': {
            '_yoast_wpseo_title': draft.meta_title,
            '_yoast_wpseo_metadesc': draft.meta_description,
            '_yoast_wpseo_focuskw': resolved_focus_keyphrase,
            '_yoast_wpseo_focuskw_text_input': resolved_focus_keyphrase,
            'rank_math_title': draft.meta_title,
            'rank_math_description': draft.meta_description,
            'rank_math_focus_keyword': resolved_focus_keyphrase,
            'rank_math_paper_focus_keyword': resolved_focus_keyphrase,
            '_aioseo_title': draft.meta_title,
            '_aioseo_description': draft.meta_description,
            '_aioseo_focus_keyphrase': resolved_focus_keyphrase,
            'aioseo_title': draft.meta_title,
            'aioseo_description': draft.meta_description,
            'aioseo_focus_keyphrase': resolved_focus_keyphrase,
        },
    }
    if is_token_mode and runtime_config:
        featured_payload, inline_payloads, token_html = _prepare_token_media_payload(html_with_inline)
        token_payload = {
            'post_id': int(draft.platform_post_id) if str(draft.platform_post_id or '').isdigit() else 0,
            'title': draft.title,
            'content_html': token_html,
            'status': payload['status'],
            'slug': draft.slug,
            'excerpt': draft.meta_description,
            'categories': categories or [],
            'tags': tags or [],
            'date_gmt': scheduled_at if mode == 'scheduled' else None,
            'featured_image': featured_payload,
            'inline_images': inline_payloads,
            'seo': {
                'meta_title': draft.meta_title,
                'meta_description': draft.meta_description,
                'focus_keyphrase': resolved_focus_keyphrase,
            },
            'meta': {
                'contentops_meta_title': draft.meta_title,
                'contentops_meta_description': draft.meta_description,
                'contentops_focus_keyphrase': resolved_focus_keyphrase,
            },
        }
        try:
            published = await wordpress_token_publish(runtime_config, token_payload, timeout_seconds=60.0)
            return {
                'platform_post_id': str(published.get('post_id') or ''),
                'platform_url': published.get('permalink'),
            }
        except Exception as exc:
            token_error_text = str(exc or '').strip()
            message = token_error_text.lower()
            can_fallback_basic = bool(runtime_config.wp_user and runtime_config.wp_app_password)
            token_auth_issue = (
                'invalid connector token' in message
                or 'contentops_unauthorized' in message
                or '401' in message
            )
            if not (can_fallback_basic and token_auth_issue):
                raise
            connector = build_connector(project)
            try:
                return await connector.publish(payload)
            except Exception as basic_exc:
                raise ConnectorError(
                    f"WordPress token auth failed ({token_error_text}); basic auth fallback also failed ({basic_exc})"
                ) from basic_exc
    return await connector.publish(payload)
