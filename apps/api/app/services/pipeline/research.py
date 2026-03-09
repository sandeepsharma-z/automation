import re
from typing import Any
from urllib.parse import parse_qs, quote_plus, unquote, urlparse
import xml.etree.ElementTree as ET

import httpx
from bs4 import BeautifulSoup
from selectolax.parser import HTMLParser

from app.services.http_client import DEFAULT_TIMEOUT, request_with_retries


def extract_entities(text: str) -> list[str]:
    entities = re.findall(r'\b[A-Z][A-Za-z0-9\-]{2,}\b', text)
    deduped = []
    seen = set()
    for entity in entities:
        key = entity.lower()
        if key not in seen:
            seen.add(key)
            deduped.append(entity)
    return deduped[:20]


def extract_outline(html: str) -> dict[str, Any]:
    tree = HTMLParser(html)
    headings = [node.text(strip=True) for node in tree.css('h1, h2, h3') if node.text(strip=True)]
    soup = BeautifulSoup(html, 'html.parser')
    text = soup.get_text(' ', strip=True)

    faqs: list[str] = []
    for header in headings:
        lower = header.lower()
        if lower.startswith('faq') or lower.startswith('q:') or lower.startswith('question'):
            faqs.append(header)
        if '?' in header:
            faqs.append(header)

    return {
        'headings': headings[:24],
        'faqs': list(dict.fromkeys(faqs))[:10],
        'entities': extract_entities(text),
    }


async def fetch_html(url: str) -> str | None:
    if not url.startswith('http'):
        return None
    async with httpx.AsyncClient(timeout=DEFAULT_TIMEOUT, follow_redirects=True) as client:
        def _factory() -> httpx.Request:
            return client.build_request('GET', url, headers={'User-Agent': 'ContentOpsAI/1.0'})

        try:
            response = await request_with_retries(_factory, client)
            if response.status_code >= 400:
                return None
            return response.text
        except Exception:
            return None


def _normalize_external_url(value: str) -> str:
    raw = str(value or '').strip()
    if not raw.startswith('http'):
        return ''
    parsed = urlparse(raw)
    host = (parsed.netloc or '').lower()
    if host.startswith('www.'):
        host = host[4:]
    path = parsed.path or '/'
    normalized = f"{parsed.scheme}://{host}{path}"
    if parsed.query:
        normalized = f"{normalized}?{parsed.query}"
    return normalized.rstrip('/')


async def fetch_serp_urls(
    query: str,
    *,
    country: str = 'us',
    language: str = 'en',
    max_urls: int = 12,
) -> list[str]:
    q = str(query or '').strip()
    if not q:
        return []
    endpoint = f"https://duckduckgo.com/html/?q={quote_plus(q)}&kl={quote_plus(str(country or 'us'))}-{quote_plus(str(language or 'en'))}"
    async with httpx.AsyncClient(timeout=DEFAULT_TIMEOUT, follow_redirects=True) as client:
        def _factory() -> httpx.Request:
            return client.build_request('GET', endpoint, headers={'User-Agent': 'ContentOpsAI/1.0'})

        try:
            response = await request_with_retries(_factory, client)
            if response.status_code >= 400:
                return []
            soup = BeautifulSoup(response.text or '', 'html.parser')
            urls: list[str] = []
            for a in soup.select('a[href]'):
                href = str(a.get('href') or '').strip()
                if not href:
                    continue
                candidate = href
                if href.startswith('/l/?'):
                    params = parse_qs(urlparse(href).query)
                    uddg = (params.get('uddg') or [None])[0]
                    if uddg:
                        candidate = unquote(uddg)
                normalized = _normalize_external_url(candidate)
                if not normalized:
                    continue
                urls.append(normalized)
                if len(urls) >= max(4, max_urls * 3):
                    break
            deduped: list[str] = []
            seen: set[str] = set()
            for url in urls:
                if url in seen:
                    continue
                seen.add(url)
                deduped.append(url)
                if len(deduped) >= max_urls:
                    break
            return deduped
        except Exception:
            return []


