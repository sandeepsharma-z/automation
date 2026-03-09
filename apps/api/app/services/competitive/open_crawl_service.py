from __future__ import annotations

from datetime import datetime, timedelta
import re
from typing import Any
from urllib.parse import parse_qs, quote_plus, unquote, urlparse

import httpx
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.config import get_settings
from app.models.entities import CrawlRun
from app.services.http_client import request_with_retries


BLOCKED_COMPETITOR_DOMAINS = {
    'bing.com',
    'duckduckgo.com',
    'google.com',
    'youtube.com',
    'reddit.com',
    'zhidao.baidu.com',
    'baidu.com',
    'zhihu.com',
    'quora.com',
    'pinterest.com',
    'facebook.com',
    'instagram.com',
    'linkedin.com',
    'wikipedia.org',
}

ECOMMERCE_DOMAINS = {
    'amazon.com',
    'amazon.in',
    'flipkart.com',
    'meesho.com',
    'jiomart.com',
    'snapdeal.com',
}

ARTICLE_PATH_SIGNALS = (
    '/blog/',
    '/blogs/',
    '/news/',
    '/article/',
    '/articles/',
    '/guide/',
    '/guides/',
    '/learn/',
    '/resources/',
    '/health/',
    '/benefits/',
)

PRODUCT_PATH_SIGNALS = (
    '/product/',
    '/products/',
    '/shop/',
    '/cart',
    '/checkout',
    '/collection/',
    '/collections/',
    '/variant',
    '/dp/',
    '?variant=',
    '&variant=',
)


def build_crawl_cache_key(keyword: str, *, country: str, language: str) -> str:
    norm_keyword = ' '.join(str(keyword or '').strip().lower().split())
    norm_country = str(country or 'us').strip().lower()
    norm_language = str(language or 'en').strip().lower()
    return f"{norm_keyword}|{norm_country}|{norm_language}"


def _norm_url(value: str) -> str:
    raw = str(value or '').strip()
    if not raw.startswith('http'):
        return ''
    parsed = urlparse(raw)
    host = (parsed.netloc or '').lower().replace('www.', '')
    if not host:
        return ''
    path = parsed.path or '/'
    out = f"{parsed.scheme}://{host}{path}"
    if parsed.query:
        out = f"{out}?{parsed.query}"
    return out.rstrip('/')


def _to_int(value: Any) -> int | None:
    try:
        if value in (None, ''):
            return None
        return int(value)
    except Exception:
        return None


def _to_datetime_iso(value: Any) -> str | None:
    if value in (None, ''):
        return None
    text = str(value).strip()
    if not text:
        return None
    return text


def _tokenize(value: str) -> list[str]:
    raw = str(value or '').lower()
    out: list[str] = []
    current = []
    for ch in raw:
        if ('a' <= ch <= 'z') or ('0' <= ch <= '9'):
            current.append(ch)
            continue
        if current:
            token = ''.join(current)
            if len(token) >= 3:
                out.append(token)
            current = []
    if current:
        token = ''.join(current)
        if len(token) >= 3:
            out.append(token)
    return out


def _ascii_ratio(value: str) -> float:
    text = str(value or '')
    if not text:
        return 1.0
    ascii_count = 0
    for ch in text:
        if ord(ch) <= 127:
            ascii_count += 1
    return float(ascii_count) / float(max(len(text), 1))


def _is_domain_blocked(domain: str) -> bool:
    d = str(domain or '').strip().lower()
    if not d:
        return True
    for blocked in BLOCKED_COMPETITOR_DOMAINS:
        if d == blocked or d.endswith(f'.{blocked}'):
            return True
    return False


def _candidate_quality_score(*, keyword: str, url: str, domain: str, title: str) -> int:
    kw_terms = set(_tokenize(keyword))
    title_terms = set(_tokenize(title))
    url_terms = set(_tokenize(url))
    domain_terms = set(_tokenize(domain))
    hay = f'{str(url or "").lower()} {str(title or "").lower()} {str(domain or "").lower()}'
    if _is_domain_blocked(domain):
        return -999
    if any(domain == d or domain.endswith(f'.{d}') for d in ECOMMERCE_DOMAINS):
        return -400
    if any(flag in hay for flag in PRODUCT_PATH_SIGNALS):
        return -300
    if '/question/' in hay or '/questions/' in hay or '/answers/' in hay:
        return -220
    if any(flag in hay for flag in ('forum', 'thread', 'discussion', 'board', 'wiki')):
        return -160
    if any(flag in hay for flag in ('meaning', 'definition', 'crossword', 'solver', 'grammar', 'translate')):
        return -140
    score = 20
    if _ascii_ratio(f'{title} {url}') < 0.70:
        score -= 25
    match_count = 0
    for term in kw_terms:
        if term in title_terms:
            score += 8
            match_count += 1
        if term in url_terms or term in domain_terms:
            score += 5
            match_count += 1
    if kw_terms and match_count == 0:
        score -= 35
    if any(flag in hay for flag in ('blog', 'guide', 'industry', 'insights', 'manufactur', 'supplier', 'market')):
        score += 6
    if any(flag in hay for flag in ARTICLE_PATH_SIGNALS):
        score += 24
    return score


