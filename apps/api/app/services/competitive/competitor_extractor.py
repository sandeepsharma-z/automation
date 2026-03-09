from __future__ import annotations

import re
from typing import Any
from urllib.parse import urlparse

import asyncio
import httpx
from bs4 import BeautifulSoup

from app.services.http_client import DEFAULT_TIMEOUT, request_with_retries


def extract_entities(text: str) -> list[str]:
    entities = re.findall(r'\b[A-Z][A-Za-z0-9\-]{2,}\b', str(text or ''))
    seen: set[str] = set()
    out: list[str] = []
    for item in entities:
        key = item.lower()
        if key in seen:
            continue
        seen.add(key)
        out.append(item)
    return out[:30]


async def fetch_html(url: str) -> str | None:
    if not str(url or '').startswith('http'):
        return None
    async with httpx.AsyncClient(timeout=DEFAULT_TIMEOUT, follow_redirects=True) as client:
        def _factory() -> httpx.Request:
            return client.build_request('GET', url, headers={'User-Agent': 'ContentOpsAI/1.0'})

        try:
            response = await request_with_retries(_factory, client)
            if int(response.status_code or 0) >= 400:
                return None
            return response.text
        except Exception:
            return None


def _extract_main_text(soup: BeautifulSoup) -> str:
    container = (
        soup.find('article')
        or soup.find('main')
        or soup.find('div', attrs={'id': re.compile(r'content|main', re.I)})
        or soup.body
        or soup
    )
    for node in container.find_all(['script', 'style', 'noscript', 'svg']):
        node.decompose()
    return container.get_text(' ', strip=True)


def _extract_faqs(soup: BeautifulSoup) -> list[str]:
    questions: list[str] = []
    for node in soup.find_all(['h2', 'h3', 'h4', 'p', 'li']):
        line = str(node.get_text(' ', strip=True) or '').strip()
        if '?' in line and 4 <= len(line) <= 200:
            questions.append(line)
    return list(dict.fromkeys(questions))[:20]


def _extract_publish_date(soup: BeautifulSoup) -> str:
    for node in soup.find_all(['time', 'meta']):
        if node.name == 'time':
            value = str(node.get('datetime') or node.get_text(' ', strip=True) or '').strip()
            if value:
                return value
        prop = str(node.get('property') or node.get('name') or '').lower()
        if prop in {'article:published_time', 'datepublished', 'date'}:
            value = str(node.get('content') or '').strip()
            if value:
                return value
    return ''


def extract_competitor_signals(url: str, html: str) -> dict[str, Any]:
    soup = BeautifulSoup(str(html or ''), 'html.parser')
    h1 = [node.get_text(' ', strip=True) for node in soup.find_all('h1') if node.get_text(' ', strip=True)]
    h2 = [node.get_text(' ', strip=True) for node in soup.find_all('h2') if node.get_text(' ', strip=True)]
    h3 = [node.get_text(' ', strip=True) for node in soup.find_all('h3') if node.get_text(' ', strip=True)]
    text = _extract_main_text(soup)
    entities = extract_entities(text)
    faqs = _extract_faqs(soup)

    images = len(soup.find_all('img'))
    tables = len(soup.find_all('table'))
    lists = len(soup.find_all(['ul', 'ol']))
    words = len(re.findall(r'\b\w+\b', text))
    author = bool(soup.find(attrs={'rel': 'author'}) or soup.find(class_=re.compile(r'author', re.I)))
    publish_date = _extract_publish_date(soup)
    references = len([a for a in soup.find_all('a', href=True) if str(a.get('href') or '').startswith('http')])
    return {
        'url': url,
        'domain': (urlparse(url).netloc or '').lower().replace('www.', ''),
        'headings': {'h1': h1[:5], 'h2': h2[:40], 'h3': h3[:60]},
        'entities': entities[:30],
        'faqs': faqs,
        'metrics': {
            'word_count_estimate': words,
            'media_count': images,
            'table_count': tables,
            'list_count': lists,
        },
        'trust_signals': {
            'has_author': author,
            'publish_date': publish_date,
            'references_count': references,
        },
        'plain_text': text[:20000],
    }


async def fetch_and_extract(url: str) -> dict[str, Any]:
    fetch_error_type = ''
    html = None
    try:
        async with httpx.AsyncClient(timeout=DEFAULT_TIMEOUT, follow_redirects=True) as client:
            def _factory() -> httpx.Request:
                return client.build_request('GET', url, headers={'User-Agent': 'ContentOpsAI/1.0'})

            response = await request_with_retries(_factory, client)
            status = int(response.status_code or 0)
            text = str(response.text or '')
            if status == 403:
                fetch_error_type = '403'
            elif 'captcha' in text.lower():
                fetch_error_type = 'captcha'
            elif 'robots' in text.lower() and status >= 400:
                fetch_error_type = 'robots'
            if status < 400:
                html = text
    except asyncio.TimeoutError:
        fetch_error_type = 'timeout'
    except Exception:
        fetch_error_type = fetch_error_type or 'timeout'

    if not html:
        return {
            'url': url,
            'ok': False,
            'error': 'fetch_failed',
            'status': 'blocked_or_unreachable',
            'fetch_error_type': fetch_error_type or 'timeout',
        }
    try:
        data = extract_competitor_signals(url, html)
        data['ok'] = True
        data['status'] = 'ok'
        data['fetch_error_type'] = ''
        data['html_snapshot'] = html[:120000]
        return data
    except Exception:
        return {
            'url': url,
            'ok': False,
            'error': 'parse_failed',
            'status': 'blocked_or_unreachable',
            'fetch_error_type': 'parse_failed',
        }
