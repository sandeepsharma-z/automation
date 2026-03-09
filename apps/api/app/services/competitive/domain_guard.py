from __future__ import annotations

import re
from typing import Any


DOMAIN_HINTS: dict[str, dict[str, list[str]]] = {
    'packaging': {
        'positive': ['bopp', 'packaging', 'laminated', 'polybag', 'film', 'print', 'gsm', 'lamination', 'bags'],
        'negative': ['procedure', 'discomfort', 'post-procedure', 'patient', 'recovery', 'surgery', 'clinic', 'tooth'],
    },
    'medical': {
        'positive': ['treatment', 'patient', 'procedure', 'doctor', 'clinic', 'recovery'],
        'negative': ['laminated', 'bopp', 'supplier', 'polybag', 'gsm'],
    },
}


def _normalize_tokens(text: str) -> set[str]:
    return set(re.findall(r'[a-z0-9\-]+', str(text or '').lower()))


def classify_domain_context(keyword: str, entities: list[str], extracted_text: str = '') -> dict[str, Any]:
    tokens = _normalize_tokens(keyword) | _normalize_tokens(' '.join(entities or [])) | _normalize_tokens(extracted_text)
    best_domain = 'general'
    best_score = -999
    mismatch_tokens: list[str] = []
    for domain, hints in DOMAIN_HINTS.items():
        pos = sum(1 for token in hints['positive'] if token in tokens)
        neg = sum(1 for token in hints['negative'] if token in tokens)
        score = (pos * 2) - neg
        if score > best_score:
            best_score = score
            best_domain = domain
            mismatch_tokens = [token for token in hints['negative'] if token in tokens]
    mismatch_score = max(0.0, min(100.0, 100.0 - (len(mismatch_tokens) * 18.0)))
    return {
        'domain': best_domain,
        'mismatch_tokens': mismatch_tokens,
        'domain_mismatch_score': round(mismatch_score, 2),
        'is_mismatch': mismatch_score < 70.0,
    }


def sanitize_domain_vocabulary(text: str, mismatch_tokens: list[str], target_domain: str) -> str:
    out = str(text or '')
    replacements = {
        'procedure': 'process',
        'post-procedure': 'post-implementation',
        'discomfort': 'operational risk',
        'patient': 'buyer',
        'recovery': 'stabilization',
        'clinic': 'facility',
        'surgery': 'production change',
    }
    for token in mismatch_tokens or []:
        repl = replacements.get(token, '')
        if not repl:
            continue
        out = re.sub(rf'\b{re.escape(token)}\b', repl, out, flags=re.IGNORECASE)
    return out
