from __future__ import annotations

import hashlib
from datetime import datetime

from sqlalchemy import case, select
from sqlalchemy.orm import Session

from app.models.entities import ContentPattern, Draft

DEFAULT_PATTERNS = [
    'how-to',
    'listicle',
    'comparison',
    'myth-busting',
    'case-study',
    'checklist',
    'framework',
    'interview',
]


def ensure_default_patterns(db: Session, project_id: int) -> None:
    existing = {row.pattern_key for row in db.execute(select(ContentPattern).where(ContentPattern.project_id == project_id)).scalars()}
    for pattern in DEFAULT_PATTERNS:
        if pattern not in existing:
            db.add(
                ContentPattern(
                    project_id=project_id,
                    pattern_key=pattern,
                    enabled=True,
                    outline_json=[],
                    cta_text=None,
                    faq_schema_enabled=False,
                    usage_count=0,
                )
            )
    db.commit()


def choose_pattern(db: Session, project_id: int) -> ContentPattern:
    ensure_default_patterns(db, project_id)
    null_first = case((ContentPattern.last_used_at.is_(None), 0), else_=1)
    patterns = list(
        db.execute(
            select(ContentPattern)
            .where(ContentPattern.project_id == project_id, ContentPattern.enabled.is_(True))
            .order_by(ContentPattern.usage_count.asc(), null_first.asc(), ContentPattern.last_used_at.asc())
        ).scalars()
    )
    if not patterns:
        raise RuntimeError('No enabled pattern available for project')
    return patterns[0]


def build_fingerprint(pattern_key: str, headings: list[str]) -> str:
    canonical = '|'.join([pattern_key, *[h.strip().lower() for h in headings]])
    return hashlib.sha256(canonical.encode()).hexdigest()


def fingerprint_is_recent(db: Session, project_id: int, fingerprint: str) -> bool:
    recent = db.execute(
        select(Draft.id).where(Draft.project_id == project_id, Draft.fingerprint == fingerprint).limit(1)
    ).first()
    return recent is not None


def mark_pattern_used(db: Session, pattern: ContentPattern) -> None:
    pattern.usage_count += 1
    pattern.last_used_at = datetime.utcnow()
    db.add(pattern)