def _normalize_item(row: dict[str, Any]) -> dict[str, Any] | None:
    url = _norm_url(str(row.get('url') or row.get('link') or ''))
    if not url:
        return None
    domain = (urlparse(url).netloc or '').lower().replace('www.', '')
    if not domain:
        return None
    return {
        'url': url,
        'domain': domain,
        'title': str(row.get('title') or '').strip(),
        'snippet': str(row.get('snippet') or row.get('description') or '').strip(),
        'discovered_at': _to_datetime_iso(row.get('discovered_at') or row.get('first_seen')),
        'last_seen_at': _to_datetime_iso(row.get('last_seen_at') or row.get('last_seen')),
        'inlink_count': _to_int(row.get('inlink_count')),
        'content_length_estimate': _to_int(row.get('content_length_estimate') or row.get('word_count')),
    }


def _candidate_search_urls(base_endpoint: str) -> list[str]:
    base = str(base_endpoint or '').strip().rstrip('/')
    if not base:
        return []
    if base.endswith('/search'):
        return [base]
    return [
        f"{base}/search",
        f"{base}/api/search",
        f"{base}/v1/search",
    ]


def _default_local_search_urls() -> list[str]:
    # Common local OpenCrawl service hosts/ports for no-auth deployments.
    bases = [
        'http://127.0.0.1:11235',
        'http://localhost:11235',
        'http://127.0.0.1:8080',
        'http://localhost:8080',
    ]
    urls: list[str] = []
    for base in bases:
        urls.extend(_candidate_search_urls(base))
    seen: set[str] = set()
    out: list[str] = []
    for url in urls:
        if url in seen:
            continue
        seen.add(url)
        out.append(url)
    return out


def _decode_ddg_href(value: str) -> str:
    raw = str(value or '').strip()
    if not raw:
        return ''
    if raw.startswith('/l/?') or 'duckduckgo.com/l/?' in raw:
        try:
            parsed = urlparse(raw if raw.startswith('http') else f'https://duckduckgo.com{raw}')
            params = parse_qs(parsed.query or '')
            uddg = str((params.get('uddg') or [''])[0] or '').strip()
            if uddg:
                return unquote(uddg)
        except Exception:
            return raw
    return raw


def _strip_html(value: str) -> str:
    text = re.sub(r'<[^>]+>', ' ', str(value or ''))
    return re.sub(r'\s+', ' ', text).strip()


