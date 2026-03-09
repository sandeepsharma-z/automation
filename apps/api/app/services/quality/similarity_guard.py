from __future__ import annotations

import re
from collections.abc import Iterable
from typing import Any

from bs4 import BeautifulSoup
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models.entities import Draft
from app.services.quality.diversity_engine import heading_fingerprint


def _tokenize(text: str) -> list[str]:
    return re.findall(r'[a-z0-9]+', (text or '').lower())


def _ngrams(tokens: list[str], n: int = 4) -> set[str]:
    if len(tokens) < n:
        return set(tokens)
    return {' '.join(tokens[index:index + n]) for index in range(len(tokens) - n + 1)}


def _jaccard(set_a: set[str], set_b: set[str]) -> float:
    if not set_a and not set_b:
        return 0.0
    intersection = len(set_a.intersection(set_b))
    union = len(set_a.union(set_b)) or 1
    return intersection / union


def _extract_h2(html: str) -> list[str]:
    soup = BeautifulSoup(html or '', 'html.parser')
    return [node.get_text(' ', strip=True) for node in soup.find_all('h2') if node.get_text(' ', strip=True)]


def similarity_score(
    html_a: str,
    html_b: str,
    headings_a: Iterable[str] | None = None,
    headings_b: Iterable[str] | None = None,
) -> float:
    tokens_a = _tokenize(BeautifulSoup(html_a or '', 'html.parser').get_text(' ', strip=True))
    tokens_b = _tokenize(BeautifulSoup(html_b or '', 'html.parser').get_text(' ', strip=True))
    ng_a = _ngrams(tokens_a, n=4)
    ng_b = _ngrams(tokens_b, n=4)
    text_similarity = _jaccard(ng_a, ng_b)

    head_a = list(headings_a or _extract_h2(html_a))
    head_b = list(headings_b or _extract_h2(html_b))
    fp_similarity = 1.0 if heading_fingerprint(head_a) == heading_fingerprint(head_b) and head_a else 0.0
    return round((text_similarity * 0.75) + (fp_similarity * 0.25), 6)


def compare_against_recent_drafts(
    db: Session,
    *,
    project_id: int,
    html: str,
    outline: list[str],
    exclude_draft_id: int | None = None,
    window_n: int = 25,
) -> tuple[float, list[dict[str, Any]]]:
    rows = db.execute(
        select(Draft)
        .where(Draft.project_id == project_id)
        .order_by(Draft.id.desc())
        .limit(max(1, window_n))
    ).scalars().all()

    results: list[dict[str, Any]] = []
    best = 0.0
    for draft in rows:
        if exclude_draft_id and draft.id == exclude_draft_id:
            continue
        score = similarity_score(html, draft.html, outline, draft.outline_json or [])
        if score > best:
            best = score
        results.append({'draft_id': draft.id, 'score': score, 'structure_type': draft.structure_type})
    results.sort(key=lambda item: item['score'], reverse=True)
    return best, results[:5]


def should_regenerate(score: float, threshold: float) -> bool:
    return score >= threshold
