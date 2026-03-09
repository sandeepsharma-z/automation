from __future__ import annotations

from typing import Any


def build_content_brief(
    *,
    keyword: str,
    title: str,
    topic_map: dict[str, Any],
    internal_link_plan: list[dict[str, Any]],
    desired_word_count: int,
) -> dict[str, Any]:
    intent_mix = dict(topic_map.get('intent_mix') or {})
    total_intent = max(1, sum(int(v or 0) for v in intent_mix.values()))
    normalized_intent_mix = {
        key: round((int(value or 0) / total_intent) * 100.0, 2) for key, value in intent_mix.items()
    }
    required_sections = list(topic_map.get('best_outline') or topic_map.get('union_headings') or [])[:16]
    differentiators = [
        'Include realistic implementation examples with context.',
        'Highlight mistakes and practical recovery actions.',
        'Use buyer-intent coverage: comparison, authenticity checks, usage, storage, and safety.',
        'Use specific evidence-backed phrasing and avoid generic filler.',
        'Do not use "Case Study" framing unless measurable data and methodology are explicitly present.',
        'Avoid competitor brand mentions; keep references neutral unless it is the project brand.',
    ]
    gap_candidates = [str(item) for item in (topic_map.get('gap_candidates') or []) if str(item).strip()]
    if gap_candidates:
        differentiators.append(f"Cover low-coverage competitor gaps: {', '.join(gap_candidates[:4])}.")
    cta_plan = {
        'primary_cta': f"Evaluate {keyword} options using transparent quality checks and practical buying criteria.",
        'secondary_cta': 'Discuss your context with a qualified professional before major diet or treatment changes.',
    }
    return {
        'keyword': keyword,
        'title': title,
        'target_intent_mix': normalized_intent_mix or {'informational': 100.0},
        'required_sections': required_sections,
        'differentiators': differentiators,
        'internal_link_plan': internal_link_plan[:8],
        'cta_plan': cta_plan,
        'word_count_target': int(desired_word_count),
        'source_count': int(len(topic_map.get('intent_by_url') or {})),
        'evidence_requirements': [
            'Cover competitor union headings with clearer structure.',
            'Include FAQ block derived from competitor questions.',
            'Include practical examples with buyer-oriented checks.',
            'Use soft health-claim language with one clear safety disclaimer.',
            'Block manufacturing/operations template jargon in FAQ answers.',
        ],
        'qa_targets': {
            'completeness': '>= 80',
            'readability': '>= 70',
            'practicality': '>= 75',
            'eeat': '>= 70',
        },
    }
