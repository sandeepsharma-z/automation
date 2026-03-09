import json
import re
from collections import Counter
from typing import Any

from bs4 import BeautifulSoup

TEMPLATE_PHRASES = [
    'in conclusion',
    'as we have seen',
    "in today's fast-paced world",
]

STRICTNESS_RULES = {
    'low': {'min_words': 160, 'max_sentence_words': 38, 'link_density_words': 320},
    'med': {'min_words': 220, 'max_sentence_words': 32, 'link_density_words': 285},
    'high': {'min_words': 300, 'max_sentence_words': 27, 'link_density_words': 250},
}


def _count_words(text: str) -> int:
    return len(re.findall(r'\b\w+\b', text))


def _sentences(text: str) -> list[str]:
    return [segment.strip() for segment in re.split(r'[.!?]+', text) if segment.strip()]


def _html_basics_ok(soup: BeautifulSoup) -> bool:
    has_heading = bool(soup.find(['h1', 'h2']))
    has_paragraph = bool(soup.find('p'))
    return has_heading and has_paragraph


def _schema_valid(schema_jsonld: Any) -> bool:
    if schema_jsonld in (None, '', {}):
        return True
    if isinstance(schema_jsonld, str):
        try:
            schema_jsonld = json.loads(schema_jsonld)
        except Exception:
            return False
    if not isinstance(schema_jsonld, dict):
        return False
    if '@context' not in schema_jsonld:
        return False
    return True


def run_draft_qa(
    html: str,
    internal_link_candidates: list[dict[str, Any]],
    strictness: str = 'med',
    internal_links_max: int | None = None,
    min_internal_links: int | None = None,
    primary_keyword: str | None = None,
    minimum_word_count: int | None = None,
    schema_jsonld: Any | None = None,
) -> dict[str, Any]:
    warnings: list[str] = []
    passed = True

    rules = STRICTNESS_RULES.get((strictness or 'med').lower(), STRICTNESS_RULES['med'])

    soup = BeautifulSoup(html or '', 'html.parser')
    text = soup.get_text(' ', strip=True)
    word_count = _count_words(text)

    anchors = [a.get_text(' ', strip=True).strip().lower() for a in soup.find_all('a') if a.get_text(' ', strip=True)]
    anchor_counts = Counter(anchors)
    duplicate_anchors = [anchor for anchor, count in anchor_counts.items() if count > 1]

    h2_headings = [node.get_text(' ', strip=True).strip().lower() for node in soup.find_all('h2') if node.get_text(' ', strip=True)]
    heading_counts = Counter(h2_headings)
    duplicate_headings = [heading for heading, count in heading_counts.items() if count > 1]

    available_links = len(internal_link_candidates)
    requested_min = int(min_internal_links or 1)
    required_links = min(max(0, requested_min), available_links) if available_links else 0
    if required_links and len(anchors) < required_links:
        passed = False
        warnings.append(f'Internal links below target: required {required_links}, found {len(anchors)}.')

    if duplicate_anchors:
        passed = False
        warnings.append(f'Anchor repetition detected: {duplicate_anchors[:5]}.')

    if duplicate_headings:
        passed = False
        warnings.append(f'Heading repetition detected: {duplicate_headings[:5]}.')

    density_cap = max(1, word_count // int(rules['link_density_words'])) if word_count else 1
    allowed_links = density_cap
    if internal_links_max:
        allowed_links = min(allowed_links, max(1, internal_links_max))
    if len(anchors) > allowed_links:
        passed = False
        warnings.append(f'Link density too high: found {len(anchors)} links for ~{word_count} words (max {allowed_links}).')

    if not _html_basics_ok(soup):
        passed = False
        warnings.append('HTML missing essential structure (heading + paragraph).')

    lowered = text.lower()
    repeated_templates = [phrase for phrase in TEMPLATE_PHRASES if lowered.count(phrase) > 1]
    if repeated_templates:
        passed = False
        warnings.append(f'Repeated template phrases found: {repeated_templates}.')

    sentences = _sentences(text)
    avg_sentence_words = 0.0
    if sentences:
        avg_sentence_words = sum(_count_words(sentence) for sentence in sentences) / len(sentences)

    min_words = max(int(rules['min_words']), int(minimum_word_count or 0))
    if word_count < min_words:
        passed = False
        warnings.append(f"Readability check failed: body too short ({word_count} words, min {min_words}).")

    if sentences and avg_sentence_words > float(rules['max_sentence_words']):
        passed = False
        warnings.append(
            'Readability check failed: '
            f"average sentence length too high ({avg_sentence_words:.1f} words, max {rules['max_sentence_words']})."
        )

    keyword_density = 0.0
    if primary_keyword:
        target = primary_keyword.lower().strip()
        if target and word_count:
            occurrences = lowered.count(target)
            keyword_density = occurrences / max(1, word_count)
            if keyword_density > 0.045:
                passed = False
                warnings.append(f'Keyword stuffing detected for "{primary_keyword}" ({keyword_density:.2%}).')

    schema_ok = _schema_valid(schema_jsonld)
    if not schema_ok:
        passed = False
        warnings.append('Schema JSON-LD is invalid.')

    return {
        'passed': passed,
        'warnings': warnings,
        'stats': {
            'word_count': word_count,
            'sentence_count': len(sentences),
            'avg_sentence_words': round(avg_sentence_words, 2),
            'internal_links_found': len(anchors),
            'internal_links_required': required_links,
            'duplicate_anchors': duplicate_anchors,
            'duplicate_headings': duplicate_headings,
            'max_links_allowed': allowed_links,
            'strictness': strictness,
            'keyword_density': round(keyword_density, 4),
            'schema_ok': schema_ok,
        },
    }
