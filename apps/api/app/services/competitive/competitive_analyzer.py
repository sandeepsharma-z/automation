from __future__ import annotations

from collections import Counter
from datetime import datetime, timezone
from typing import Any
from urllib.parse import urlparse


INTENT_CLUSTERS = {
    'informational_howto': ('how', 'guide', 'what is', 'steps', 'checklist', 'faq'),
    'commercial_supplier': ('supplier', 'manufacturer', 'vendor', 'company', 'buy', 'wholesale'),
    'standards_compliance': ('standard', 'compliance', 'iso', 'certification', 'astm', 'test method'),
    'pricing_cost': ('price', 'cost', 'quote', 'pricing', 'budget'),
}


def _tokenize(text: str) -> list[str]:
    return [token for token in ''.join(ch.lower() if ch.isalnum() else ' ' for ch in str(text or '')).split() if token]


def _cluster_for_text(text: str) -> str:
    hay = str(text or '').lower()
    for cluster, hints in INTENT_CLUSTERS.items():
        if any(hint in hay for hint in hints):
            return cluster
    return 'informational_howto'


def dedup_and_cluster_discovery(
    items: list[dict[str, Any]],
    *,
    max_urls_per_domain: int = 2,
    max_items: int = 30,
) -> dict[str, Any]:
    seen_by_domain: dict[str, int] = {}
    selected: list[dict[str, Any]] = []
    clusters: dict[str, list[dict[str, Any]]] = {key: [] for key in INTENT_CLUSTERS}
    dropped_for_domain_cap = 0

    for row in (items or []):
        url = str(row.get('url') or '').strip()
        domain = str(row.get('domain') or (urlparse(url).netloc or '')).lower().replace('www.', '')
        if not url or not domain:
            continue
        count = int(seen_by_domain.get(domain, 0))
        if count >= max(1, int(max_urls_per_domain)):
            dropped_for_domain_cap += 1
            continue
        seen_by_domain[domain] = count + 1
        text = f"{row.get('title') or ''} {row.get('snippet') or ''}"
        cluster = _cluster_for_text(text)
        item = dict(row)
        item['domain'] = domain
        item['intent_cluster'] = cluster
        selected.append(item)
        clusters[cluster].append(item)
        if len(selected) >= max(1, int(max_items)):
            break

    present = [key for key, rows in clusters.items() if rows]
    missing = [key for key, rows in clusters.items() if not rows]
    return {
        'items': selected,
        'clusters': clusters,
        'present_clusters': present,
        'missing_clusters': missing,
        'dropped_for_domain_cap': dropped_for_domain_cap,
    }


def _keyword_match_score(keyword: str, title: str, snippet: str, headings: list[str]) -> float:
    terms = set(_tokenize(keyword))
    if not terms:
        return 0.0
    bag = set(_tokenize(f"{title} {snippet} {' '.join(headings)}"))
    overlap = len(terms.intersection(bag))
    return min(30.0, float(overlap * 6))


def _content_depth_score(content_length_estimate: int | None) -> float:
    words = max(0, int(content_length_estimate or 0))
    if words <= 0:
        return 0.0
    return min(25.0, (words / 2400.0) * 25.0)


def _structural_score(h2_count: int, h3_count: int, faq_count: int) -> float:
    return min(20.0, (h2_count * 1.7) + (h3_count * 0.6) + (faq_count * 2.5))


def _freshness_score(discovered_at: str | None, last_seen_at: str | None, publish_date: str | None = None) -> float:
    candidates = [publish_date, last_seen_at, discovered_at]
    date_text = next((str(item) for item in candidates if str(item or '').strip()), '')
    if not date_text:
        return 5.0
    try:
        normalized = date_text.replace('Z', '+00:00')
        dt = datetime.fromisoformat(normalized)
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        age_days = max(0, (datetime.now(timezone.utc) - dt).days)
        if age_days <= 30:
            return 20.0
        if age_days <= 180:
            return 14.0
        if age_days <= 365:
            return 10.0
        return 4.0
    except Exception:
        return 5.0


def _inlink_score(inlink_count: int | None) -> float:
    links = max(0, int(inlink_count or 0))
    if links == 0:
        return 0.0
    return min(12.0, 2.0 + (links ** 0.5))