async def _fetch_duckduckgo_fallback(
    *,
    keyword: str,
    language: str = 'en',
    country: str = 'us',
    max_candidates: int = 30,
    timeout: int = 20,
) -> dict[str, Any]:
    query = str(keyword or '').strip()
    if not query:
        return {'ok': False, 'error': 'keyword_required', 'items': []}
    kl_country = str(country or 'us').lower()
    kl_lang = str(language or 'en').lower()
    kl = f'{kl_country}-{kl_lang}'
    search_url = f'https://html.duckduckgo.com/html/?q={quote_plus(query)}&kl={quote_plus(kl)}'
    try:
        async with httpx.AsyncClient(
            timeout=float(min(max(6, int(timeout or 20)), 40)),
            follow_redirects=True,
            trust_env=False,
        ) as client:
            resp = await client.get(search_url, headers={'User-Agent': 'ContentOpsAI/1.0'})
        if int(resp.status_code or 0) >= 400:
            return {'ok': False, 'error': f'ddg_http_{resp.status_code}', 'items': []}
        html = str(resp.text or '')
    except Exception as exc:
        return {'ok': False, 'error': f'ddg_request_failed:{exc}', 'items': []}

    cap = max(1, int(max_candidates or 30))
    items: list[dict[str, Any]] = []
    seen: set[str] = set()
    # Primary selector: DDG result links.
    rows = re.findall(
        r'<a[^>]+class=["\'][^"\']*result__a[^"\']*["\'][^>]+href=["\']([^"\']+)["\'][^>]*>(.*?)</a>',
        html,
        flags=re.IGNORECASE | re.DOTALL,
    )
    # Fallback selector: generic H2 links.
    if not rows:
        rows = re.findall(
            r'<h2[^>]*>\s*<a[^>]+href=["\']([^"\']+)["\'][^>]*>(.*?)</a>\s*</h2>',
            html,
            flags=re.IGNORECASE | re.DOTALL,
        )

    for href, title_html in rows:
        decoded = _decode_ddg_href(href)
        norm = _norm_url(decoded)
        if not norm or norm in seen:
            continue
        domain = (urlparse(norm).netloc or '').lower().replace('www.', '')
        if not domain:
            continue
        title = _strip_html(title_html)
        quality = _candidate_quality_score(keyword=query, url=norm, domain=domain, title=title)
        if quality < 8:
            continue
        seen.add(norm)
        items.append(
            {
                'url': norm,
                'domain': domain,
                'title': title,
                'snippet': '',
                'discovered_at': None,
                'last_seen_at': None,
                'inlink_count': None,
                'content_length_estimate': None,
            }
        )
        if len(items) >= cap:
            break

    if not items:
        return {'ok': False, 'error': 'ddg_no_results', 'items': []}
    return {
        'ok': True,
        'provider': 'duckduckgo_fallback',
        'items': items,
        'fetched_at': datetime.utcnow().isoformat(),
    }


async def _fetch_bing_fallback(
    *,
    keyword: str,
    language: str = 'en',
    country: str = 'us',
    max_candidates: int = 30,
    timeout: int = 20,
) -> dict[str, Any]:
    query = str(keyword or '').strip()
    if not query:
        return {'ok': False, 'error': 'keyword_required', 'items': []}
    cap = max(1, int(max_candidates or 30))
    cc = (str(country or 'us').strip() or 'us').upper()
    setlang = f"{str(language or 'en').lower()}-{cc}"
    search_url = f'https://www.bing.com/search?q={quote_plus(query)}&count=50&setlang={quote_plus(setlang)}&cc={quote_plus(cc)}&ensearch=1'
    try:
        async with httpx.AsyncClient(
            timeout=float(min(max(6, int(timeout or 20)), 40)),
            follow_redirects=True,
            trust_env=False,
        ) as client:
            resp = await client.get(search_url, headers={'User-Agent': 'ContentOpsAI/1.0'})
        if int(resp.status_code or 0) >= 400:
            return {'ok': False, 'error': f'bing_http_{resp.status_code}', 'items': []}
        html = str(resp.text or '')
    except Exception as exc:
        return {'ok': False, 'error': f'bing_request_failed:{exc}', 'items': []}

    rows = re.findall(
        r'<h2[^>]*>\s*<a[^>]+href=["\']([^"\']+)["\'][^>]*>(.*?)</a>\s*</h2>',
        html,
        flags=re.IGNORECASE | re.DOTALL,
    )
    items: list[dict[str, Any]] = []
    seen: set[str] = set()
    for href, title_html in rows:
        norm = _norm_url(str(href or ''))
        if not norm or norm in seen:
            continue
        domain = (urlparse(norm).netloc or '').lower().replace('www.', '')
        if not domain:
            continue
        title = _strip_html(title_html)
        quality = _candidate_quality_score(keyword=query, url=norm, domain=domain, title=title)
        if quality < 8:
            continue
        seen.add(norm)
        items.append(
            {
                'url': norm,
                'domain': domain,
                'title': title,
                'snippet': '',
                'discovered_at': None,
                'last_seen_at': None,
                'inlink_count': None,
                'content_length_estimate': None,
            }
        )
        if len(items) >= cap:
            break
    if not items:
        return {'ok': False, 'error': 'bing_no_results', 'items': []}
    return {
        'ok': True,
        'provider': 'bing_fallback',
        'items': items,
        'fetched_at': datetime.utcnow().isoformat(),
    }


