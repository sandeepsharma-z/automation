from __future__ import annotations

from dataclasses import dataclass
from urllib.parse import urlparse

from app.services.providers.serp import build_serp_provider


def normalize_domain(value: str) -> str:
    raw = str(value or '').strip().lower()
    if not raw:
        return ''
    if not raw.startswith('http://') and not raw.startswith('https://'):
        raw = f'https://{raw}'
    parsed = urlparse(raw)
    host = (parsed.netloc or parsed.path or '').lower().strip()
    if host.startswith('www.'):
        host = host[4:]
    return host


def _result_domain(url: str) -> str:
    parsed = urlparse(str(url or '').strip())
    host = (parsed.netloc or '').lower()
    if host.startswith('www.'):
        host = host[4:]
    return host


@dataclass
class KeywordRanking:
    keyword: str
    rank: int | None
    found_url: str | None
    top_results: list[dict]


async def generate_seo_report(
    *,
    website_url: str,
    keywords: list[str],
    country: str,
    language: str,
    provider_name: str,
    serp_api_key: str | None,
    dataforseo_login: str | None = None,
    dataforseo_password: str | None = None,
) -> dict:
    domain = normalize_domain(website_url)
    if not domain:
        raise RuntimeError('Website URL is required')
    clean_keywords = [str(item).strip() for item in (keywords or []) if str(item).strip()]
    if not clean_keywords:
        raise RuntimeError('Provide at least one keyword')

    provider = build_serp_provider(
        provider_name=provider_name,
        serp_api_key=serp_api_key,
        dataforseo_login=dataforseo_login,
        dataforseo_password=dataforseo_password,
    )

    rows: list[KeywordRanking] = []
    for keyword in clean_keywords:
        results = await provider.search(keyword, country, language)
        rank = None
        found_url = None
        top_results: list[dict] = []
        for idx, item in enumerate(results[:20], start=1):
            url = str(item.get('url') or '').strip()
            title = str(item.get('title') or '').strip()
            row_domain = _result_domain(url)
            top_results.append(
                {
                    'position': idx,
                    'title': title,
                    'url': url,
                    'domain': row_domain,
                    'is_target': row_domain == domain,
                }
            )
            if rank is None and row_domain == domain:
                rank = idx
                found_url = url

        rows.append(
            KeywordRanking(
                keyword=keyword,
                rank=rank,
                found_url=found_url,
                top_results=top_results,
            )
        )

    found_count = sum(1 for row in rows if row.rank is not None)
    avg_rank = round(sum(row.rank for row in rows if row.rank is not None) / found_count, 2) if found_count else None

    return {
        'website_url': website_url,
        'domain': domain,
        'provider': provider_name,
        'country': country,
        'language': language,
        'summary': {
            'keyword_count': len(rows),
            'found_count': found_count,
            'not_found_count': len(rows) - found_count,
            'average_rank': avg_rank,
            'visibility_percent': round((found_count / len(rows)) * 100, 2) if rows else 0.0,
        },
        'items': [
            {
                'keyword': row.keyword,
                'rank': row.rank,
                'found_url': row.found_url,
                'top_results': row.top_results,
            }
            for row in rows
        ],
    }

