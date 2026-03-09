from __future__ import annotations

import hashlib
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models.entities import Draft

STRUCTURE_TYPES = [
    'how-to',
    'listicle',
    'comparison',
    'myth-busting',
    'case-study',
    'checklist',
    'framework',
    'mistakes',
    'faq-first',
]

INTRO_STYLES = [
    'problem-agitate-solve',
    'data-led',
    'narrative-hook',
    'quick-answer-first',
    'contrarian-angle',
]

CTA_STYLES = [
    'soft-next-step',
    'tool-led',
    'consultative',
    'checklist-download',
]


def heading_fingerprint(headings: list[str]) -> str:
    canonical = '|'.join([heading.strip().lower() for heading in headings if heading.strip()])
    return hashlib.sha256(canonical.encode()).hexdigest()


def choose_next_structure(
    db: Session,
    project_id: int,
    *,
    window_n: int = 25,
    avoid: set[str] | None = None,
) -> tuple[str, str, str]:
    avoid = avoid or set()
    rows = db.execute(
        select(Draft.structure_type, Draft.intro_style, Draft.cta_style)
        .where(Draft.project_id == project_id)
        .order_by(Draft.id.desc())
        .limit(max(1, window_n))
    ).all()

    used_structures: dict[str, int] = {key: 0 for key in STRUCTURE_TYPES}
    recent_intro = None
    for row in rows:
        if row.structure_type in used_structures:
            used_structures[row.structure_type] += 1
        if recent_intro is None and row.intro_style:
            recent_intro = row.intro_style

    candidates = sorted(STRUCTURE_TYPES, key=lambda key: used_structures.get(key, 0))
    structure = next((item for item in candidates if item not in avoid), candidates[0])

    intro = next((item for item in INTRO_STYLES if item != recent_intro), INTRO_STYLES[0])
    cta = CTA_STYLES[len(rows) % len(CTA_STYLES)]
    return structure, intro, cta


def no_identical_h2_sequence(headings: list[str], previous_headings: list[list[str]]) -> bool:
    baseline = [item.strip().lower() for item in headings if item.strip()]
    for prev in previous_headings:
        candidate = [item.strip().lower() for item in prev if item.strip()]
        if candidate == baseline and baseline:
            return False
    return True


def build_draft_metadata(
    structure_type: str,
    outline: list[str],
    faqs: list[str],
    *,
    intro_style: str,
    cta_style: str,
) -> dict[str, Any]:
    return {
        'structure_type': structure_type,
        'outline_fingerprint': heading_fingerprint(outline),
        'intro_style': intro_style,
        'cta_style': cta_style,
        'faq_count': len(faqs),
    }
