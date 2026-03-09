from __future__ import annotations

import re
from typing import Any

from bs4 import BeautifulSoup


def _tokenize(text: str) -> list[str]:
    return re.findall(r'[a-z0-9]+', str(text or '').lower())


def _shingles(tokens: list[str], n: int) -> set[str]:
    if len(tokens) < n:
        return {' '.join(tokens)} if tokens else set()
    return {' '.join(tokens[i:i + n]) for i in range(0, len(tokens) - n + 1)}


def shingle_similarity(a: str, b: str, n: int = 5) -> float:
    tokens_a = _tokenize(a)
    tokens_b = _tokenize(b)
    set_a = _shingles(tokens_a, n)
    set_b = _shingles(tokens_b, n)
    if not set_a and not set_b:
        return 0.0
    inter = len(set_a.intersection(set_b))
    union = len(set_a.union(set_b)) or 1
    return inter / union


def max_competitor_similarity(html: str, competitor_texts: list[str], n: int = 5) -> float:
    plain = BeautifulSoup(str(html or ''), 'html.parser').get_text(' ', strip=True)
    best = 0.0
    for text in (competitor_texts or []):
        score = shingle_similarity(plain, str(text or ''), n=n)
        if score > best:
            best = score
    return round(best, 6)


def deterministic_rewrite_html(html: str, keyword: str) -> str:
    soup = BeautifulSoup(str(html or ''), 'html.parser')
    root = soup.find('article') or soup.body or soup
    headings = [h.get_text(' ', strip=True) for h in root.find_all('h2') if h.get_text(' ', strip=True)]
    if not headings:
        headings = [
            f'How to evaluate {keyword}',
            f'Common mistakes with {keyword}',
            f'Implementation checklist for {keyword}',
        ]
    blocks: list[str] = [
        f"<p>This guide gives an original, practical framework for <strong>{keyword}</strong> based on research synthesis, not copied text.</p>"
    ]
    for heading in headings[:10]:
        blocks.append(f"<h2>{heading}</h2>")
        blocks.append(
            f"<p>Use this section to make a better decision about {keyword}: define your objective, compare alternatives, and map execution steps.</p>"
        )
        blocks.append(
            "<ul>"
            "<li>Clarify constraints, budget, and timeline first.</li>"
            "<li>Compare options with measurable criteria.</li>"
            "<li>Document risks and mitigation actions.</li>"
            "<li>Track outcomes and adjust quickly.</li>"
            "</ul>"
        )
    blocks.append(
        f"<h2>What we improved vs competitors</h2><ul><li>Clearer decisions and checklists.</li>"
        f"<li>Action-oriented steps tailored to {keyword}.</li><li>Structured FAQ and next steps.</li></ul>"
    )
    return f"<article>{''.join(blocks)}</article>"


def enforce_originality(
    *,
    html: str,
    competitor_texts: list[str],
    primary_keyword: str,
    threshold: float = 0.18,
) -> dict[str, Any]:
    score = max_competitor_similarity(html, competitor_texts)
    if score <= float(threshold):
        return {'html': html, 'similarity': score, 'rewritten': False}
    rewritten_html = deterministic_rewrite_html(html, primary_keyword)
    rewritten_score = max_competitor_similarity(rewritten_html, competitor_texts)
    return {
        'html': rewritten_html,
        'similarity': rewritten_score,
        'rewritten': True,
        'initial_similarity': score,
    }