async def fetch_open_crawl_live(
    *,
    keyword: str,
    language: str = 'en',
    country: str = 'us',
    max_candidates: int = 30,
    timeout: int = 20,
    api_url: str | None = None,
    api_key: str | None = None,
) -> dict[str, Any]:
    query = str(keyword or '').strip()
    if not query:
        return {'ok': False, 'error': 'keyword_required', 'items': []}
    settings = get_settings()
    endpoint = str(api_url or settings.opencrawl_api_url or '').strip()
    token = str(api_key or settings.opencrawl_api_key or '').strip()
    auto_discovery_mode = not endpoint
    candidate_urls = _candidate_search_urls(endpoint) if endpoint else _default_local_search_urls()
    headers = {
        'Content-Type': 'application/json',
        'User-Agent': 'ContentOpsAI/1.0',
    }
    if token:
        headers['Authorization'] = f'Bearer {token}'
    payload = {
        'query': query,
        'keyword': query,
        'language': str(language or 'en').lower(),
        'country': str(country or 'us').lower(),
        'mode': 'keyword_search',
        'limit': max(1, min(int(max_candidates or 30), settings.max_opencrawl_candidates)),
    }

    client_timeout = min(max(5, int(timeout or settings.opencrawl_timeout)), 60)
    attempted_urls = ', '.join(candidate_urls)
    if not candidate_urls:
        return {'ok': False, 'error': 'opencrawl_api_url_missing', 'items': []}

    data: Any = {}
    last_error = 'opencrawl_failed'
    try:
        async with httpx.AsyncClient(timeout=float(client_timeout), follow_redirects=True, trust_env=False) as client:
            for url in candidate_urls:
                try:
                    if auto_discovery_mode:
                        resp = await client.post(url, json=payload, headers=headers)
                    else:
                        def _factory() -> httpx.Request:
                            return client.build_request('POST', url, json=payload, headers=headers)

                        resp = await request_with_retries(_factory, client)
                    status_code = int(resp.status_code or 0)
                    if status_code >= 400:
                        snippet = ''
                        try:
                            snippet = str(resp.text or '').strip().replace('\n', ' ')[:160]
                        except Exception:
                            snippet = ''
                        last_error = f'opencrawl_http_{status_code}:{snippet}' if snippet else f'opencrawl_http_{status_code}'
                        continue
                    data = resp.json() if resp.content else {}
                    last_error = ''
                    break
                except Exception as exc:
                    last_error = f'opencrawl_request_failed:{exc}'
                    continue
    except Exception as exc:
        return {'ok': False, 'error': f'opencrawl_request_failed:{exc}', 'items': []}

    if last_error:
        if 'All connection attempts failed' in str(last_error):
            return {
                'ok': False,
                'error': f'opencrawl_unreachable:All connection attempts failed (tried: {attempted_urls})',
                'items': [],
            }
        return {'ok': False, 'error': last_error, 'items': []}

    if isinstance(data, dict) and data.get('ok') is False:
        err = str(data.get('error') or 'opencrawl_failed')
        return {'ok': False, 'error': f'opencrawl_provider_error:{err}', 'items': []}

    raw_rows = []
    if isinstance(data, dict):
        for key in ('items', 'results', 'pages', 'data'):
            value = data.get(key)
            if isinstance(value, list):
                raw_rows = value
                break
    elif isinstance(data, list):
        raw_rows = data

    items: list[dict[str, Any]] = []
    seen: set[str] = set()
    for row in raw_rows:
        if not isinstance(row, dict):
            continue
        item = _normalize_item(row)
        if not item:
            continue
        quality = _candidate_quality_score(
            keyword=query,
            url=str(item.get('url') or ''),
            domain=str(item.get('domain') or ''),
            title=str(item.get('title') or ''),
        )
        if quality < 8:
            continue
        if item['url'] in seen:
            continue
        seen.add(item['url'])
        items.append(item)
        if len(items) >= max(1, min(int(max_candidates or 30), settings.max_opencrawl_candidates)):
            break

    return {
        'ok': True,
        'provider': 'opencrawl',
        'items': items,
        'fetched_at': datetime.utcnow().isoformat(),
    }