async def filter_live_urls(urls: list[str], *, max_urls: int = 10) -> list[str]:
    queue: list[str] = []
    seen: set[str] = set()
    for item in (urls or []):
        normalized = _normalize_external_url(item)
        if not normalized or normalized in seen:
            continue
        seen.add(normalized)
        queue.append(normalized)

    live: list[str] = []
    async with httpx.AsyncClient(timeout=httpx.Timeout(12.0), follow_redirects=True) as client:
        for url in queue:
            try:
                def _factory() -> httpx.Request:
                    return client.build_request('GET', url, headers={'User-Agent': 'ContentOpsAI/1.0'})

                response = await request_with_retries(_factory, client)
                if int(response.status_code or 0) >= 400:
                    continue
                live.append(url)
                if len(live) >= max_urls:
                    break
            except Exception:
                continue
    return live


def domain_of(url: str) -> str:
    return urlparse(url).netloc


def pick_internal_links(library: list[dict], keyword: str, max_links: int = 5) -> list[dict]:
    scored = []
    keyword_parts = set(keyword.lower().split())
    for item in library:
        title = (item.get('title') or '').lower()
        overlap = len(keyword_parts.intersection(set(title.split())))
        scored.append((overlap, item))
    scored.sort(key=lambda row: row[0], reverse=True)

    links = []
    used_anchors = set()
    for _, item in scored:
        if len(links) >= max_links:
            break
        anchor = item.get('title', '')
        if not anchor or anchor.lower() in used_anchors:
            continue
        used_anchors.add(anchor.lower())
        links.append({'url': item.get('url'), 'anchor': anchor})
    return links


async def fetch_sitemap_urls(base_url: str, max_urls: int = 250) -> list[str]:
    root = (base_url or '').strip().rstrip('/')
    if not root.startswith('http'):
        return []

    sitemap_roots = [
        f'{root}/wp-sitemap.xml',
        f'{root}/sitemap_index.xml',
        f'{root}/sitemap.xml',
    ]
    collected: list[str] = []
    visited: set[str] = set()

    async with httpx.AsyncClient(timeout=DEFAULT_TIMEOUT, follow_redirects=True) as client:
        async def fetch_xml(url: str) -> str | None:
            try:
                def _factory() -> httpx.Request:
                    return client.build_request('GET', url, headers={'User-Agent': 'ContentOpsAI/1.0'})

                response = await request_with_retries(_factory, client)
                if response.status_code >= 400:
                    return None
                return response.text
            except Exception:
                return None

        pending = list(sitemap_roots)
        while pending and len(collected) < max_urls:
            current = pending.pop(0)
            if current in visited:
                continue
            visited.add(current)
            xml = await fetch_xml(current)
            if not xml:
                continue

            parsed = False
            try:
                root_xml = ET.fromstring(xml)
                parsed = True
                is_index = root_xml.tag.lower().endswith('sitemapindex')
                for node in root_xml.iter():
                    if not node.tag.lower().endswith('loc'):
                        continue
                    loc_text = (node.text or '').strip()
                    if not loc_text:
                        continue
                    if is_index:
                        if len(pending) + len(visited) > 120:
                            break
                        if loc_text not in visited:
                            pending.append(loc_text)
                    else:
                        if len(collected) >= max_urls:
                            break
                        if not loc_text.startswith('http'):
                            continue
                        if '/wp-json/' in loc_text or '/wp-admin/' in loc_text:
                            continue
                        collected.append(loc_text)
            except Exception:
                parsed = False

            if not parsed:
                loc_values = re.findall(r'<loc>(.*?)</loc>', xml, flags=re.IGNORECASE | re.DOTALL)
                is_index = '<sitemapindex' in xml.lower()
                for raw in loc_values:
                    loc_text = str(raw or '').strip()
                    if not loc_text:
                        continue
                    if is_index:
                        if len(pending) + len(visited) > 120:
                            break
                        if loc_text not in visited:
                            pending.append(loc_text)
                    else:
                        if len(collected) >= max_urls:
                            break
                        if not loc_text.startswith('http'):
                            continue
                        if '/wp-json/' in loc_text or '/wp-admin/' in loc_text:
                            continue
                        collected.append(loc_text)

    deduped: list[str] = []
    seen: set[str] = set()
    root_host = urlparse(root).netloc.lower()
    for url in collected:
        normalized = url.rstrip('/')
        host = urlparse(normalized).netloc.lower()
        if root_host and host and host != root_host:
            continue
        if normalized in seen:
            continue
        seen.add(normalized)
        deduped.append(normalized)
    return deduped[:max_urls]