def compute_competitive_strength(
    *,
    keyword: str,
    title: str,
    snippet: str,
    headings: dict[str, Any] | None = None,
    metrics: dict[str, Any] | None = None,
    faqs: list[str] | None = None,
    discovered_at: str | None = None,
    last_seen_at: str | None = None,
    inlink_count: int | None = None,
    publish_date: str | None = None,
) -> dict[str, float]:
    heading_list = list((headings or {}).get('h2') or []) + list((headings or {}).get('h3') or [])
    keyword_match = _keyword_match_score(keyword, title, snippet, heading_list)
    depth = _content_depth_score(int((metrics or {}).get('word_count_estimate') or 0))
    h2_count = len(list((headings or {}).get('h2') or []))
    h3_count = len(list((headings or {}).get('h3') or []))
    faq_count = len(faqs or [])
    structural = _structural_score(h2_count, h3_count, faq_count)
    freshness = _freshness_score(discovered_at, last_seen_at, publish_date=publish_date)
    inlink = _inlink_score(inlink_count)
    total = (keyword_match * 2.0) + depth + structural + freshness + inlink
    return {
        'competitive_strength_score': round(total, 4),
        'keyword_match_score': round(keyword_match, 4),
        'content_depth_score': round(depth, 4),
        'structural_score': round(structural, 4),
        'freshness_score': round(freshness, 4),
        'inlink_score': round(inlink, 4),
    }


def analyze_competitors(extracts: list[dict[str, Any]], *, keyword: str, max_pages: int = 10) -> dict[str, Any]:
    union_headings: list[str] = []
    heading_counter: Counter[str] = Counter()
    entity_counter: Counter[str] = Counter()
    faq_counter: Counter[str] = Counter()
    page_scores: list[dict[str, Any]] = []

    for row in extracts:
        headings = row.get('headings') or {}
        h2 = [str(item).strip() for item in (headings.get('h2') or []) if str(item).strip()]
        h3 = [str(item).strip() for item in (headings.get('h3') or []) if str(item).strip()]
        all_headings = h2 + h3
        for heading in all_headings:
            key = heading.lower()
            heading_counter[key] += 1
            if heading not in union_headings:
                union_headings.append(heading)
        for entity in row.get('entities') or []:
            item = str(entity or '').strip()
            if item:
                entity_counter[item.lower()] += 1
        for question in row.get('faqs') or []:
            q = str(question or '').strip()
            if q:
                faq_counter[q.lower()] += 1

        publish_date = str((row.get('trust_signals') or {}).get('publish_date') or '')
        score = compute_competitive_strength(
            keyword=keyword,
            title=str(row.get('title') or ''),
            snippet=str(row.get('snippet') or ''),
            headings=headings,
            metrics=row.get('metrics') or {},
            faqs=list(row.get('faqs') or []),
            discovered_at=str(row.get('discovered_at') or ''),
            last_seen_at=str(row.get('last_seen_at') or ''),
            inlink_count=row.get('inlink_count'),
            publish_date=publish_date,
        )
        page_scores.append(
            {
                'url': str(row.get('url') or ''),
                'title': str(row.get('title') or ''),
                'domain': str(row.get('domain') or ''),
                'intent_cluster': _cluster_for_text(f"{row.get('title') or ''} {row.get('snippet') or ''}"),
                **score,
            }
        )

    top_entities = [entity for entity, _ in entity_counter.most_common(30)]
    top_questions = [question for question, _ in faq_counter.most_common(20)]
    low_coverage = [heading for heading in union_headings if heading_counter[heading.lower()] <= 1]
    best_outline = list(dict.fromkeys([*union_headings[:12], *low_coverage[:6]]))[:16]

    ranked_pages = sorted(
        page_scores,
        key=lambda item: float(item.get('competitive_strength_score') or 0.0),
        reverse=True,
    )[:max(1, int(max_pages))]

    union_set = set(h.lower() for h in union_headings)
    weak_coverage = [heading for heading in union_headings if heading_counter[heading.lower()] <= 2]
    return {
        'union_headings': union_headings[:80],
        'heading_frequency': dict(heading_counter),
        'entity_frequency': dict(entity_counter),
        'faq_frequency': dict(faq_counter),
        'top_entities': top_entities,
        'top_questions': top_questions,
        'gap_candidates': low_coverage[:20],
        'weak_coverage_areas': weak_coverage[:20],
        'missing_topics': low_coverage[:20],
        'best_outline': best_outline,
        'page_scores': ranked_pages,
        'topic_union_count': len(union_set),
    }