async def get_open_crawl_results(
    db: Session,
    *,
    keyword: str,
    country: str,
    language: str,
    project_id: int | None = None,
    ttl_hours: int = 24,
    max_candidates: int = 30,
    timeout: int = 20,
    api_url: str | None = None,
    api_key: str | None = None,
) -> dict[str, Any]:
    cache_key = build_crawl_cache_key(keyword, country=country, language=language)
    now = datetime.utcnow()
    row = db.execute(select(CrawlRun).where(CrawlRun.cache_key == cache_key)).scalar_one_or_none()
    stale_items = list((row.crawl_json or {}).get('items') or []) if row else []
    if row and row.expires_at and row.expires_at > now and stale_items:
        return {
            'ok': True,
            'from_cache': True,
            'cache_key': cache_key,
            'provider': row.provider,
            'items': list((row.crawl_json or {}).get('items') or []),
            'fetched_at': row.fetched_at.isoformat() if row.fetched_at else None,
        }

    live = await fetch_open_crawl_live(
        keyword=keyword,
        country=country,
        language=language,
        max_candidates=max_candidates,
        timeout=timeout,
        api_url=api_url,
        api_key=api_key,
    )
    if not live.get('ok'):
        # Automatic web fallback when OpenCrawl service is unreachable/misconfigured.
        ddg_fallback = await _fetch_duckduckgo_fallback(
            keyword=keyword,
            country=country,
            language=language,
            max_candidates=max_candidates,
            timeout=timeout,
        )
        web_fallback = ddg_fallback
        if not (web_fallback.get('ok') and list(web_fallback.get('items') or [])):
            web_fallback = await _fetch_bing_fallback(
                keyword=keyword,
                country=country,
                language=language,
                max_candidates=max_candidates,
                timeout=timeout,
            )
        if web_fallback.get('ok') and list(web_fallback.get('items') or []):
            fallback_items = list(web_fallback.get('items') or [])
            fallback_provider = str(web_fallback.get('provider') or 'web_fallback')
            payload = {
                'keyword': keyword,
                'country': country,
                'language': language,
                'items': fallback_items,
                'fetched_at': now.isoformat(),
                'fallback_reason': str(live.get('error') or 'opencrawl_failed'),
            }
            expires_at = now + timedelta(hours=max(1, int(ttl_hours)))
            if row is None:
                row = CrawlRun(
                    project_id=project_id,
                    cache_key=cache_key,
                    keyword=str(keyword or ''),
                    country=str(country or 'us'),
                    language=str(language or 'en'),
                    provider=fallback_provider,
                    crawl_json=payload,
                    fetched_at=now,
                    expires_at=expires_at,
                )
            else:
                row.project_id = project_id
                row.keyword = str(keyword or '')
                row.country = str(country or 'us')
                row.language = str(language or 'en')
                row.provider = fallback_provider
                row.crawl_json = payload
                row.fetched_at = now
                row.expires_at = expires_at
            db.add(row)
            db.commit()
            return {
                'ok': True,
                'from_cache': False,
                'cache_key': cache_key,
                'provider': fallback_provider,
                'items': fallback_items,
                'fetched_at': now.isoformat(),
                'warning': f"open_crawl_live_failed_used_web_fallback:{str(live.get('error') or 'opencrawl_failed')}",
            }
        if stale_items:
            return {
                'ok': True,
                'from_cache': True,
                'from_stale_cache': True,
                'cache_key': cache_key,
                'provider': row.provider if row else 'opencrawl',
                'items': stale_items,
                'fetched_at': row.fetched_at.isoformat() if row and row.fetched_at else None,
                'warning': f"open_crawl_live_failed_using_stale_cache:{str(live.get('error') or 'opencrawl_failed')}",
            }
        return {
            'ok': False,
            'from_cache': False,
            'cache_key': cache_key,
            'provider': 'opencrawl',
            'items': [],
            'error': str(live.get('error') or 'opencrawl_failed'),
        }

    payload = {
        'keyword': keyword,
        'country': country,
        'language': language,
        'items': list(live.get('items') or []),
        'fetched_at': now.isoformat(),
    }
    expires_at = now + timedelta(hours=max(1, int(ttl_hours)))
    if row is None:
        row = CrawlRun(
            project_id=project_id,
            cache_key=cache_key,
            keyword=str(keyword or ''),
            country=str(country or 'us'),
            language=str(language or 'en'),
            provider='opencrawl',
            crawl_json=payload,
            fetched_at=now,
            expires_at=expires_at,
        )
    else:
        row.project_id = project_id
        row.keyword = str(keyword or '')
        row.country = str(country or 'us')
        row.language = str(language or 'en')
        row.provider = 'opencrawl'
        row.crawl_json = payload
        row.fetched_at = now
        row.expires_at = expires_at
    db.add(row)
    db.commit()
    return {
        'ok': True,
        'from_cache': False,
        'cache_key': cache_key,
        'provider': 'opencrawl',
        'items': list(live.get('items') or []),
        'fetched_at': now.isoformat(),
    }
