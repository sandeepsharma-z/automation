import asyncio
import hashlib
import json
import re
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from urllib.parse import parse_qs, quote_plus, unquote, urlparse

from bs4 import BeautifulSoup
import httpx
from sqlalchemy import delete, select
from sqlalchemy.orm import Session

from app.core.config import get_settings
from app.models.entities import (
    BlogBrief,
    BlogQa,
    CompetitorExtract,
    CompetitorPage,
    ContentPattern,
    ContentLibraryItem,
    Draft,
    DraftStatus,
    PipelineRun,
    PipelineStatus,
    Project,
    Topic,
    TopicStatus,
)
from app.services.competitive.brief_builder import build_content_brief
from app.services.competitive.competitive_analyzer import (
    analyze_competitors,
    compute_competitive_strength,
    dedup_and_cluster_discovery,
)
from app.services.competitive.competitor_extractor import fetch_and_extract
from app.services.competitive.domain_guard import classify_domain_context, sanitize_domain_vocabulary
from app.services.competitive.open_crawl_service import get_open_crawl_results
from app.services.competitive.originality_guard import enforce_originality
from app.services.events import log_pipeline_event
from app.services.pipeline.qa import run_draft_qa
from app.services.pipeline.research import (
    fetch_sitemap_urls,
    pick_internal_links,
)
from app.services.pipeline.variation import (
    build_fingerprint,
    choose_pattern,
    fingerprint_is_recent,
    mark_pattern_used,
)
from app.services.providers.openai_provider import OpenAIProvider
from app.services.rag.vectorstore import (
    build_internal_link_plan,
    ingest_library_items,
    retrieve_internal_link_candidates,
)
from app.services.settings import resolve_project_runtime_config
from app.services.storage.media_storage import guess_image_extension, save_binary_image


def slugify(text: str) -> str:
    slug = re.sub(r'[^a-zA-Z0-9\s-]', '', text).strip().lower()
    slug = re.sub(r'[\s_-]+', '-', slug)
    return slug[:80]


def estimate_cost(input_tokens: int, output_tokens: int) -> float:
    return round((input_tokens / 1_000_000) * 0.8 + (output_tokens / 1_000_000) * 3.2, 6)


def _parse_generation_json(raw_text: str) -> dict[str, Any]:
    text = (raw_text or '').strip()
    if not text:
        return {}

    candidates: list[str] = [text]
    fenced = re.search(r'```(?:json)?\s*(\{.*?\})\s*```', text, flags=re.DOTALL | re.IGNORECASE)
    if fenced:
        candidates.insert(0, fenced.group(1).strip())

    start = text.find('{')
    end = text.rfind('}')
    if start != -1 and end != -1 and end > start:
        candidates.append(text[start:end + 1].strip())

    for candidate in candidates:
        try:
            parsed = json.loads(candidate)
            if isinstance(parsed, dict):
                return parsed
        except Exception:
            continue
    return {}


def _word_count(text: str) -> int:
    return len(re.findall(r'\b\w+\b', text or ''))


def _count_words(text: str) -> int:
    return _word_count(text)


def _html_word_count(html: str) -> int:
    plain = re.sub(r'<[^>]+>', ' ', html or '')
    return _word_count(plain)


def _normalize_space(text: str) -> str:
    return re.sub(r'\s+', ' ', str(text or '')).strip()


def _split_into_h2_sections(html: str) -> list[dict[str, str]]:
    soup = BeautifulSoup(str(html or ''), 'html.parser')
    root = soup.find('article') or soup.body or soup
    sections: list[dict[str, str]] = []
    for heading in root.find_all('h2'):
        nodes: list[str] = []
        cursor = heading.find_next_sibling()
        while cursor is not None and getattr(cursor, 'name', '') != 'h2':
            nodes.append(str(cursor))
            cursor = cursor.find_next_sibling()
        sections.append(
            {
                'h2_title': str(heading.get_text(' ', strip=True) or '').strip(),
                'body_html': ''.join(nodes),
            }
        )
    return sections


def _join_h2_sections(html: str, sections: list[dict[str, str]]) -> str:
    soup = BeautifulSoup(str(html or ''), 'html.parser')
    root = soup.find('article') or soup.body or soup
    h2_nodes = list(root.find_all('h2'))
    for idx, heading in enumerate(h2_nodes):
        if idx >= len(sections):
            break
        cursor = heading.find_next_sibling()
        while cursor is not None and getattr(cursor, 'name', '') != 'h2':
            nxt = cursor.find_next_sibling()
            cursor.decompose()
            cursor = nxt
        fragment = BeautifulSoup(str(sections[idx].get('body_html') or ''), 'html.parser')
        insert_anchor = heading
        for node in list(fragment.contents):
            insert_anchor.insert_after(node)
            insert_anchor = node
    return str(soup)


def _rebalance_html_word_count(
    html: str,
    *,
    keyword: str,
    desired_words: int,
    min_ratio: float = 0.92,
    max_ratio: float = 1.12,
) -> str:
    content = str(html or '')
    target = max(700, int(desired_words or 1200))
    min_words = max(650, int(target * float(min_ratio or 0.92)))
    max_words = max(min_words + 120, int(target * float(max_ratio or 1.12)))
    current = _html_word_count(content)

    if current < min_words:
        sections = _split_into_h2_sections(content)
        expandable_indexes = [
            i
            for i, section in enumerate(sections)
            if _normalize_heading_label(section.get('h2_title', '')) not in {'conclusion', 'frequently asked questions', 'faq', 'faqs'}
        ]
        food_mode = _is_food_nutrition_keyword(keyword)
        if food_mode:
            expansion_chunks = [
                "Check authenticity markers such as process clarity, source transparency, and consistent aroma-texture cues.",
                "Compare bilona-style claims, label clarity, and real usage suitability before choosing a product.",
                "Verify batch consistency, ingredient disclosure, and storage guidance instead of relying on marketing lines.",
                "Use practical checks like aroma, granulation, and after-cooking behavior to judge quality.",
                "Match serving size and cooking method so day-to-day use remains balanced and sustainable.",
                "Compare value per serving and not just pack price to make a better long-term decision.",
                "Prefer products that clearly explain process steps such as curd to butter to slow-heating transitions when relevant.",
                "Keep freshness high by minimizing moisture exposure and following clean-container storage habits.",
            ]
        else:
            expansion_chunks = [
                "Map goals to measurable outcomes and prioritize clarity over broad claims.",
                "Compare alternatives on consistency, usability, and long-term fit for your context.",
                "Convert insights into a simple checklist that can be repeated without confusion.",
                "Document assumptions early so improvements stay practical and evidence-led.",
                "Use examples and decision criteria that help readers move from research to action.",
                "Align effort, cost, and expected outcomes before finalizing execution choices.",
                "Focus on specific signals that reduce ambiguity and improve decision confidence.",
                "Refine based on real usage feedback rather than one-time assumptions.",
            ]
        used: set[str] = set()
        inserted = 0
        cap = 32
        per_section_target = max(120, int((min_words * 0.90) / max(1, len(expandable_indexes))))
        chunk_idx = 0
        rr_pos = 0
        safety_cycles = 0
        while _html_word_count(content) < min_words and inserted < cap and expandable_indexes:
            progressed = False
            for _ in range(len(expandable_indexes)):
                sec_idx = expandable_indexes[rr_pos % len(expandable_indexes)]
                rr_pos += 1
                section = sections[sec_idx]
                s_words = _count_words(re.sub(r'<[^>]+>', ' ', str(section.get('body_html') or '')))
                if s_words >= per_section_target:
                    continue

                section_title = str(section.get('h2_title') or keyword).strip()
                sentence_tpl = str(expansion_chunks[chunk_idx % len(expansion_chunks)])
                chunk_idx += 1
                sentence = sentence_tpl.format(section=section_title, keyword=keyword).strip()
                norm = _normalize_space(sentence).lower()
                if not norm:
                    continue
                if norm in used:
                    sentence = f"{sentence} This keeps {keyword} guidance practical for real-world decisions."
                    norm = _normalize_space(sentence).lower()
                    if norm in used:
                        continue
                used.add(norm)
                section['body_html'] = f"{section.get('body_html', '')}<p>{sentence}</p>"
                sections[sec_idx] = section
                content = _join_h2_sections(content, sections)
                inserted += 1
                progressed = True
                break
            if not progressed:
                # If all sections hit per-section target but article still short, distribute one pass evenly.
                all_met = all(
                    _count_words(re.sub(r'<[^>]+>', ' ', str(sections[i].get('body_html') or ''))) >= per_section_target
                    for i in expandable_indexes
                )
                if not all_met:
                    break
                for sec_idx in expandable_indexes:
                    if _html_word_count(content) >= min_words or inserted >= cap:
                        break
                    section = sections[sec_idx]
                    section_title = str(section.get('h2_title') or keyword).strip()
                    sentence_tpl = str(expansion_chunks[chunk_idx % len(expansion_chunks)])
                    chunk_idx += 1
                    sentence = sentence_tpl.format(section=section_title, keyword=keyword).strip()
                    norm = _normalize_space(sentence).lower()
                    if not norm or norm in used:
                        continue
                    used.add(norm)
                    section['body_html'] = f"{section.get('body_html', '')}<p>{sentence}</p>"
                    sections[sec_idx] = section
                    content = _join_h2_sections(content, sections)
                    inserted += 1
                    progressed = True
                if not progressed:
                    break
            safety_cycles += 1
            if safety_cycles > (cap * 2):
                break
        if _html_word_count(content) < min_words:
            soup = BeautifulSoup(content, 'html.parser')
            root = soup.find('article') or soup.body or soup
            recap_p = soup.new_tag('p')
            recap_p.string = (
                f"Quick recap: apply this {keyword} guide with clear selection criteria, practical usage, and consistent quality checks."
            )
            placed = False
            for h2 in root.find_all('h2'):
                if _normalize_heading_label(h2.get_text(' ', strip=True)) in {'conclusion', 'frequently asked questions', 'faq', 'faqs'}:
                    h2.insert_before(recap_p)
                    placed = True
                    break
            if not placed:
                root.append(recap_p)
            content = str(soup)

    current = _html_word_count(content)
    if current > max_words:
        # Soft trim only obvious trailing filler paragraphs while preserving structure.
        soup = BeautifulSoup(content, 'html.parser')
        root = soup.find('article') or soup.body or soup
        removable_patterns = [
            r'(?i)\bdecision tip:\b',
            r'(?i)\boptimization loop:\b',
            r'(?i)\btrust signal:\b',
            r'(?i)\bimplementation note:\b',
            r'(?i)\bpractical context:\b',
            r'(?i)\buser-intent layer:\b',
        ]
        for para in list(root.find_all('p'))[::-1]:
            txt = _normalize_space(para.get_text(' ', strip=True))
            if not txt:
                para.decompose()
                continue
            if any(re.search(pattern, txt) for pattern in removable_patterns):
                para.decompose()
            if _html_word_count(str(soup)) <= max_words:
                break
        content = str(soup)

    return content


def _clean_title_text(value: str) -> str:
    title = str(value or '').strip()
    if not title:
        return ''
    title = re.sub(r'\s+', ' ', title).strip()
    title = re.sub(r'\s+for\s+my\s+seo\s+blog\b', '', title, flags=re.IGNORECASE).strip(' -|:')
    title = re.sub(r'\s+for\s+[^|:]{0,60}\bblog\b', '', title, flags=re.IGNORECASE).strip(' -|:')
    return title


def _sanitize_generated_phrase(value: str, primary_keyword: str) -> str:
    text = str(value or '').strip()
    if not text:
        return ''
    text = re.sub(r'single-generate-dedupe-keyword', primary_keyword, text, flags=re.IGNORECASE)
    text = re.sub(r'\bfor\s+my\s+seo\s+blog\b', '', text, flags=re.IGNORECASE)
    text = re.sub(r'\s+', ' ', text).strip(' -|:')
    return text


def _is_generic_title(value: str) -> bool:
    title = _clean_title_text(value).lower()
    if not title:
        return True
    generic_signals = [
        'complete guide',
        'ultimate guide',
        'for my seo blog',
        'step-by-step guide',
    ]
    return any(signal in title for signal in generic_signals)


def _build_title_fallback(
    primary_keyword: str,
    subtopics: list[str] | None,
    candidates: list[str] | None = None,
) -> str:
    cleaned_candidates = [_clean_title_text(item) for item in (candidates or []) if _clean_title_text(item)]
    for candidate in cleaned_candidates:
        if not _is_generic_title(candidate):
            return candidate

    keyword = str(primary_keyword or '').strip()
    subtopic = str((subtopics or [''])[0] or '').strip()
    current_year = datetime.utcnow().year
    if _is_food_nutrition_keyword(keyword):
        templates = [
            f"{keyword}: Benefits, Uses, Preparation, and Buying Guide ({current_year})",
            f"How to Choose Authentic {keyword}: Quality Checks, Storage, and Daily Use",
            f"{keyword} vs Regular Alternatives: Taste, Purity, and Practical Value",
            f"{keyword}: Common Buying Mistakes and Smarter Choices",
            f"Is {keyword} Right for Your Kitchen? A Practical Decision Guide",
        ]
    else:
        templates = [
            f"{keyword}: Process, Benefits, and Practical Outcomes ({current_year})",
            f"How {keyword} Works in Real Practice: Steps, Costs, and Results",
            f"{keyword} vs Traditional Options: What Actually Delivers Better Outcomes",
            f"{keyword}: Common Mistakes, Better Choices, and Next Steps",
            f"Is {keyword} Right for You? Decision Framework, Risks, and Next Steps",
        ]
    if subtopic:
        templates.append(f"{keyword}: {subtopic} and Other Practical Insights")
    return templates[abs(hash(keyword + subtopic)) % len(templates)]


def _resolve_draft_title(
    generated_title: str | None,
    primary_keyword: str,
    subtopics: list[str] | None,
    title_candidates: list[str] | None,
) -> str:
    cleaned_generated = _clean_title_text(generated_title or '')
    if cleaned_generated and not _is_generic_title(cleaned_generated):
        return cleaned_generated
    return _build_title_fallback(primary_keyword, subtopics, title_candidates)


def _is_food_nutrition_keyword(keyword: str) -> bool:
    tokens = {
        'ghee',
        'oil',
        'coconut',
        'bilona',
        'a2',
        'gir',
        'cow',
        'butter',
    }
    hay = str(keyword or '').lower()
    return any(token in hay for token in tokens)


def _is_beauty_skincare_keyword(keyword: str) -> bool:
    tokens = {
        'lip balm',
        'lips',
        'skincare',
        'skin care',
        'face serum',
        'serum',
        'moisturizer',
        'sunscreen',
        'spf',
        'beauty',
    }
    hay = str(keyword or '').lower()
    return any(token in hay for token in tokens)


def _classify_topic_niche(
    primary_keyword: str,
    secondary_keywords: list[str],
    title: str,
    evidence_text: str,
) -> dict[str, Any]:
    hay = ' '.join(
        [
            str(primary_keyword or '').lower(),
            ' '.join(str(v or '').lower() for v in (secondary_keywords or [])),
            str(title or '').lower(),
            str(evidence_text or '').lower(),
        ]
    )
    niche_rules: list[tuple[str, tuple[str, ...]]] = [
        ('food', ('ghee', 'oil', 'coconut', 'bilona', 'recipe', 'edible', 'nutrition', 'diet', 'cooking', 'butter')),
        ('health', ('immunity', 'cholesterol', 'inflammation', 'metabolism', 'heart', 'symptom', 'disease', 'medical', 'wellness')),
        ('finance', ('loan', 'credit', 'investment', 'tax', 'mutual fund', 'insurance', 'interest rate', 'bank', 'roi', 'portfolio')),
        ('legal', ('law', 'legal', 'compliance', 'contract', 'court', 'litigation', 'advocate', 'ip', 'gdpr', 'policy')),
        ('software', ('api', 'sdk', 'saas', 'platform', 'integration', 'deployment', 'architecture', 'database', 'cloud', 'workflow')),
        ('ecommerce', ('shopify', 'product page', 'checkout', 'cart', 'conversion', 'sku', 'inventory', 'merchant', 'storefront')),
        ('travel', ('itinerary', 'trip', 'visa', 'destination', 'hotel', 'flight', 'tour', 'travel')),
        ('education', ('course', 'syllabus', 'exam', 'curriculum', 'student', 'learning', 'certification', 'academy')),
    ]
    score_map: dict[str, int] = {k: 0 for k, _ in niche_rules}
    for niche, tokens in niche_rules:
        score_map[niche] = sum(1 for token in tokens if token in hay)
    niche = max(score_map.items(), key=lambda item: item[1])[0] if score_map else 'general'
    if score_map.get(niche, 0) <= 0:
        niche = 'general'

    ymyl = niche in {'health', 'finance', 'legal'}
    disallowed_phrases = [
        'process controls',
        'acceptance criteria',
        'pilot validation',
        'defect trends',
        'total landed cost',
        'reduces avoidable rework',
        'batch-level qa',
        'supplier proof points',
    ]
    if niche == 'food':
        faq_style = 'consumer'
    elif niche in {'software', 'ecommerce'}:
        faq_style = 'technical'
    elif niche in {'finance', 'legal'}:
        faq_style = 'b2b'
    elif niche == 'health':
        faq_style = 'medical_safe'
    else:
        faq_style = 'consumer'

    must_include_sections = _build_required_sections({'niche': niche, 'ymyl': ymyl, 'faq_style': faq_style}, primary_keyword)
    return {
        'niche': niche,
        'ymyl': ymyl,
        'disallowed_phrases': disallowed_phrases,
        'must_include_sections': must_include_sections,
        'faq_style': faq_style,
    }


def _build_required_sections(niche_payload: dict[str, Any], primary_keyword: str) -> list[str]:
    keyword = str(primary_keyword or '').strip()
    niche = str((niche_payload or {}).get('niche') or 'general').strip().lower()
    ymyl = bool((niche_payload or {}).get('ymyl'))

    base_sections = [
        f'What is {keyword}?',
        f'How {keyword} works',
        f'Key benefits of {keyword}',
        f'How to choose the right {keyword}',
        f'Common mistakes to avoid with {keyword}',
        f'{keyword}: practical usage guide',
        f'Cost and value comparison for {keyword}',
        'Frequently Asked Questions',
        'Conclusion',
    ]
    niche_sections: dict[str, list[str]] = {
        'food': [
            f'Authenticity and purity checks for {keyword}',
            f'{keyword} vs regular alternatives: key differences',
            f'Why {keyword} may cost more: quality and process factors',
            f'Storage and shelf-life guidance for {keyword}',
            f'How to use {keyword} in daily routine',
        ],
        'health': [
            f'Who may benefit from {keyword} and who should avoid it',
            f'Safety considerations and limitations for {keyword}',
            f'Evidence notes for {keyword} claims',
        ],
        'finance': [
            f'Risk factors and compliance notes for {keyword}',
            f'How to compare costs, fees, and long-term value for {keyword}',
            f'Limitations and caution points for {keyword}',
        ],
        'legal': [
            f'Compliance and risk checks for {keyword}',
            f'Limitations, scope, and legal caution for {keyword}',
            f'Evidence notes and interpretation boundaries for {keyword}',
        ],
        'software': [
            f'Implementation workflow for {keyword}',
            f'Integration checklist for {keyword}',
            f'Metrics to evaluate {keyword} performance',
        ],
        'ecommerce': [
            f'How {keyword} impacts conversion and user journey',
            f'Product/content optimization checklist for {keyword}',
            f'Metrics to monitor for {keyword}',
        ],
        'travel': [
            f'Planning checklist for {keyword}',
            f'Budget and booking strategy for {keyword}',
            f'Seasonality and practical travel tips for {keyword}',
        ],
        'education': [
            f'Learning pathway and roadmap for {keyword}',
            f'How to evaluate quality and outcomes for {keyword}',
            f'Common learner mistakes and fixes for {keyword}',
        ],
        'general': [
            f'Implementation checklist for {keyword}',
            f'How to evaluate quality and outcomes for {keyword}',
            f'Practical examples for {keyword}',
        ],
    }
    sections = base_sections[:]
    sections.extend(niche_sections.get(niche, niche_sections['general']))
    if ymyl:
        sections.extend(
            [
                f'Who should avoid or use caution with {keyword}',
                f'Sources and evidence notes for {keyword}',
            ]
        )

    deduped: list[str] = []
    seen: set[str] = set()
    for item in sections:
        val = str(item or '').strip()
        key = _normalize_heading_label(val)
        if not val or key in seen:
            continue
        seen.add(key)
        deduped.append(val)
    return deduped[:12]


def _tokenize_overlap_terms(value: str) -> set[str]:
    stop = {
        'what', 'how', 'why', 'when', 'where', 'which', 'is', 'are', 'the', 'for', 'and', 'with', 'from',
        'can', 'does', 'should', 'this', 'that', 'your', 'into', 'about', 'have', 'has', 'use',
    }
    return {
        token for token in re.findall(r'[a-z0-9]+', str(value or '').lower())
        if len(token) >= 3 and token not in stop
    }


_FAQ_MARKETPLACE_TOKENS = {'bigbasket', 'amazon', 'flipkart', 'myntra', 'jiomart', 'blinkit', 'zepto', 'meesho'}
_FAQ_LISTING_TOKENS = {
    'offer',
    'offers',
    'specification',
    'specifications',
    'price comparison',
    'compare price',
    'price list',
    'buy now',
    'add to cart',
    'mrp',
    'discount',
    'combo',
    'pack',
    'pack size',
    'litre',
    'liter',
    'ml',
    'kg',
    'gm',
    'gram',
    'grams',
}
_FAQ_PACK_SIZE_PATTERN = re.compile(
    r'(?i)\b('
    r'\d+(?:\.\d+)?\s?(ml|l|litre|liter|kg|g|gm|gram|grams|mg|oz|pack|packs|pcs|piece|pieces)'
    r'|\d+\s?x\s?\d+(?:\.\d+)?\s?(ml|l|litre|liter|kg|g|gm|gram|grams)'
    r')\b'
)
_FAQ_PRICE_PATTERN = re.compile(r'(?i)\b(rs\.?|inr|\$|₹)\s?\d+')
_EDITORIAL_ARTIFACT_PATTERN = re.compile(
    r'(?i)^\s*for\s+[^.?!]{3,200}\s*(,|:)?\s*(prioritize|map|compare|verify|use|align|focus|refine|optimize|structure)\b'
)


def _is_product_listing_style_faq_question(question: str, keyword: str = '') -> bool:
    cleaned = str(question or '').strip().rstrip('?').strip()
    if not cleaned:
        return True
    cleaned_lower = cleaned.lower()
    keyword_terms = _tokenize_overlap_terms(keyword)
    if any(token in cleaned_lower for token in _FAQ_LISTING_TOKENS):
        return True
    if _FAQ_PACK_SIZE_PATTERN.search(cleaned_lower):
        return True
    if _FAQ_PRICE_PATTERN.search(cleaned_lower):
        return True
    if cleaned.count('-') >= 2 and len(cleaned.split()) >= 6:
        return True
    if any(token in cleaned_lower for token in _FAQ_MARKETPLACE_TOKENS):
        keyword_has_marketplace = any(token in str(keyword or '').lower() for token in _FAQ_MARKETPLACE_TOKENS)
        if not keyword_has_marketplace:
            return True
    item_terms = _tokenize_overlap_terms(cleaned)
    if keyword_terms and not (item_terms & keyword_terms):
        return True
    titleish_words = sum(1 for w in cleaned.split() if w and w[0].isupper())
    if titleish_words >= 4 and _FAQ_PACK_SIZE_PATTERN.search(cleaned):
        return True
    return False


def _is_editorial_prompt_artifact(text: str) -> bool:
    cleaned = _normalize_space(str(text or ''))
    if not cleaned:
        return False
    if _EDITORIAL_ARTIFACT_PATTERN.match(cleaned):
        return True
    artifact_markers = (
        'this section should answer one concrete buyer question',
        'this section combines intent-matched depth',
    )
    lowered = cleaned.lower()
    return any(marker in lowered for marker in artifact_markers)


def _sanitize_placeholder_cta_text(value: str) -> str:
    text = str(value or '')
    if not text:
        return text
    text = re.sub(r'(?i)\btrusted seller(s)?\b', lambda m: 'official product pages' if m.group(1) else 'official product page', text)
    text = re.sub(r'(?i)\bofficial product page(\s*(and|&|,)\s*official product page)+\b', 'official product pages', text)
    return text


def _is_low_quality_anchor_text(value: str) -> bool:
    anchor = _normalize_space(str(value or '')).lower()
    if not anchor:
        return True
    bad_phrases = {
        'trusted seller',
        'trusted sellers',
        'click here',
        'read more',
        'learn more',
        'visit now',
        'official product page',
        'official product pages',
    }
    if anchor in bad_phrases:
        return True
    if len(anchor) < 4:
        return True
    return False


def _faq_has_offtopic_or_banned_answers(html: str, primary_keyword: str) -> bool:
    pairs = _extract_faq_pairs_from_html(html)
    if not pairs:
        return False
    banned_patterns = set(FAQ_CONTAMINATION_PHRASES) | set(BAN_PHRASES)
    keyword_terms = _tokenize_overlap_terms(primary_keyword)
    if len(pairs) != 5:
        return True

    for item in pairs:
        q = str(item.get('question') or '')
        a = str(item.get('answer') or '')
        if not a.strip():
            return True
        if _is_product_listing_style_faq_question(q, primary_keyword):
            return True
        lower_a = a.lower()
        if any(pattern in lower_a for pattern in banned_patterns):
            return True
        q_terms = _tokenize_overlap_terms(q)
        a_terms = _tokenize_overlap_terms(a)
        overlap = len(q_terms & a_terms)
        keyword_overlap = len(keyword_terms & a_terms)
        if overlap == 0 and keyword_overlap == 0:
            return True
    return False


def _has_repetitive_expansion(html: str) -> bool:
    text = BeautifulSoup(str(html or ''), 'html.parser').get_text(' ', strip=True)
    sentences = [_normalize_space(s).lower() for s in re.split(r'(?<=[.!?])\s+', text) if _normalize_space(s)]
    if not sentences:
        return False
    counts: dict[str, int] = {}
    for sent in sentences:
        counts[sent] = counts.get(sent, 0) + 1
        if counts[sent] > 2:
            return True
    markers = ('decision tip', 'implementation note', 'quality marker', 'user-intent layer', 'trust signal', 'optimization loop', 'practical context')
    marker_hits = sum(1 for sent in sentences if any(m in sent for m in markers))
    return marker_hits >= 6


def _remove_banned_phrase_paragraphs(html: str) -> str:
    soup = BeautifulSoup(str(html or ''), 'html.parser')
    root = soup.find('article') or soup.body or soup
    banned = [str(token).lower() for token in BAN_PHRASES]
    for node in list(root.find_all(['p', 'li', 'div'])):
        txt = _normalize_space(node.get_text(' ', strip=True)).lower()
        if not txt:
            continue
        if any(token in txt for token in banned):
            node.decompose()
    return str(soup)


def _cleanup_repetition(html: str) -> str:
    soup = BeautifulSoup(str(html or ''), 'html.parser')
    root = soup.find('article') or soup.body or soup
    paras = list(root.find_all('p'))
    seen_para: set[str] = set()
    marker_counts: dict[str, int] = {}
    marker_tokens = (
        'decision tip',
        'implementation note',
        'quality marker',
        'user-intent layer',
        'trust signal',
        'optimization loop',
        'practical context',
    )

    for para in paras:
        text = _normalize_space(para.get_text(' ', strip=True))
        key = re.sub(r'[^a-z0-9]+', ' ', text.lower()).strip()
        if not key:
            para.decompose()
            continue
        if key in seen_para:
            para.decompose()
            continue
        seen_para.add(key)
        marker = next((m for m in marker_tokens if m in key), '')
        if marker:
            marker_counts[marker] = marker_counts.get(marker, 0) + 1
            if marker_counts[marker] > 1:
                para.decompose()

    tail = list(root.find_all('p'))[::-1]
    tail_seen: set[str] = set()
    for para in tail:
        key = re.sub(r'[^a-z0-9]+', ' ', _normalize_space(para.get_text(' ', strip=True)).lower()).strip()
        if not key:
            para.decompose()
            continue
        if key in tail_seen:
            para.decompose()
        else:
            tail_seen.add(key)
    return str(soup)


async def _repair_faq_only_with_llm(
    provider: OpenAIProvider,
    *,
    topic_title: str,
    keyword: str,
    faq_questions: list[str],
    faq_style: str,
    disallowed_phrases: list[str],
) -> list[dict[str, str]]:
    if not provider.enabled:
        return _fallback_topic_faq_pairs(keyword, faq_questions)
    prompt = (
        'Write 5 consumer FAQs about the primary keyword and return strict JSON only with key "faqs" as exactly 5 items: '
        '[{"question":"...","answer":"..."}]. '
        f"Topic: {topic_title}. Primary keyword: {keyword}. Questions: {faq_questions[:5]}. FAQ style: {faq_style}. "
        f"Forbidden phrases: {list(dict.fromkeys([*(disallowed_phrases or []), *BAN_PHRASES]))}. "
        "Rules: answers must directly answer the question, 2-4 sentences each, no placeholders, no generic template text, "
        "no manufacturing/QA language, no banned phrases."
    )
    try:
        result = await provider.generate_text(prompt)
        parsed = _parse_generation_json(result.text or '')
        rows = parsed.get('faqs') if isinstance(parsed, dict) else []
        out: list[dict[str, str]] = []
        for row in (rows or [])[:5]:
            if not isinstance(row, dict):
                continue
            q = str(row.get('question') or '').strip()
            a = str(row.get('answer') or '').strip()
            if not q or not a:
                continue
            if _is_product_listing_style_faq_question(q, keyword):
                continue
            normalized_q = _normalize_faqs([q], keyword)
            if not normalized_q:
                continue
            q = normalized_q[0]
            if any(p in a.lower() for p in [str(x).lower() for x in (disallowed_phrases or [])]):
                continue
            s_count = len(re.findall(r'[.!?]+', a))
            if s_count < 2:
                a = f"{a.rstrip('.')} This keeps the answer practical and relevant."
            elif s_count > 4:
                a = ' '.join(re.split(r'(?<=[.!?])\s+', a)[:4]).strip()
            out.append({'question': q if q.endswith('?') else f'{q}?', 'answer': a})
        if len(out) >= 5:
            return out[:5]
    except Exception:
        pass
    return _fallback_topic_faq_pairs(keyword, faq_questions)[:5]


async def _repair_repetition_with_llm(
    provider: OpenAIProvider,
    *,
    html: str,
    topic_title: str,
    primary_keyword: str,
    desired_word_count: int,
) -> str:
    if not provider.enabled:
        return html
    prompt = (
        "Rewrite the following HTML article to remove repetitive sentences and tail spam while preserving topic relevance and structure. "
        f"Keep approximately {desired_word_count} words. Topic: {topic_title}. Primary keyword: {primary_keyword}. "
        "Do not add references/source appendices. Keep one FAQ section only. Return strict JSON with key html only.\n\n"
        f"HTML:\n{str(html or '')[:18000]}"
    )
    try:
        result = await provider.generate_text(prompt)
        parsed = _parse_generation_json(result.text or '')
        cleaned_html = str(parsed.get('html') or '').strip()
        return cleaned_html or html
    except Exception:
        return html


def _build_fallback_html(
    title: str,
    pattern_key: str,
    keyword: str,
    subtopics: list[str],
    links: list[dict],
    *,
    desired_word_count: int,
    secondary_keywords: list[str],
    faqs: list[str] | None = None,
    cta_text: str | None = None,
    niche_payload: dict[str, Any] | None = None,
) -> str:
    niche_name = str((niche_payload or {}).get('niche') or '').strip().lower()
    food_mode = niche_name == 'food' or _is_food_nutrition_keyword(keyword)
    headings = [item for item in (subtopics or []) if str(item).strip()][:8]
    if not headings:
        if food_mode:
            headings = [
                f'What makes {keyword} different',
                f'How authentic {keyword} is prepared',
                f'How to choose and store {keyword}',
                f'Best ways to use {keyword} daily',
            ]
        else:
            headings = [
                f'Core fundamentals of {keyword}',
                f'Planning framework for {keyword}',
                f'Execution checklist for {keyword}',
                f'Measuring results and optimization',
            ]

    intro = (
        f"<p>{title} addresses real user intent around <strong>{keyword}</strong> with practical, decision-ready guidance. "
        "This article is designed for readers who want clarity on options, quality signals, practical usage, and common mistakes.</p>"
        f"<p>Instead of broad filler, you will get section-by-section explanations, examples, checklists, and "
        "actionable next steps that are easier to apply in real scenarios.</p>"
        f"<p>The goal is simple: help readers evaluate <strong>{keyword}</strong> confidently and move toward the right next action.</p>"
    )

    sections: list[str] = []
    secondary = [kw for kw in (secondary_keywords or []) if kw]
    link_index = 0
    closing_cta = _sanitize_placeholder_cta_text(
        str(cta_text or f'Use this framework to choose the right {keyword} path with confidence.')
    ).strip()
    for idx, heading in enumerate(headings):
        sec_kw = secondary[idx % len(secondary)] if secondary else ''
        if food_mode:
            para_1 = (
                f"<p>{heading} becomes clearer when readers understand ingredient quality, preparation method, and freshness signals. "
                f"For {sec_kw or keyword}, this usually starts with sourcing transparency, aroma, color, and processing details.</p>"
            )
            para_2 = (
                f"<p>In practical terms, compare whether {sec_kw or keyword} is prepared traditionally (such as slow heating or bilona-style steps where relevant), "
                "whether labels are specific, and whether storage instructions are clearly provided by the seller.</p>"
            )
            para_3 = (
                f"<p>For everyday use, focus on authenticity checks, portion guidance, smoke-point suitability, and how well {sec_kw or keyword} fits your cooking style. "
                "This keeps decisions realistic and avoids hype-led purchases.</p>"
            )
            para_4 = (
                f"<p>When comparing options, do not rely on one claim alone. Evaluate batch consistency, ingredient clarity, packaging quality, "
                f"and long-term value per serving before finalizing any {sec_kw or keyword} purchase.</p>"
            )
            checklist = (
                f"<h3>Buyer checklist for {heading}</h3>"
                "<ul>"
                "<li>Check source details, process claims, and label transparency.</li>"
                "<li>Verify aroma, color, texture, and packaging integrity on arrival.</li>"
                "<li>Match usage with cooking method and serving size preferences.</li>"
                "<li>Store away from heat, moisture, and direct sunlight.</li>"
                "<li>Track freshness and reorder only after quality re-check.</li>"
                "</ul>"
            )
            evaluation_block = (
                f"<h3>How to evaluate {sec_kw or keyword} in real kitchen scenarios</h3>"
                "<ul>"
                "<li>Compare preparation method and ingredient/source disclosure.</li>"
                "<li>Check authenticity indicators and avoid vague marketing labels.</li>"
                "<li>Review whether the product suits daily cooking and budget.</li>"
                "<li>Prefer options with clear storage and usage instructions.</li>"
                "</ul>"
            )
            example = (
                f"<p><strong>Practical example:</strong> a buyer comparing {keyword} variants typically gets better results "
                "when they evaluate authenticity markers, process clarity, and freshness cues together rather than choosing by price alone.</p>"
                f"<p>Focus each subsection on one practical buyer decision around {sec_kw or keyword}, then close with one clear next step.</p>"
            )
        else:
            para_1 = (
                f"<p>{heading} should be understood from a reader-first point of view: what problem they are solving, "
                f"what options they have, and what trade-offs matter most before deciding on {sec_kw or keyword}.</p>"
            )
            para_2 = (
                f"<p>In practical terms, this means breaking the process into clear steps, setting realistic expectations, "
                "and explaining outcomes in plain language so readers can compare choices with confidence.</p>"
            )
            para_3 = (
                f"<p>For stronger SEO and usability, this section combines intent-matched depth, concise explanations, "
                f"and context around {sec_kw or keyword} that helps users move from research to action.</p>"
            )
            para_4 = (
                f"<p>When evaluating {sec_kw or keyword}, readers should compare quality signals, realistic outcomes, "
                "maintenance effort, and total cost of ownership together instead of selecting based on one factor only.</p>"
            )
            checklist = (
                f"<h3>Action checklist for {heading}</h3>"
                "<ul>"
                "<li>Define the primary outcome metric before execution.</li>"
                "<li>Create a repeatable process with clear ownership.</li>"
                "<li>Track performance signals and user feedback weekly.</li>"
                "<li>Refine implementation based on measurable intent match.</li>"
                "<li>Document practical do/don't guidance for first-time users.</li>"
                "</ul>"
            )
            evaluation_block = (
                f"<h3>How to evaluate {sec_kw or keyword} in real scenarios</h3>"
                "<ul>"
                "<li>Compare process transparency and expected outcomes.</li>"
                "<li>Check clarity of instructions before implementation.</li>"
                "<li>Review fit for daily routine, budget, and constraints.</li>"
                "<li>Prioritize options with consistent quality over hype.</li>"
                "</ul>"
            )
            example = (
                f"<p><strong>Practical example:</strong> a reader comparing {keyword} options gets better outcomes "
                "when they evaluate scope, execution clarity, and long-term maintenance together, not in isolation.</p>"
                f"<p>Each section should answer one specific decision question about {sec_kw or keyword} and include one actionable next step.</p>"
            )
        link_para = ''
        if link_index < len(links):
            link = links[link_index]
            link_index += 1
            link_anchor = _sanitize_placeholder_cta_text(str(link.get('anchor', 'related resource'))).strip()
            if _is_low_quality_anchor_text(link_anchor):
                link_anchor = 'related resource'
            cta_patterns = [
                "Read more: <a href=\"{url}\">{anchor}</a> for practical examples.",
                "Explore related details here: <a href=\"{url}\">{anchor}</a>.",
                "If you want a deeper breakdown, see <a href=\"{url}\">{anchor}</a>.",
                "For next-step guidance, check <a href=\"{url}\">{anchor}</a>.",
            ]
            section_link_cta = cta_patterns[idx % len(cta_patterns)].format(
                url=link.get('url', '#'),
                anchor=link_anchor,
            )
            link_para = (
                f"<p>{section_link_cta}</p>"
            )
        sections.append(
            f"<h2>{heading}</h2>{para_1}{para_2}{para_3}{para_4}{checklist}{evaluation_block}{example}{link_para}"
        )

    closing = (
        f"<h2>Conclusion</h2>"
        f"<p>The best results with {keyword} come from informed choices, realistic planning, and expert execution. "
        "Use this guide as a decision framework, then validate options based on your goals, timeline, and budget.</p>"
        f"<p>When readers understand what to expect and which red flags to avoid, conversion quality improves naturally "
        "because trust is built through clarity.</p>"
        f"<p><strong>{closing_cta}</strong></p>"
    )

    seed_faqs = _normalize_faqs(faqs, keyword)
    faq_block = _build_faq_html_block(seed_faqs, keyword)

    html = f"<article><h1>{title}</h1>{intro}{''.join(sections)}{closing}{faq_block}</article>"

    target_words = max(900, min(int(desired_word_count or 1200), 2600))
    soup = BeautifulSoup(html, 'html.parser')
    root = soup.find('article') or soup.body or soup
    section_heads = [
        h for h in root.find_all('h2')
        if _normalize_heading_label(h.get_text(' ', strip=True)) not in {'conclusion', 'frequently asked questions', 'faq', 'faqs'}
    ]
    used_expansions: set[str] = set()
    max_extra_insertions = 18
    inserted = 0

    if food_mode:
        expansion_templates = [
            "A simple authenticity check is to prefer products with clear sourcing and preparation details rather than broad marketing claims.",
            "Flavor, aroma, and texture consistency across batches are practical indicators of quality and careful processing.",
            "For daily cooking, use measured portions and align usage with your meal pattern instead of increasing quantity abruptly.",
            "Store in a clean, dry, airtight container and avoid heat or moisture exposure to maintain quality for longer.",
            "If you are comparing options online, prioritize transparent labels, ingredient clarity, and realistic reviews.",
            "When available, verify whether the process mentions slow heating, traditional churning, or cold-press context relevant to the product type.",
            "Check whether the product suits your cooking temperature and intended use before making repeat purchases.",
            "Comparing value per serving often gives a better buying decision than headline price alone.",
            "A balanced approach is to combine taste preference, quality transparency, and storage practicality in one decision.",
            "If you have dietary restrictions, start with smaller servings and track response before regular use.",
        ]
    else:
        expansion_templates = [
            "A practical decision framework starts with clear goals, measurable checkpoints, and realistic timelines.",
            "Compare options using clarity, consistency, and fit for your daily workflow rather than isolated claims.",
            "Document assumptions early so implementation remains repeatable as scope changes over time.",
            "Small iterative improvements usually outperform one-time overhauls for long-term consistency.",
            "Prioritize evidence-backed decisions and remove unnecessary complexity from execution steps.",
            "Review outcomes periodically and refine the approach based on actual user behavior.",
            "Use simple checklists to reduce avoidable mistakes during implementation.",
            "Align budget, effort, and expected outcomes before finalizing major decisions.",
        ]

    pool_index = 0
    while _html_word_count(str(soup)) < target_words and inserted < max_extra_insertions and section_heads:
        progressed = False
        for section_head in section_heads:
            if _html_word_count(str(soup)) >= target_words or inserted >= max_extra_insertions:
                break

            template = expansion_templates[pool_index % len(expansion_templates)]
            pool_index += 1
            sentence = template.replace('{keyword}', keyword).strip()
            norm_sentence = _normalize_space(sentence).lower()
            if not norm_sentence or norm_sentence in used_expansions:
                continue
            used_expansions.add(norm_sentence)

            target_node = section_head
            p_seen = 0
            scan = section_head.find_next_sibling()
            while scan is not None:
                if getattr(scan, 'name', '') == 'h2':
                    break
                if getattr(scan, 'name', '') == 'p':
                    p_seen += 1
                    target_node = scan
                    if p_seen >= 3:
                        break
                scan = scan.find_next_sibling()

            new_p = soup.new_tag('p')
            new_p.string = sentence
            target_node.insert_after(new_p)
            inserted += 1
            progressed = True
        if not progressed:
            break

    if _html_word_count(str(soup)) < target_words:
        recap = soup.new_tag('p')
        recap.string = (
            f"Quick recap: use this guide to compare {keyword} options with clear quality checks, practical usage guidance, "
            "and realistic decision criteria tailored to daily needs."
        )
        conclusion_head = None
        for h2 in root.find_all('h2'):
            if _normalize_heading_label(h2.get_text(' ', strip=True)) == 'conclusion':
                conclusion_head = h2
                break
        if conclusion_head:
            conclusion_head.insert_before(recap)
        else:
            root.append(recap)

    html = str(soup)

    return html


def _normalize_faqs(faqs: list[str] | None, keyword: str) -> list[str]:
    items = [str(item).strip() for item in (faqs or []) if str(item).strip()]
    normalized: list[str] = []
    seen_keys: set[str] = set()
    keyword_key = _normalize_heading_label(keyword)

    off_topic_faq_tokens = {
        'seo',
        'conversion',
        'conversions',
        'kpi',
        'kpis',
        'teams',
        'implementation',
        'implement',
        'workflow',
        'project',
        'roadmap',
    }
    for item in items:
        cleaned = re.sub(r'^\s*(faq:|q:)\s*', '', item.strip(), flags=re.IGNORECASE)
        cleaned = re.sub(r'^\s*[-*#\d\.\)\s]+', '', cleaned).strip()
        cleaned = cleaned.rstrip(' ?')
        if not cleaned:
            continue
        cleaned_lower = cleaned.lower()
        if any(token in cleaned_lower for token in off_topic_faq_tokens):
            continue
        if _is_product_listing_style_faq_question(cleaned, keyword):
            continue
        cleaned = f"{cleaned}?"

        dedupe_key = _normalize_heading_label(cleaned)
        if keyword_key:
            dedupe_key = dedupe_key.replace(keyword_key, '').strip()
        if not dedupe_key:
            dedupe_key = _normalize_heading_label(cleaned)
        if dedupe_key in seen_keys:
            continue
        seen_keys.add(dedupe_key)
        normalized.append(cleaned)

    if _is_food_nutrition_keyword(keyword):
        fallback_questions = [
            f'How can I identify pure {keyword}?',
            f'What is the difference between {keyword} and regular alternatives?',
            f'Why is {keyword} usually more expensive?',
            f'How much {keyword} can I use daily?',
            f'How should {keyword} be stored for freshness?',
        ]
    elif _is_beauty_skincare_keyword(keyword):
        fallback_questions = [
            f'How do I choose the right {keyword} for my skin type?',
            f'Which ingredients should I look for in {keyword}?',
            f'How often should I use {keyword}?',
            f'Can {keyword} be layered with other skincare products?',
            f'What mistakes should I avoid when using {keyword}?',
        ]
    else:
        fallback_questions = [
            f'What is {keyword} and why does it matter?',
            f'How does {keyword} work in practice?',
            f'What common mistakes should be avoided with {keyword}?',
            f'How should beginners evaluate options for {keyword}?',
            f'What are practical first steps for {keyword}?',
        ]
    for question in fallback_questions:
        if len(normalized) >= 5:
            break
        q = str(question or '').strip()
        if not q:
            continue
        key = _normalize_heading_label(q)
        if key in seen_keys:
            continue
        seen_keys.add(key)
        normalized.append(q if q.endswith('?') else f'{q}?')
    return list(dict.fromkeys(normalized))[:5]


def _build_topic_faq_answer(question: str, keyword: str, idx: int = 0) -> str:
    q = str(question or '').lower()
    kw = str(keyword or '').strip()
    food_mode = _is_food_nutrition_keyword(kw)
    beauty_mode = _is_beauty_skincare_keyword(kw)
    if any(token in q for token in ['identify', 'authentic', 'pure', 'genuine']):
        if food_mode:
            return (
                f"To identify pure {kw}, check whether the label clearly explains source, method, and ingredient details without vague claims. "
                "Also verify consistency in aroma, texture, and transparency of process notes before buying."
            )
        if beauty_mode:
            return (
                f"For {kw}, verify the ingredient list, avoid unnecessary fragrance if you are sensitive, and choose formulas suited to your skin condition. "
                "A patch test before regular use helps reduce irritation risk."
            )
        return (
            f"To evaluate {kw} authenticity, verify provider credibility, clear deliverables, and specific implementation details rather than broad claims. "
            "Review real examples, transparent scope, and practical constraints before choosing."
        )
    if any(token in q for token in ['vs', 'regular', 'difference', 'different']):
        if food_mode:
            return (
                f"{kw} is usually compared with regular alternatives by preparation method, flavor depth, and consistency. "
                "The practical difference is better process clarity and reliable quality signals, not just premium wording."
            )
        return (
            f"{kw} should be compared with alternatives using scope, time-to-value, and maintenance overhead instead of headline claims alone. "
            "The best choice is usually the one with clearer execution fit for your actual goals."
        )
    if any(token in q for token in ['expensive', 'price', 'cost']):
        if food_mode:
            return (
                f"{kw} may be priced higher when sourcing, preparation effort, and batch consistency checks are stronger. "
                "Compare value per serving and process transparency instead of only comparing pack price."
            )
        return (
            f"{kw} may cost more when onboarding support, customization depth, or reliability standards are stronger. "
            "Compare total value over your intended usage period, not only entry price."
        )
    if any(token in q for token in ['daily', 'use', 'consume', 'how to use']):
        if food_mode:
            return (
                f"Use {kw} in measured portions based on your daily cooking routine and overall diet balance. "
                "Start with small quantity, observe preference and tolerance, then adjust gradually."
            )
        if beauty_mode:
            return (
                f"Apply {kw} in a thin, even layer on clean skin or lips as needed through the day, especially when dryness is high. "
                "Consistency and gentle reapplication work better than overuse."
            )
        return (
            f"Start {kw} with a small rollout and clear usage guidelines so teams can adopt it without disruption. "
            "Track baseline outcomes first, then scale once workflow fit is validated."
        )
    if any(token in q for token in ['store', 'storage', 'shelf', 'fresh']):
        if food_mode:
            return (
                f"Store {kw} in a clean, dry, airtight container away from heat, moisture, and direct sunlight. "
                "This helps preserve aroma, texture, and overall quality over time."
            )
        if beauty_mode:
            return (
                f"Store {kw} in a cool, dry place away from direct sunlight and keep the cap tightly closed after use. "
                "This helps maintain texture and ingredient stability."
            )
        return (
            f"For {kw}, maintain a clean operational setup with documented ownership, review cadence, and update responsibility. "
            "Consistent governance helps keep quality stable over time."
        )
    if any(token in q for token in ['bilona', 'method', 'made', 'prepare']):
        if food_mode:
            return (
                "A traditional bilona-style flow generally follows curd, churning to butter, and then slow heating to obtain ghee. "
                f"When evaluating {kw}, prefer products that explain these steps clearly."
            )
        return (
            f"{kw} generally works best when rollout steps are staged: setup, pilot, review, and controlled scale-up. "
            "A clear process avoids mismatch between expectations and execution."
        )
    if any(token in q for token in ['why does it matter', 'important']):
        if food_mode:
            return (
                f"{kw} matters because preparation method and ingredient transparency strongly affect taste, usability, and buying confidence. "
                "It helps readers choose products based on quality signals instead of only packaging claims."
            )
        return (
            f"{kw} matters when it directly improves decision quality, efficiency, or consistency for your use case. "
            "Its value comes from practical outcomes, not just trend-driven adoption."
        )
    if any(token in q for token in ['how does', 'work in practice']):
        if food_mode:
            return (
                f"In practice, {kw} is judged by source clarity, process description, and daily-use suitability. "
                "Check how it behaves in cooking, its aroma consistency, and whether storage guidance is clearly provided."
            )
        return (
            f"In practice, {kw} works through clear setup, repeatable execution steps, and periodic review against outcomes. "
            "Focus on implementation discipline so results remain stable over time."
        )
    if any(token in q for token in ['mistake', 'avoid']):
        if food_mode:
            return (
                f"Common mistakes with {kw} include buying only on discount labels, ignoring process details, and skipping storage hygiene. "
                "Use ingredient clarity and consistency checks before repeat purchase."
            )
        if beauty_mode:
            return (
                f"Common mistakes with {kw} include choosing only by fragrance, skipping patch tests, and ignoring ingredient compatibility. "
                "Pick a formula that matches your skin needs and use it consistently."
            )
        return (
            f"Common mistakes with {kw} include choosing based only on marketing claims, skipping baseline checks, and scaling too fast. "
            "Use a short evaluation checklist and validate fit before long-term commitment."
        )
    if any(token in q for token in ['evaluate options', 'evaluate', 'choose']):
        if food_mode:
            return (
                f"When choosing {kw}, compare source transparency, preparation details, aroma profile, and value per serving. "
                "This gives a practical buying decision without over-relying on branding language."
            )
        if beauty_mode:
            return (
                f"When choosing {kw}, compare ingredient compatibility, texture preference, and hydration performance over a week of consistent use. "
                "Select formulas that match your skin sensitivity and climate needs."
            )
        return (
            f"When evaluating {kw} options, compare suitability for your goals, clarity of process, and support reliability. "
            "A practical side-by-side comparison usually gives better decisions than feature lists alone."
        )
    if any(token in q for token in ['first step', 'start']):
        if food_mode:
            return (
                f"Start with a small pack of {kw} from a transparent source and test it in your regular cooking use cases. "
                "If flavor, consistency, and handling remain stable, then scale to larger purchase sizes."
            )
        return (
            f"Start with a small, clearly defined use case for {kw} and track outcomes against a simple baseline. "
            "Once results are consistent, expand scope gradually with the same quality checks."
        )
    generic = [
        (
            f"When selecting {kw}, prioritize source/process transparency and label clarity over broad marketing lines. "
            "This keeps buying decisions practical and consistent."
        ),
        (
            f"For {kw}, compare aroma, texture consistency, and suitability for your cooking style before repeat purchase. "
            "Small practical checks usually prevent quality mismatch."
        ),
    ]
    if food_mode:
        return generic[idx % len(generic)]
    generic_non_food = [
        (
            f"Prioritize outcome fit, implementation clarity, and realistic maintenance effort when evaluating {kw}, rather than high-level promises. "
            "This improves long-term decision quality."
        ),
        (
            f"Use {kw} with clear objectives, documented ownership, and periodic review checkpoints. "
            "This keeps execution practical and measurable."
        ),
    ]
    return generic_non_food[idx % len(generic_non_food)]


FAQ_CONTAMINATION_PHRASES = (
    'acceptance criteria',
    'supplier proof points',
    'batch-level qa',
    'measurable tolerances',
    'quality drift',
    'reduces avoidable rework',
    'pilot validation',
    'defect trends',
    'process controls',
    'total landed cost',
    'deviations',
    'corrective actions',
)

BAN_PHRASES = (
    'acceptance criteria',
    'process controls',
    'pilot validation',
    'defect trends',
    'total landed cost',
    'treatment plan',
    'recovery expectations',
    'post-procedure',
    'maintenance together',
    'provider experience',
)

HEALTH_TOPIC_SIGNALS = (
    'oil',
    'ghee',
    'cholesterol',
    'heart',
    'immunity',
    'inflammation',
    'metabolism',
    'weight',
    'antiviral',
)

MEDICAL_DISCLAIMER_TEXT = (
    "This content is for informational purposes only and does not constitute medical advice. "
    "Consult a qualified healthcare professional before making dietary changes."
)


def _is_health_related_topic(*values: Any) -> bool:
    hay = ' '.join([str(v or '').lower() for v in values])
    return any(token in hay for token in HEALTH_TOPIC_SIGNALS)


def _soften_health_claims(html: str) -> str:
    text = str(html or '')
    replacements = [
        (r'(?i)\breduces?\s+inflammation\b', 'may help support a healthy inflammatory response'),
        (r'(?i)\bimproves?\s+heart\s+health\b', 'may help support heart health'),
        (r'(?i)\bantiviral\s+properties\b', 'traditionally believed to support immune resilience'),
        (r'(?i)\bsupports?\s+cardiovascular\s+health\b', 'may contribute to cardiovascular wellness'),
        (r'(?i)\bboosts?\b', 'may help support'),
        (r'(?i)\bprevents?\b', 'some evidence suggests may contribute to lowering risk of'),
        (r'(?i)\bcures?\b', 'traditionally believed to support'),
    ]
    for pattern, replacement in replacements:
        text = re.sub(pattern, replacement, text)
    return text


def _insert_disclaimer_before_faq(html: str, disclaimer: str) -> str:
    if not str(disclaimer or '').strip():
        return str(html or '')
    soup = BeautifulSoup(str(html or ''), 'html.parser')
    root = soup.find('article') or soup.body or soup
    current_text = root.get_text(' ', strip=True).lower()
    if disclaimer.lower() in current_text:
        return str(soup)

    disclaimer_para = soup.new_tag('p')
    disclaimer_para.string = disclaimer
    faq_heading = None
    for heading in root.find_all(['h2', 'h3']):
        if _is_faq_heading_label(heading.get_text(' ', strip=True)):
            faq_heading = heading
            break
    if faq_heading:
        faq_heading.insert_before(disclaimer_para)
    else:
        root.append(disclaimer_para)
    return str(soup)


def _contains_measurable_data(html: str) -> bool:
    text = re.sub(r'<[^>]+>', ' ', str(html or ''))
    patterns = [
        r'\b\d+(\.\d+)?\s*%',
        r'\bn\s*=\s*\d+\b',
        r'\b\d+(\.\d+)?\s*(mg|g|kg|ml|l)\b',
        r'\b\d+(\.\d+)?\s*(day|days|week|weeks|month|months|year|years)\b',
        r'\b\d+(\.\d+)?\s*(participants|patients|subjects|samples)\b',
    ]
    return any(re.search(pattern, text, flags=re.IGNORECASE) for pattern in patterns)


def _sanitize_misleading_case_study_title(title: str, topic_title: str, html: str) -> str:
    base = str(title or '').strip()
    if not re.search(r'(?i)\bcase\s+study\b', base):
        return base
    if _contains_measurable_data(html):
        return base
    clean_topic = str(topic_title or '').strip() or base
    return f"{clean_topic}: Benefits, Uses, Preparation, and Buying Guide"


def _extract_faq_pairs_from_html(html: str) -> list[dict[str, str]]:
    soup = BeautifulSoup(str(html or ''), 'html.parser')
    root = soup.find('article') or soup.body or soup
    pairs: list[dict[str, str]] = []
    faq_heading = None
    for heading in root.find_all(['h2', 'h3']):
        if _is_faq_heading_label(heading.get_text(' ', strip=True)):
            faq_heading = heading
            break
    if not faq_heading:
        return pairs

    for details in faq_heading.find_all_next('details'):
        summary = details.find('summary')
        q = str(summary.get_text(' ', strip=True) if summary else '').strip()
        a = str(' '.join([p.get_text(' ', strip=True) for p in details.find_all('p')]) or '').strip()
        if q and a:
            pairs.append({'question': q if q.endswith('?') else f'{q}?', 'answer': a})

    if pairs:
        return pairs[:6]

    node = faq_heading.find_next_sibling()
    while node is not None:
        if getattr(node, 'name', '') in {'h2'}:
            break
        if getattr(node, 'name', '') in {'h3', 'h4'}:
            q = str(node.get_text(' ', strip=True) or '').strip()
            answer_parts: list[str] = []
            scan = node.find_next_sibling()
            while scan is not None and getattr(scan, 'name', '') not in {'h2', 'h3', 'h4'}:
                if getattr(scan, 'name', '') in {'p', 'div', 'li'}:
                    txt = str(scan.get_text(' ', strip=True) or '').strip()
                    if txt:
                        answer_parts.append(txt)
                scan = scan.find_next_sibling()
            if q and answer_parts:
                pairs.append({'question': q if q.endswith('?') else f'{q}?', 'answer': ' '.join(answer_parts)})
        node = node.find_next_sibling()
    return pairs[:6]


def _faq_contains_contamination(html: str) -> bool:
    faq_pairs = _extract_faq_pairs_from_html(html)
    if not faq_pairs:
        return False
    hay = ' '.join([f"{item.get('question', '')} {item.get('answer', '')}" for item in faq_pairs]).lower()
    if any(phrase in hay for phrase in FAQ_CONTAMINATION_PHRASES):
        return True
    return any(_is_product_listing_style_faq_question(str(item.get('question') or '')) for item in faq_pairs)


def _remove_all_faq_blocks(html: str) -> str:
    soup = BeautifulSoup(str(html or ''), 'html.parser')
    root = soup.find('article') or soup.body or soup
    for heading in list(root.find_all(['h2', 'h3'])):
        if not _is_faq_heading_label(heading.get_text(' ', strip=True)):
            continue
        node = heading.find_next_sibling()
        heading.decompose()
        while node is not None:
            if getattr(node, 'name', '') in {'h2'}:
                break
            nxt = node.find_next_sibling()
            node.decompose()
            node = nxt
    for node in list(root.find_all('details')):
        node.decompose()
    return str(soup)


def _build_collapsible_faq_html_from_pairs(faq_pairs: list[dict[str, str]]) -> str:
    rows: list[str] = ['<h2>Frequently Asked Questions</h2>']
    for idx, item in enumerate((faq_pairs or [])[:6]):
        q = str(item.get('question') or '').strip()
        a = str(item.get('answer') or '').strip()
        if not q or not a:
            continue
        q = q if q.endswith('?') else f'{q}?'
        open_attr = ' open="open"' if idx == 0 else ''
        rows.append(
            (
                "<details style=\"margin:10px 0; border:1px solid rgba(29,79,164,0.24); border-radius:10px; "
                "background:#f8fbff; overflow:hidden;\""
                f"{open_attr}>"
                "<summary style=\"cursor:pointer; list-style:none; font-weight:700; color:#173f79; "
                "padding:11px 12px; background:rgba(206,224,255,0.35);\">"
                f"{q}</summary>"
                "<p style=\"padding:10px 12px 12px; margin:0; line-height:1.75;\">"
                f"{a}</p></details>"
            )
        )
    return ''.join(rows) if len(rows) > 1 else ''


def _fallback_topic_faq_pairs(keyword: str, faqs: list[str] | None) -> list[dict[str, str]]:
    questions = _normalize_faqs(faqs, keyword)
    pairs: list[dict[str, str]] = []
    for idx, question in enumerate(questions[:6]):
        q_clean = str(question or '').strip().rstrip('?')
        ans = _build_topic_faq_answer(q_clean, keyword, idx)
        pairs.append({'question': f'{q_clean}?', 'answer': ans})
    return pairs


async def _regenerate_topic_faq_pairs(
    provider: OpenAIProvider,
    *,
    topic_title: str,
    keyword: str,
    faqs: list[str] | None,
) -> list[dict[str, str]]:
    fallback = _fallback_topic_faq_pairs(keyword, faqs)
    if not getattr(provider, 'enabled', False):
        return fallback
    prompt = (
        "Generate strict JSON only with key faqs as a list of objects: "
        "[{\"question\":\"...\",\"answer\":\"...\"}]. "
        f"Topic: {topic_title}. Primary keyword: {keyword}. Questions seed: {_normalize_faqs(faqs, keyword)}. "
        "Rules: one FAQ section only, each answer must directly answer its question, each answer must be 2 to 4 sentences, "
        "no manufacturing or operations jargon, no generic process templates, no placeholders."
    )
    try:
        result = await provider.generate_text(prompt)
        parsed = _parse_generation_json(result.text or '')
        rows = parsed.get('faqs') if isinstance(parsed, dict) else []
        out: list[dict[str, str]] = []
        for row in (rows or []):
            if not isinstance(row, dict):
                continue
            q = str(row.get('question') or '').strip()
            a = str(row.get('answer') or '').strip()
            if not q or not a:
                continue
            if _is_product_listing_style_faq_question(q, keyword):
                continue
            normalized_q = _normalize_faqs([q], keyword)
            if not normalized_q:
                continue
            q = normalized_q[0]
            sentence_count = len(re.findall(r'[.!?]+', a))
            if sentence_count < 2:
                a = f"{a.rstrip('.')} This helps readers make practical and informed decisions."
            elif sentence_count > 4:
                sentences = re.split(r'(?<=[.!?])\s+', a)
                a = ' '.join(sentences[:4]).strip()
            out.append({'question': q if q.endswith('?') else f'{q}?', 'answer': a})
        return out[:6] if out else fallback
    except Exception:
        return fallback


def _brand_token_from_host(host: str) -> str:
    parts = [p for p in str(host or '').lower().split('.') if p and p != 'www']
    if not parts:
        return ''
    if len(parts) >= 3 and parts[-2] in {'co', 'com', 'org', 'net', 'in'}:
        token = parts[-3]
    elif len(parts) >= 2:
        token = parts[-2]
    else:
        token = parts[0]
    token = re.sub(r'[^a-z0-9]+', ' ', token).strip()
    return token


def _sanitize_external_brand_mentions(
    html: str,
    *,
    project_base_url: str,
    candidate_urls: list[str] | None = None,
) -> str:
    soup = BeautifulSoup(str(html or ''), 'html.parser')
    root = soup.find('article') or soup.body or soup
    allowed_host = (urlparse(str(project_base_url or '')).netloc or '').lower().replace('www.', '')
    allowed_token = _brand_token_from_host(allowed_host)
    blocked_tokens: set[str] = set()

    for raw_url in (candidate_urls or []):
        host = (urlparse(str(raw_url or '')).netloc or '').lower().replace('www.', '')
        if not host or host == allowed_host:
            continue
        token = _brand_token_from_host(host)
        if token and token != allowed_token and len(token) >= 4:
            blocked_tokens.add(token)

    for anchor in root.find_all('a'):
        href = str(anchor.get('href') or '').strip()
        host = (urlparse(href).netloc or '').lower().replace('www.', '')
        if host and allowed_host and host != allowed_host:
            anchor.string = 'official product page'

    if blocked_tokens:
        pattern = re.compile(r'(?i)\b(' + '|'.join(re.escape(token) for token in sorted(blocked_tokens, key=len, reverse=True)) + r')\b')
        for node in root.find_all(string=True):
            parent = getattr(node, 'parent', None)
            if parent is None or getattr(parent, 'name', '') in {'script', 'style', 'code', 'pre', 'a'}:
                continue
            raw_text = str(node)
            replaced = pattern.sub('official product page', raw_text)
            if replaced != raw_text:
                node.replace_with(replaced)
    return str(soup)


def _build_faq_html_block(faqs: list[str], keyword: str) -> str:
    rows: list[str] = []
    for idx, question in enumerate((faqs or [])[:5]):
        answer = _build_topic_faq_answer(question, keyword, idx)
        rows.append(
            f"<h3>{question}</h3>"
            f"<p>{answer}</p>"
        )
    if not rows:
        return ''
    return f"<h2>Frequently Asked Questions</h2>{''.join(rows)}"


def _build_collapsible_faq_html_block(faqs: list[str], keyword: str) -> str:
    items = _normalize_faqs(faqs, keyword)
    if not items:
        return ''
    rows: list[str] = ['<h2>Frequently Asked Questions</h2>']
    for idx, question in enumerate(items[:6]):
        open_attr = ' open="open"' if idx == 0 else ''
        answer = _build_topic_faq_answer(question, keyword, idx)
        rows.append(
            (
                "<details style=\"margin:10px 0; border:1px solid rgba(29,79,164,0.24); border-radius:10px; "
                "background:#f8fbff; overflow:hidden;\""
                f"{open_attr}>"
                "<summary style=\"cursor:pointer; list-style:none; font-weight:700; color:#173f79; "
                "padding:11px 12px; background:rgba(206,224,255,0.35);\">"
                f"{question}</summary>"
                "<p style=\"padding:10px 12px 12px; margin:0; line-height:1.75;\">"
                f"{answer}</p></details>"
            )
        )
    return ''.join(rows)


def _enforce_single_faq_block(html: str, faqs: list[str], keyword: str) -> str:
    soup = BeautifulSoup(str(html or ''), 'html.parser')
    root = soup.find('article') or soup.body or soup
    normalized_faq_items = _normalize_faqs(faqs, keyword)
    faq_question_keys = {
        _normalize_heading_label(re.sub(r'\?+$', '', q).strip())
        for q in normalized_faq_items
        if str(q or '').strip()
    }
    # Remove all existing FAQ sections/details to prevent duplicates.
    for heading in list(root.find_all(['h2', 'h3'])):
        if not _is_faq_heading_label(heading.get_text(' ', strip=True)):
            continue
        node = heading.find_next_sibling()
        heading.decompose()
        while node is not None:
            # Remove entire FAQ payload (question headings + answers) until next major section.
            if getattr(node, 'name', '') in {'h2'}:
                break
            nxt = node.find_next_sibling()
            node.decompose()
            node = nxt
    for node in list(root.find_all('details')):
        summary_text = _normalize_heading_label(node.find('summary').get_text(' ', strip=True) if node.find('summary') else '')
        if summary_text:
            node.decompose()

    # Remove plain FAQ question/answer blocks when they duplicate generated FAQ items.
    for heading in list(root.find_all(['h3', 'h4'])):
        raw_text = str(heading.get_text(' ', strip=True) or '').strip()
        heading_key = _normalize_heading_label(re.sub(r'\?+$', '', raw_text))
        if not heading_key or heading_key not in faq_question_keys:
            continue
        node = heading.find_next_sibling()
        heading.decompose()
        while node is not None:
            if getattr(node, 'name', '') in {'h2', 'h3', 'h4'}:
                break
            nxt = node.find_next_sibling()
            node.decompose()
            node = nxt

    # Safety: remove orphan trailing question-answer runs before accordion insertion.
    question_heads = [
        h for h in root.find_all(['h3', 'h4'])
        if str(h.get_text(' ', strip=True) or '').strip().endswith('?')
    ]
    if len(question_heads) >= 4:
        for heading in question_heads:
            node = heading.find_next_sibling()
            heading.decompose()
            while node is not None:
                if getattr(node, 'name', '') in {'h2', 'h3', 'h4'}:
                    break
                nxt = node.find_next_sibling()
                node.decompose()
                node = nxt

    # Remove FAQ markers emitted as plain paragraphs plus known low-value artifact lines.
    artifact_sentence = 'can be addressed effectively by aligning goals, execution steps, and measurable checkpoints.'
    for node in list(root.find_all(['p', 'div', 'li', 'strong'])):
        text_norm = _normalize_heading_label(node.get_text(' ', strip=True))
        raw = str(node.get_text(' ', strip=True) or '').strip().lower()
        if _is_faq_heading_label(text_norm):
            node.decompose()
            continue
        if 'key research signals' in raw or 'sources analyzed' in raw:
            node.decompose()
            continue
        if artifact_sentence in raw:
            node.decompose()

    faq_block = _build_collapsible_faq_html_block(normalized_faq_items, keyword)
    if not faq_block:
        return str(soup)
    fragment = BeautifulSoup(faq_block, 'html.parser')
    conclusion_anchor = None
    for heading in root.find_all('h2'):
        label = _normalize_heading_label(heading.get_text(' ', strip=True))
        if label in {'conclusion', 'final recommendations'}:
            conclusion_anchor = heading
            break
    if conclusion_anchor:
        conclusion_anchor.insert_before(fragment)
    else:
        root.append(fragment)
    return str(soup)


def _build_faq_schema(title: str, faqs: list[str]) -> dict[str, Any]:
    entities = []
    for question in faqs:
        entities.append(
            {
                '@type': 'Question',
                'name': question,
                'acceptedAnswer': {'@type': 'Answer', 'text': f'{title}: {question}'},
            }
        )
    return {
        '@context': 'https://schema.org',
        '@type': 'FAQPage',
        'mainEntity': entities,
    }


def _build_retrieval_query(topic: Topic, subtopics: list[str]) -> str:
    merged = [topic.title, topic.primary_keyword, *topic.secondary_keywords_json, *subtopics[:8]]
    return ' | '.join([token for token in merged if token])


def _append_before_article_end(html: str, block: str) -> str:
    content = html or ''
    idx = content.lower().rfind('</article>')
    if idx == -1:
        return f"{content}{block}"
    return f"{content[:idx]}{block}{content[idx:]}"


def _normalize_heading_label(text: str) -> str:
    return re.sub(r'[^a-z0-9]+', ' ', str(text or '').lower()).strip()


def _is_faq_heading_label(label: str) -> bool:
    value = _normalize_heading_label(label)
    if not value:
        return False
    return (
        value.startswith('frequently asked questions')
        or value.startswith('frequently asked question')
        or value == 'faq'
        or value == 'faqs'
        or value.startswith('faq ')
        or value.startswith('faqs ')
    )


def _stable_variant_index(seed: str, total: int) -> int:
    total_count = max(1, int(total or 1))
    raw = str(seed or 'default-seed').encode('utf-8', errors='ignore')
    digest = hashlib.sha256(raw).hexdigest()
    return int(digest[:8], 16) % total_count


def _style_string(style: dict[str, str]) -> str:
    return '; '.join([f'{k}: {v}' for k, v in style.items() if str(v or '').strip()])


def _apply_layout_variant(html: str, title: str, keyword: str, variant_seed: str) -> str:
    soup = BeautifulSoup(str(html or ''), 'html.parser')
    root = soup.find('article') or soup.body or soup

    # Keep layout pass-through only. Do not inject hero badges/TOC/counters/callouts.
    for node in list(root.select('.contentops-hero')):
        node.decompose()
    for node in list(root.find_all(['div', 'p', 'span'])):
        text = _normalize_heading_label(node.get_text(' ', strip=True))
        if text in {'decision ready', 'reader first', 'execution focused'}:
            node.decompose()
    for heading in root.find_all(['h2', 'h3']):
        label = _normalize_heading_label(heading.get_text(' ', strip=True))
        if label == 'in this guide':
            node = heading.find_next_sibling()
            heading.decompose()
            while node is not None:
                if getattr(node, 'name', '') in {'h2', 'h3'}:
                    break
                nxt = node.find_next_sibling()
                node.decompose()
                node = nxt
            continue
        if heading.find('span'):
            cleaned = re.sub(r'^\s*\d{1,2}\s*[\.\):-]?\s*', '', heading.get_text(' ', strip=True))
            heading.clear()
            heading.append(cleaned)
    return str(soup)


def _safe_parse_dt(value: Any) -> datetime | None:
    text = str(value or '').strip()
    if not text:
        return None
    try:
        return datetime.fromisoformat(text.replace('Z', '+00:00'))
    except Exception:
        return None


def _sanitize_generated_blog_html(html: str) -> str:
    soup = BeautifulSoup(str(html or ''), 'html.parser')
    root = soup.find('article') or soup.body or soup

    # Post title is rendered by platform/theme; keep body content without duplicate H1.
    for h1 in root.find_all('h1'):
        h1.decompose()

    # Remove AI-inserted featured-image sections from body.
    featured_labels = {'featured image', 'featured images'}
    for heading in list(root.find_all(['h2', 'h3'])):
        label = _normalize_heading_label(heading.get_text(' ', strip=True))
        if label not in featured_labels:
            continue
        node = heading.find_next_sibling()
        heading.decompose()
        while node is not None:
            if getattr(node, 'name', '') in {'h2', 'h3'}:
                break
            nxt = node.find_next_sibling()
            node.decompose()
            node = nxt

    # Keep only first FAQ section if model returns multiple FAQ headings.
    faq_headings = [
        heading
        for heading in root.find_all(['h2', 'h3'])
        if _is_faq_heading_label(heading.get_text(' ', strip=True))
    ]
    for extra_heading in faq_headings[1:]:
        node = extra_heading.find_next_sibling()
        extra_heading.decompose()
        while node is not None:
            # Remove full duplicate FAQ block including question headings.
            if getattr(node, 'name', '') in {'h2'}:
                break
            nxt = node.find_next_sibling()
            node.decompose()
            node = nxt

    # Remove guide-summary blocks and execution artifacts.
    for heading in list(root.find_all(['h2', 'h3'])):
        label = _normalize_heading_label(heading.get_text(' ', strip=True))
        if label == 'in this guide':
            node = heading.find_next_sibling()
            heading.decompose()
            while node is not None:
                if getattr(node, 'name', '') in {'h2', 'h3'}:
                    break
                nxt = node.find_next_sibling()
                node.decompose()
                node = nxt
            continue
        cleaned_heading = re.sub(r'^\s*\d{1,2}\s*[\.\):-]?\s*', '', heading.get_text(' ', strip=True)).strip()
        if cleaned_heading:
            heading.clear()
            heading.append(cleaned_heading)

    # Remove internal QA/debug appendices from final published content.
    strip_section_labels = {
        'sources analyzed',
        'what we improved vs analyzed pages',
        'key research signals',
        'research signals',
        'source urls',
        'sources',
        'references',
        'citations',
        'research links',
    }
    for heading in list(root.find_all(['h2', 'h3'])):
        label = _normalize_heading_label(heading.get_text(' ', strip=True))
        if label not in strip_section_labels:
            continue
        node = heading.find_next_sibling()
        heading.decompose()
        while node is not None:
            if getattr(node, 'name', '') in {'h2', 'h3'}:
                break
            nxt = node.find_next_sibling()
            node.decompose()
            node = nxt

    for para in list(root.find_all('p')):
        label = _normalize_heading_label(para.get_text(' ', strip=True))
        if (
            label.startswith('key research signals')
            or label.startswith('sources analyzed')
            or label.startswith('source urls')
            or label.startswith('sources ')
        ):
            para.decompose()
            continue
        txt = str(para.get_text(' ', strip=True) or '')
        if re.search(r'(?i)\bkey research signals\b', txt) or re.search(r'(?i)\bsources analyzed\b', txt):
            para.decompose()
            continue
        if len(re.findall(r'https?://\S+', txt, flags=re.IGNORECASE)) >= 2:
            para.decompose()
            continue
        lower = txt.lower()
        if (
            'action sprint:' in lower
            or '{{' in lower
            or '{%' in lower
            or 'decision-ready' in lower
            or 'reader-first' in lower
            or 'execution-focused' in lower
            or 'a reputable certified brand' in lower
        ):
            para.decompose()
            continue
        # Remove editorial artifact lines leaked from templates/instructions.
        if _is_editorial_prompt_artifact(txt):
            para.decompose()
            continue
        # Remove placeholder CTA phrases globally.
        txt2 = _sanitize_placeholder_cta_text(txt)
        if txt2 != txt:
            para.clear()
            para.append(txt2)

    for node in list(root.find_all(['div', 'span', 'li'])):
        txt = str(node.get_text(' ', strip=True) or '').lower()
        if (
            '{{' in txt
            or '{%' in txt
            or 'action sprint:' in txt
            or txt in {'decision-ready', 'reader-first', 'execution-focused'}
            or 'a reputable certified brand' in txt
        ):
            node.decompose()
            continue
        if _is_editorial_prompt_artifact(txt):
            node.decompose()
            continue
        if 'trusted seller' in txt:
            clean = _sanitize_placeholder_cta_text(str(node.get_text(' ', strip=True) or ''))
            node.clear()
            node.append(clean)

    # Remove raw URL-only list items often emitted as debug/source appendix.
    for li in list(root.find_all('li')):
        text = str(li.get_text(' ', strip=True) or '')
        if text.startswith('http://') or text.startswith('https://'):
            parent_label = _normalize_heading_label(
                (li.find_parent(['ul', 'ol']).find_previous(['h2', 'h3']).get_text(' ', strip=True))
                if li.find_parent(['ul', 'ol']) and li.find_parent(['ul', 'ol']).find_previous(['h2', 'h3'])
                else ''
            )
            if (
                'source' in parent_label
                or 'reference' in parent_label
                or 'citation' in parent_label
                or 'research' in parent_label
            ):
                li.decompose()
                continue
            # Also remove naked URL bullets in final article body.
            if len(text) < 220:
                li.decompose()

    # Remove non-pipeline image tags from model output. We keep only figures/images
    # inserted by the image pipeline to avoid random off-topic visuals.
    for img in list(root.find_all('img')):
        parent_figure = img.find_parent('figure')
        allowed = bool(parent_figure and 'contentops-generated-image' in (parent_figure.get('class') or []))
        if allowed:
            continue
        parent = img.parent
        img.decompose()
        if parent and getattr(parent, 'name', '') == 'p':
            if not parent.get_text(' ', strip=True) and not parent.find('a'):
                parent.decompose()

    cleaned_html = str(soup)
    cleaned_html = re.sub(r'\{\{[^}]+\}\}', '', cleaned_html)
    cleaned_html = re.sub(r'\{%[^%]+%\}', '', cleaned_html)
    cleaned_html = re.sub(
        r'(?is)<p[^>]*>\s*for\s+[^<]{3,220}\s*(,|:)?\s*(prioritize|map|compare|verify|use|align|focus|refine|optimize|structure)\b[^<]*</p>',
        '',
        cleaned_html,
    )
    cleaned_html = re.sub(
        r'(?is)\bfor\s+[^.?!<]{3,220}\s*(,|:)?\s*(prioritize|map|compare|verify|use|align|focus|refine|optimize|structure)\b[^.?!<]*[.?!]',
        ' ',
        cleaned_html,
    )
    cleaned_html = _sanitize_placeholder_cta_text(cleaned_html)
    return cleaned_html


def _convert_faq_to_collapsible(html: str) -> str:
    soup = BeautifulSoup(str(html or ''), 'html.parser')
    root = soup.find('article') or soup.body or soup
    faq_heading = None
    for heading in root.find_all(['h2', 'h3']):
        if _is_faq_heading_label(heading.get_text(' ', strip=True)):
            faq_heading = heading
            break
    if not faq_heading:
        return str(soup)

    faq_heading.name = 'h2'
    existing = str(faq_heading.get('style') or '').strip()
    faq_heading['style'] = (
        f"{existing}; margin-top:24px; padding:10px 12px; border-radius:10px; "
        "background:linear-gradient(120deg,#123d84,#2e6ed7); color:#fff; font-size:1.35rem;"
    ).strip('; ')

    cursor = faq_heading.find_next_sibling()
    faq_index = 0
    while cursor is not None:
        if getattr(cursor, 'name', '') in {'h2'}:
            break
        if getattr(cursor, 'name', '') not in {'h3', 'h4'}:
            cursor = cursor.find_next_sibling()
            continue

        question_node = cursor
        question = question_node.get_text(' ', strip=True)
        faq_index += 1
        next_node = question_node.find_next_sibling()

        details = soup.new_tag('details')
        details['style'] = (
            "margin:10px 0; border:1px solid rgba(29,79,164,0.24); border-radius:10px; "
            "background:#f8fbff; overflow:hidden;"
        )
        if faq_index == 1:
            details['open'] = 'open'

        summary = soup.new_tag('summary')
        summary['style'] = (
            "cursor:pointer; list-style:none; font-weight:700; color:#173f79; "
            "padding:11px 12px; background:rgba(206,224,255,0.35);"
        )
        summary.string = question
        details.append(summary)

        moved_any = False
        scan = next_node
        while scan is not None and getattr(scan, 'name', '') not in {'h2', 'h3', 'h4'}:
            nxt = scan.find_next_sibling()
            details.append(scan.extract())
            moved_any = True
            scan = nxt
        if not moved_any:
            answer = soup.new_tag('p')
            answer['style'] = 'padding:10px 12px 12px; margin:0; line-height:1.75;'
            answer.string = 'Use this answer as a practical decision checkpoint before execution.'
            details.append(answer)
        else:
            for p in details.find_all('p'):
                p_existing = str(p.get('style') or '').strip()
                p['style'] = f"{p_existing}; padding:10px 12px 12px; margin:0; line-height:1.75;".strip('; ')

        question_node.insert_before(details)
        question_node.decompose()
        cursor = scan

    return str(soup)


def _strip_known_artifacts(html: str) -> str:
    text = str(html or '')
    if not text:
        return text

    # Remove known trailing debug/analysis sections even when model emits them as plain text blocks.
    patterns = [
        r'(?is)<h[23][^>]*>\s*What We Improved vs Analyzed Pages\s*</h[23]>.*?(?=(<h[23][^>]*>|</article>|$))',
        r'(?is)<h[23][^>]*>\s*Sources Analyzed\s*</h[23]>.*?(?=(<h[23][^>]*>|</article>|$))',
        r'(?is)<p[^>]*>\s*Key research signals[^<]*</p>',
        r'(?is)<p[^>]*>\s*(What We Improved vs Analyzed Pages|Sources Analyzed)\s*</p>.*?(?=(<h[23][^>]*>|</article>|$))',
    ]
    cleaned = text
    for pattern in patterns:
        cleaned = re.sub(pattern, '', cleaned)

    # Remove repeated low-value FAQ lines that slipped through from old prompt behavior.
    cleaned = re.sub(
        r'(?is)<h3[^>]*>[^<]{3,200}\?</h3>\s*<p[^>]*>[^<]*can be addressed effectively by aligning goals, execution steps, and measurable checkpoints\.[^<]*</p>',
        '',
        cleaned,
    )
    cleaned = re.sub(
        r'(?is)can be addressed effectively by aligning goals, execution steps, and measurable checkpoints\.',
        '',
        cleaned,
    )
    # Remove repeated plain-text FAQ appendix blocks that start later in the content.
    faq_hits = list(re.finditer(r'(?is)\bfrequently asked questions\b', cleaned))
    if len(faq_hits) > 1:
        second = faq_hits[1].start()
        tail = cleaned[second:]
        cut = re.search(r'(?is)\b(conclusion|call to action)\b', tail)
        if cut:
            cleaned = cleaned[:second] + tail[cut.start():]
        else:
            end_article = re.search(r'(?is)</article>', tail)
            cleaned = cleaned[:second] + (tail[end_article.start():] if end_article else '')
    return cleaned


def _cleanup_fallback_tail_spam(html: str) -> str:
    soup = BeautifulSoup(str(html or ''), 'html.parser')
    root = soup.find('article') or soup.body or soup
    paras = list(root.find_all('p'))
    if not paras:
        return str(soup)

    # Remove repeated trailing paragraph duplicates (keep one).
    changed = True
    while changed:
        changed = False
        paras = list(root.find_all('p'))
        if len(paras) < 2:
            break
        last = _normalize_space(paras[-1].get_text(' ', strip=True)).lower()
        prev = _normalize_space(paras[-2].get_text(' ', strip=True)).lower()
        if last and prev and last == prev:
            paras[-1].decompose()
            changed = True

    marker_tokens = (
        'decision tip',
        'implementation note',
        'quality marker',
        'user-intent layer',
        'trust signal',
        'optimization loop',
        'practical context',
    )
    tail_window = list(root.find_all('p'))[-28:]
    marker_nodes = [
        p for p in tail_window
        if any(token in _normalize_space(p.get_text(' ', strip=True)).lower() for token in marker_tokens)
    ]
    if len(marker_nodes) >= 6:
        for node in marker_nodes[2:]:
            node.decompose()
    return str(soup)


def _dedupe_internal_link_urls(html: str, candidates: list[dict[str, Any]]) -> str:
    soup = BeautifulSoup(str(html or ''), 'html.parser')
    root = soup.find('article') or soup.body or soup
    candidate_urls = {
        str(row.get('url') or '').strip().rstrip('/')
        for row in (candidates or [])
        if str(row.get('url') or '').strip()
    }
    seen: set[str] = set()
    for anchor in root.find_all('a'):
        href = str(anchor.get('href') or '').strip().rstrip('/')
        if not href or href not in candidate_urls:
            continue
        if href in seen:
            anchor.unwrap()
            continue
        seen.add(href)
    return str(soup)


def _ensure_internal_links_placement(
    html: str,
    candidates: list[dict[str, Any]],
    *,
    min_links: int,
    max_links: int,
    primary_keyword: str = '',
) -> str:
    if not html or not candidates:
        return html

    soup = BeautifulSoup(str(html), 'html.parser')
    root = soup.find('article') or soup.body or soup
    stop_labels = {
        'frequently asked questions',
        'frequently asked question',
        'faq',
        'faqs',
        'faq section',
        'conclusion',
        'final recommendations',
    }

    insertion_blocks: list[dict[str, Any]] = []
    for idx, para in enumerate(root.find_all('p')):
        text = para.get_text(' ', strip=True)
        if len(text) < 55:
            continue
        if para.find_parent('details'):
            continue
        section_heading = para.find_previous(['h2', 'h3'])
        section_label = _normalize_heading_label(section_heading.get_text(' ', strip=True) if section_heading else '')
        if section_label in stop_labels:
            continue
        insertion_blocks.append(
            {
                'node': para,
                'text': text.lower(),
                'section': section_label,
                'index': idx,
            }
        )

    if not insertion_blocks:
        return str(soup)

    # Count and protect only links already used in main body. Existing links in FAQ/conclusion
    # should not block contextual placement in section paragraphs.
    body_existing_hrefs: set[str] = set()
    for block in insertion_blocks:
        for a in block['node'].find_all('a'):
            href = str(a.get('href') or '').strip().rstrip('/')
            if href:
                body_existing_hrefs.add(href)
    existing_hrefs = set(body_existing_hrefs)
    keyword_terms = {
        token
        for token in re.findall(r'[a-z0-9]+', str(primary_keyword or '').lower())
        if len(token) >= 3
    }

    plan: list[dict[str, str]] = []
    seen_urls: set[str] = set()
    for row in candidates:
        url = str(row.get('url') or '').strip()
        anchor = _sanitize_placeholder_cta_text(str(row.get('anchor') or '')).strip()
        if not url or not anchor:
            continue
        if _is_low_quality_anchor_text(anchor):
            continue
        if keyword_terms:
            hay = f"{anchor} {url}".lower()
            if not any(term in hay for term in keyword_terms):
                # keep candidate, but lower priority later for contextual placement.
                pass
        normalized = url.rstrip('/')
        if normalized in seen_urls:
            continue
        seen_urls.add(normalized)
        plan.append({'url': url, 'anchor': anchor})

    already_used = sum(1 for item in plan if item['url'].rstrip('/') in body_existing_hrefs)
    target_count = max(min_links, min(max_links, len(plan)))
    if already_used >= target_count:
        return str(soup)

    inserted = 0
    used_para_indexes: set[int] = set()
    used_sections: set[str] = set()
    templates = [
        " Learn more: ",
        " Related guide: ",
        " See also: ",
        " Practical reference: ",
    ]

    def _tokens(value: str) -> set[str]:
        return {
            token
            for token in re.findall(r'[a-z0-9]+', str(value or '').lower())
            if len(token) >= 3
        }

    for item in plan:
        normalized = item['url'].rstrip('/')
        if normalized in existing_hrefs:
            continue
        if already_used + inserted >= target_count:
            break

        anchor_tokens = _tokens(item.get('anchor') or '')
        best_block = None
        best_score = -10**9

        for block in insertion_blocks:
            block_idx = int(block['index'])
            if block_idx in used_para_indexes:
                continue
            score = 0
            section = str(block.get('section') or '')
            text = str(block.get('text') or '')
            relative_pos = block_idx / max(1, len(insertion_blocks))

            if section and anchor_tokens and any(token in section for token in anchor_tokens):
                score += 8
            if anchor_tokens:
                match_count = sum(1 for token in anchor_tokens if token in text)
                score += min(6, match_count * 2)
            if keyword_terms:
                score += min(4, sum(1 for token in keyword_terms if token in text))
            # Prefer mid-body distribution and avoid concentrating in last tail paragraphs.
            if relative_pos > 0.82:
                score -= 4
            elif 0.18 <= relative_pos <= 0.78:
                score += 2
            # Encourage section spread first.
            if section and section in used_sections:
                score -= 2

            # Spread links across body; avoid clustering into nearby paragraphs.
            if used_para_indexes:
                min_gap = min(abs(block_idx - used) for used in used_para_indexes)
                if min_gap <= 2:
                    score -= 5
                elif min_gap <= 4:
                    score -= 2

            if score > best_score:
                best_score = score
                best_block = block

        target_para = (best_block or insertion_blocks[inserted % len(insertion_blocks)])['node']
        chosen_block = (best_block or insertion_blocks[inserted % len(insertion_blocks)])
        used_para_indexes.add(int(chosen_block['index']))
        chosen_section = str(chosen_block.get('section') or '')
        if chosen_section:
            used_sections.add(chosen_section)

        target_para.append(soup.new_string(templates[inserted % len(templates)]))
        anchor = soup.new_tag('a', href=item['url'])
        anchor.string = item['anchor']
        target_para.append(anchor)
        target_para.append(soup.new_string("."))
        existing_hrefs.add(normalized)
        inserted += 1

    return str(soup)


def _extract_used_internal_links(html: str, candidates: list[dict[str, Any]]) -> list[dict[str, str]]:
    if not html:
        return []
    candidate_urls = {str(row.get('url', '')).rstrip('/'): row for row in candidates}
    links = re.findall(r'<a[^>]+href=["\']([^"\']+)["\'][^>]*>(.*?)</a>', html, flags=re.IGNORECASE | re.DOTALL)
    used: list[dict[str, str]] = []
    seen = set()
    for href, anchor in links:
        normalized = href.strip().rstrip('/')
        if normalized in candidate_urls and normalized not in seen:
            seen.add(normalized)
            clean_anchor = re.sub(r'<[^>]+>', '', anchor).strip()
            if clean_anchor:
                source = candidate_urls.get(normalized, {})
                used.append(
                    {
                        'url': href.strip(),
                        'anchor': clean_anchor,
                        'reason': source.get('reason') or 'Contextual relevance',
                        'section_hint': source.get('section_hint') or source.get('title') or '',
                    }
                )
    return used


def get_project_library_payload(db: Session, project_id: int) -> list[dict[str, Any]]:
    rows = db.execute(
        select(ContentLibraryItem).where(ContentLibraryItem.project_id == project_id)
    ).scalars().all()
    payload = []
    for row in rows:
        payload.append(
            {
                'id': row.id,
                'project_id': row.project_id,
                'type': row.type,
                'title': row.title,
                'url': row.url,
                'handle': row.handle,
                'tags_json': row.tags_json,
                'updated_at': (row.last_synced_at or datetime.now(timezone.utc)).isoformat(),
            }
        )
    return payload


def reindex_project_rag(db: Session, project_id: int, openai_api_key: str | None = None) -> dict[str, Any]:
    project = db.get(Project, project_id)
    if not project:
        raise RuntimeError('Project not found')

    runtime = resolve_project_runtime_config(db, project)
    openai_key = openai_api_key or runtime.get('openai_api_key')
    items = get_project_library_payload(db, project_id)
    result = ingest_library_items(project_id=project_id, items=items, openai_api_key=openai_key)

    settings_json = dict(project.settings_json or {})
    settings_json['rag_last_indexed_at'] = datetime.now(timezone.utc).isoformat()
    settings_json['rag_doc_count'] = int(result.get('doc_count', 0))
    project.settings_json = settings_json
    db.add(project)
    db.commit()
    return result


def _text_readability_score(text: str) -> float:
    words = re.findall(r'\b\w+\b', text or '')
    if not words:
        return 0.0
    sentences = [s for s in re.split(r'[.!?]+', text or '') if s.strip()]
    sentence_count = max(1, len(sentences))
    avg_sentence_len = len(words) / sentence_count
    long_words = sum(1 for word in words if len(word) >= 8)
    long_ratio = long_words / max(1, len(words))
    score = 100.0 - (avg_sentence_len * 1.7) - (long_ratio * 38.0)
    return max(0.0, min(100.0, round(score, 2)))


def _calc_competitive_scores(
    *,
    html: str,
    required_sections: list[str],
    source_count: int,
) -> dict[str, float]:
    text = BeautifulSoup(str(html or ''), 'html.parser').get_text(' ', strip=True)
    lowered = text.lower()
    covered = 0
    for heading in (required_sections or []):
        if str(heading or '').strip() and str(heading).lower() in lowered:
            covered += 1
    completeness = round((covered / max(1, len(required_sections or []))) * 100.0, 2)
    readability = _text_readability_score(text)

    practical_signals = ['checklist', 'step', 'example', 'decision', '<table', '<ul', '<ol']
    practicality_hits = sum(1 for token in practical_signals if token in str(html or '').lower())
    practicality = max(0.0, min(100.0, round(45.0 + practicality_hits * 8.5, 2)))

    eeat_signals = ['assumption', 'limitations', 'reference', 'sources used', 'realistic', 'expect']
    eeat_hits = sum(1 for token in eeat_signals if token in lowered)
    eeat = max(0.0, min(100.0, round(40.0 + eeat_hits * 9.0 + min(source_count, 10) * 2.0, 2)))
    overall = round((completeness * 0.35) + (readability * 0.2) + (practicality * 0.25) + (eeat * 0.2), 2)
    return {
        'completeness_score': completeness,
        'readability_score': readability,
        'practicality_score': practicality,
        'eeat_score': eeat,
        'overall_score': overall,
    }


async def stage_research(db: Session, run: PipelineRun, payload: dict[str, Any]) -> dict[str, Any]:
    run.stage = 'research'
    run.status = PipelineStatus.running
    run.started_at = run.started_at or datetime.utcnow()
    db.add(run)
    db.commit()

    topic = db.get(Topic, run.topic_id)
    project = db.get(Project, run.project_id)
    if not topic or not project:
        raise RuntimeError('Pipeline entities not found')

    topic.status = TopicStatus.running
    db.add(topic)
    db.commit()

    runtime = resolve_project_runtime_config(db, project)
    language = str(payload.get('language') or runtime.get('language', 'en')).lower()
    country = str(payload.get('country') or runtime.get('country', 'us')).lower()
    device = str(payload.get('device') or 'desktop').lower()
    settings = get_settings()
    max_competitor_pages = max(2, int(runtime.get('max_competitor_pages') or settings.max_competitor_pages or 10))
    max_extract_chars = max(2000, int(runtime.get('max_extract_chars') or settings.max_extract_chars or 40000))
    total_fetch_timeout = max(10, int(runtime.get('total_fetch_timeout') or settings.total_fetch_timeout or 60))
    max_opencrawl_candidates = max(
        5,
        int(runtime.get('max_opencrawl_candidates') or settings.max_opencrawl_candidates or 30),
    )
    opencrawl_timeout = max(5, int(runtime.get('opencrawl_timeout') or settings.opencrawl_timeout or 20))

    library_rows = db.execute(select(ContentLibraryItem).where(ContentLibraryItem.project_id == project.id)).scalars().all()
    library = [
        {
            'url': item.url,
            'title': item.title,
            'type': item.type,
            'tags_json': item.tags_json,
        }
        for item in library_rows
    ]
    sitemap_urls = await fetch_sitemap_urls(project.base_url, max_urls=220)
    sitemap_entries = [
        {
            'url': url,
            'title': url.rstrip('/').split('/')[-1].replace('-', ' ').strip() or url,
            'type': 'sitemap_url',
            'tags_json': [],
        }
        for url in sitemap_urls
    ]
    library_urls = {str(item.get('url') or '').rstrip('/') for item in library if item.get('url')}
    augmented_library = list(library)
    for entry in sitemap_entries:
        normalized = str(entry.get('url') or '').rstrip('/')
        if normalized and normalized not in library_urls:
            augmented_library.append(entry)
            library_urls.add(normalized)

    project_host = (urlparse(project.base_url or '').netloc or '').lower().replace('www.', '')
    project_host_labels = [x for x in project_host.split('.') if x]
    project_brand_token = project_host_labels[0] if project_host_labels else ''
    project_settings = project.settings_json or {}
    internal_hosts: set[str] = set()
    for row in augmented_library:
        candidate_url = str(row.get('url') or '').strip()
        if not candidate_url.startswith('http'):
            continue
        host = (urlparse(candidate_url).netloc or '').lower().replace('www.', '')
        if host:
            internal_hosts.add(host)
    if project_host:
        internal_hosts.add(project_host)
    for key in (
        'shopify_store_domain',
        'shopify_domain',
        'shopify_store_url',
        'shopify_url',
        'wordpress_site_url',
        'site_url',
    ):
        raw = str(project_settings.get(key) or '').strip()
        if not raw:
            continue
        normalized = raw if raw.startswith('http') else f'https://{raw}'
        host = (urlparse(normalized).netloc or '').lower().replace('www.', '')
        if host:
            internal_hosts.add(host)

    def _is_project_owned_host(host: str) -> bool:
        norm = str(host or '').lower().replace('www.', '').strip()
        if not norm:
            return False
        if norm in internal_hosts:
            return True
        if project_brand_token and project_brand_token in {part for part in norm.split('.') if part}:
            return True
        return False

    def _is_external(url: str) -> bool:
        host = (urlparse(url or '').netloc or '').lower().replace('www.', '')
        return bool(host) and not _is_project_owned_host(host)

    def _is_content_internal_url(url: str) -> bool:
        raw = str(url or '').strip()
        if not raw.startswith('http'):
            return False
        parsed = urlparse(raw)
        path = (parsed.path or '/').lower().rstrip('/') or '/'
        query = (parsed.query or '').lower()
        blocked_exact = {'/', '/cart', '/checkout', '/shop', '/my-account', '/account', '/sample-page', '/hello-world'}
        blocked_contains = ('/product/', '/tag/', '/author/', '/feed', '/wp-json', '/wp-admin', '/xmlrpc.php')
        if path in blocked_exact:
            return False
        if any(token in path for token in blocked_contains):
            return False
        if 'add-to-cart=' in query:
            return False
        return True

    def _is_page_like_internal_url(url: str, item_type: str | None = None) -> bool:
        raw = str(url or '').strip()
        if not _is_content_internal_url(raw):
            return False
        parsed = urlparse(raw)
        path = (parsed.path or '/').lower().rstrip('/')
        if path in {'', '/'}:
            return False
        kind = str(item_type or '').strip().lower()
        if kind in {'post', 'blog', 'article', 'news'}:
            return False
        blocked_path_tokens = ('/blog', '/blogs', '/post', '/posts', '/article', '/articles', '/news', '/case-study', '/category/')
        if any(token in path for token in blocked_path_tokens):
            return False
        if re.search(r'/20\d{2}/\d{1,2}/', path):
            return False
        return True

    def _is_blog_like_external_url(url: str, title: str = '') -> bool:
        raw = str(url or '').strip()
        if not raw or not _is_external(raw):
            return False
        parsed = urlparse(raw)
        domain = (parsed.netloc or '').lower().replace('www.', '')
        if not domain:
            return False
        blocked_domains = {
            'google.com',
            'bing.com',
            'duckduckgo.com',
            'youtube.com',
            'facebook.com',
            'instagram.com',
            'linkedin.com',
            'pinterest.com',
            'reddit.com',
            'wikipedia.org',
            'amazon.in',
            'amazon.com',
            'flipkart.com',
            'meesho.com',
            'jiomart.com',
            'blinkit.com',
            'zepto.com',
            'indiamart.com',
            'myshopify.com',
        }
        if domain in blocked_domains or any(domain.endswith(f'.{d}') for d in blocked_domains):
            return False
        path = (parsed.path or '/').lower()
        query = (parsed.query or '').lower()
        title_l = str(title or '').lower()
        hay = f"{path} {query} {title_l}"
        product_tokens = (
            '/product/',
            '/products/',
            '/shop/',
            '/cart',
            '/checkout',
            '/collections/',
            '/collection/',
            '/dp/',
            '/prn/',
            '/prd/',
            '/sku/',
            '/item/',
            '/p/',
            'variant=',
            'add-to-cart=',
            'price=',
        )
        if any(token in hay for token in product_tokens):
            return False
        blog_tokens = (
            '/blog/',
            '/blogs/',
            '/article/',
            '/articles/',
            '/news/',
            '/guide/',
            '/guides/',
            '/learn/',
            '/resources/',
            '/benefits/',
            '/health/',
        )
        if any(token in hay for token in blog_tokens):
            return True
        informational_tokens = (
            'benefits',
            'how to',
            'guide',
            'vs',
            'difference',
            'uses',
            'tips',
            'what is',
            'best ',
            'review',
        )
        return any(token in title_l for token in informational_tokens)

    def _decode_ddg_href(href: str) -> str:
        raw = str(href or '').strip()
        if not raw:
            return ''
        if raw.startswith('/l/?') or 'duckduckgo.com/l/?' in raw:
            try:
                parsed = urlparse(raw if raw.startswith('http') else f'https://duckduckgo.com{raw}')
                uddg = str((parse_qs(parsed.query or {}).get('uddg') or [''])[0] or '').strip()
                return unquote(uddg) if uddg else raw
            except Exception:
                return raw
        return raw

    async def _discover_external_competitors_fallback(keyword: str, max_items: int) -> list[dict[str, Any]]:
        key = str(keyword or '').strip()
        if not key:
            return []
        cap = max(1, int(max_items or 20))
        site_exclude = f" -site:{project_host}" if str(project_host or '').strip() else ''
        qlist = [
            f'"{key}" inurl:blog{site_exclude}',
            f'"{key}" "benefits" "guide"{site_exclude}',
        ]
        seen: set[str] = set()
        out: list[dict[str, Any]] = []

        async with httpx.AsyncClient(timeout=20.0, follow_redirects=True, trust_env=False) as client:
            for query in qlist:
                # Bing fallback
                try:
                    bing_url = (
                        f"https://www.bing.com/search?q={quote_plus(query)}&count=50&setlang=en-US&cc=IN&ensearch=1"
                    )
                    resp = await client.get(bing_url, headers={'User-Agent': 'ContentOpsAI/1.0'})
                    html = str(resp.text or '')
                    rows = re.findall(
                        r'<h2[^>]*>\s*<a[^>]+href=["\']([^"\']+)["\'][^>]*>(.*?)</a>\s*</h2>',
                        html,
                        flags=re.IGNORECASE | re.DOTALL,
                    )
                    for href, title_html in rows:
                        url = str(href or '').strip()
                        title = re.sub(r'<[^>]+>', ' ', str(title_html or ''))
                        title = re.sub(r'\s+', ' ', title).strip()
                        if not _is_blog_like_external_url(url, title):
                            continue
                        nurl = _normalize_external_url(url)
                        if not nurl or nurl in seen:
                            continue
                        seen.add(nurl)
                        out.append(
                            {
                                'url': nurl,
                                'domain': (urlparse(nurl).netloc or '').lower().replace('www.', ''),
                                'title': title,
                                'snippet': '',
                                'position': len(out) + 1,
                            }
                        )
                        if len(out) >= cap:
                            return out
                except Exception:
                    pass

                # DuckDuckGo fallback
                try:
                    ddg_url = f"https://html.duckduckgo.com/html/?q={quote_plus(query)}&kl=in-en"
                    resp = await client.get(ddg_url, headers={'User-Agent': 'ContentOpsAI/1.0'})
                    html = str(resp.text or '')
                    rows = re.findall(
                        r'<a[^>]+class=["\'][^"\']*result__a[^"\']*["\'][^>]+href=["\']([^"\']+)["\'][^>]*>(.*?)</a>',
                        html,
                        flags=re.IGNORECASE | re.DOTALL,
                    )
                    for href, title_html in rows:
                        decoded = _decode_ddg_href(str(href or ''))
                        title = re.sub(r'<[^>]+>', ' ', str(title_html or ''))
                        title = re.sub(r'\s+', ' ', title).strip()
                        if not _is_blog_like_external_url(decoded, title):
                            continue
                        nurl = _normalize_external_url(decoded)
                        if not nurl or nurl in seen:
                            continue
                        seen.add(nurl)
                        out.append(
                            {
                                'url': nurl,
                                'domain': (urlparse(nurl).netloc or '').lower().replace('www.', ''),
                                'title': title,
                                'snippet': '',
                                'position': len(out) + 1,
                            }
                        )
                        if len(out) >= cap:
                            return out
                except Exception:
                    pass
        return out

    log_pipeline_event(
        db,
        run.id,
        'info',
        'OpenCrawl discovery started',
        {'keyword': topic.primary_keyword, 'country': country, 'language': language, 'device': device},
    )
    crawl_result = await get_open_crawl_results(
        db,
        keyword=topic.primary_keyword,
        country=country,
        language=language,
        project_id=project.id,
        ttl_hours=24,
        max_candidates=max_opencrawl_candidates,
        timeout=opencrawl_timeout,
        api_url=str(runtime.get('opencrawl_api_url') or ''),
        api_key=str(runtime.get('opencrawl_api_key') or ''),
    )
    crawl_warning = str(crawl_result.get('warning') or '').strip()
    if crawl_warning:
        log_pipeline_event(
            db,
            run.id,
            'info',
            'Primary discovery source unavailable; switched to fallback discovery',
            {'warning': crawl_warning, 'provider': str(crawl_result.get('provider') or 'unknown')},
        )
    crawl_items_raw = list(crawl_result.get('items') or [])
    external_rows = [
        row
        for row in crawl_items_raw
        if _is_external(str(row.get('url') or ''))
        and _is_blog_like_external_url(str(row.get('url') or ''), str(row.get('title') or ''))
    ][:max_opencrawl_candidates]
    dedup_cluster = dedup_and_cluster_discovery(
        external_rows,
        max_urls_per_domain=2,
        max_items=max_opencrawl_candidates,
    )
    crawl_items = [
        row
        for row in list(dedup_cluster.get('items') or [])
        if _is_blog_like_external_url(str(row.get('url') or ''), str(row.get('title') or ''))
    ]
    no_competitor_mode = False
    crawl_error_text = ''
    if not bool(crawl_result.get('ok')):
        crawl_error_text = str(crawl_result.get('error') or 'unknown')
        no_competitor_mode = True
        crawl_items = []
    if not crawl_items:
        fallback_items = await _discover_external_competitors_fallback(topic.primary_keyword, max_opencrawl_candidates)
        if fallback_items:
            crawl_items = fallback_items
            no_competitor_mode = False
            log_pipeline_event(
                db,
                run.id,
                'info',
                'Fallback competitor discovery completed',
                {'fallback_items': len(fallback_items), 'provider': 'bing+ddg'},
            )
        else:
            no_competitor_mode = True
            if crawl_error_text:
                log_pipeline_event(
                    db,
                    run.id,
                    'warning',
                    'OpenCrawl discovery failed; continuing in research-lite mode',
                    {'error': crawl_error_text},
                )
            log_pipeline_event(
                db,
                run.id,
                'warning',
                'OpenCrawl returned no competitor URLs; continuing with internal/sitemap context',
                {'from_cache': bool(crawl_result.get('from_cache'))},
            )
    elif len(crawl_items) < max_competitor_pages:
        fallback_items = await _discover_external_competitors_fallback(topic.primary_keyword, max_opencrawl_candidates)
        if fallback_items:
            seen_urls = {str(item.get('url') or '').rstrip('/') for item in crawl_items if str(item.get('url') or '').strip()}
            added = 0
            for item in fallback_items:
                url = str(item.get('url') or '').strip()
                if not url:
                    continue
                norm = url.rstrip('/')
                if norm in seen_urls:
                    continue
                if not _is_blog_like_external_url(url, str(item.get('title') or '')):
                    continue
                seen_urls.add(norm)
                crawl_items.append(item)
                added += 1
                if len(crawl_items) >= max_opencrawl_candidates:
                    break
            if added > 0:
                log_pipeline_event(
                    db,
                    run.id,
                    'info',
                    'Fallback competitor discovery supplemented sparse primary results',
                    {'added': added, 'total_after_merge': len(crawl_items)},
                )

    db.execute(delete(CompetitorExtract).where(CompetitorExtract.pipeline_run_id == run.id))
    db.execute(delete(CompetitorPage).where(CompetitorPage.pipeline_run_id == run.id))
    db.commit()

    competitor_pages: list[CompetitorPage] = []
    if len(crawl_items) > max_competitor_pages:
        log_pipeline_event(
            db,
            run.id,
            'warning',
            'OpenCrawl candidate cap applied',
            {'max_competitor_pages': max_competitor_pages, 'discovered_candidates': len(crawl_items)},
        )

    for row in crawl_items[:max_competitor_pages]:
        if not _is_blog_like_external_url(str(row.get('url') or ''), str(row.get('title') or '')):
            continue
        preliminary = compute_competitive_strength(
            keyword=topic.primary_keyword,
            title=str(row.get('title') or ''),
            snippet=str(row.get('snippet') or ''),
            headings={'h2': [], 'h3': []},
            metrics={'word_count_estimate': int(row.get('content_length_estimate') or 0)},
            faqs=[],
            discovered_at=str(row.get('discovered_at') or ''),
            last_seen_at=str(row.get('last_seen_at') or ''),
            inlink_count=row.get('inlink_count'),
            publish_date='',
        )
        page = CompetitorPage(
            pipeline_run_id=run.id,
            project_id=project.id,
            url=str(row.get('url') or ''),
            domain=str(row.get('domain') or ''),
            title=str(row.get('title') or '')[:512],
            snippet=str(row.get('snippet') or '')[:4000],
            discovery_order=int(row.get('position') or len(competitor_pages) + 1),
            competitive_strength_score=float(preliminary.get('competitive_strength_score') or 0.0),
            freshness_score=float(preliminary.get('freshness_score') or 0.0),
            inlink_count=int(row.get('inlink_count') or 0) if row.get('inlink_count') is not None else None,
            discovered_at=_safe_parse_dt(row.get('discovered_at')),
            last_seen_at=_safe_parse_dt(row.get('last_seen_at')),
            fetch_status='pending',
            fetched_at=datetime.utcnow(),
        )
        db.add(page)
        competitor_pages.append(page)
    db.commit()
    for page in competitor_pages:
        db.refresh(page)

    log_pipeline_event(
        db,
        run.id,
        'info',
        'Competitor fetch started',
        {'requested_urls': [row.url for row in competitor_pages]},
    )

    extracts_ok: list[dict[str, Any]] = []
    evidence_panel: list[dict[str, Any]] = []
    if competitor_pages:
        try:
            results = await asyncio.wait_for(
                asyncio.gather(*(fetch_and_extract(row.url) for row in competitor_pages), return_exceptions=True),
                timeout=total_fetch_timeout,
            )
        except asyncio.TimeoutError:
            results = []
            log_pipeline_event(
                db,
                run.id,
                'warning',
                'Competitor fetch budget timeout reached',
                {'total_fetch_timeout': total_fetch_timeout},
            )
        for row, result in zip(competitor_pages, results):
            if isinstance(result, Exception):
                row.fetch_status = 'failed'
                row.error_message = str(result)
                row.fetch_error_type = 'parse_failed'
                db.add(row)
                continue
            if not isinstance(result, dict):
                row.fetch_status = 'failed'
                row.error_message = 'unknown_extract_error'
                row.fetch_error_type = 'parse_failed'
                db.add(row)
                continue
            if not bool(result.get('ok')):
                row.fetch_status = str(result.get('status') or 'blocked')
                row.error_message = str(result.get('error') or '')
                row.fetch_error_type = str(result.get('fetch_error_type') or 'timeout')
                db.add(row)
                evidence_panel.append(
                    {
                        'url': row.url,
                        'title': row.title,
                        'domain': row.domain,
                        'discovery_order': row.discovery_order,
                        'competitive_strength_score': float(row.competitive_strength_score or 0.0),
                        'freshness_score': float(row.freshness_score or 0.0),
                        'inlink_count': row.inlink_count,
                        'fetch_status': row.fetch_status,
                        'fetch_error_type': str(result.get('fetch_error_type') or ''),
                    }
                )
                continue
            row.fetch_status = 'ok'
            row.fetch_error_type = None
            row.html_snapshot = str(result.get('html_snapshot') or '')
            db.add(row)

            extract_row = CompetitorExtract(
                competitor_page_id=row.id,
                pipeline_run_id=run.id,
                project_id=project.id,
                url=row.url,
                headings_json=result.get('headings') or {},
                entities_json=result.get('entities') or [],
                faqs_json=result.get('faqs') or [],
                metrics_json=result.get('metrics') or {},
                trust_signals_json=result.get('trust_signals') or {},
                plain_text=str(result.get('plain_text') or '')[:max_extract_chars],
            )
            db.add(extract_row)
            clipped_plain = str(result.get('plain_text') or '')
            if len(clipped_plain) > max_extract_chars:
                log_pipeline_event(
                    db,
                    run.id,
                    'warning',
                    'Extract chars capped for competitor source',
                    {'url': row.url, 'max_extract_chars': max_extract_chars},
                )
            extracts_ok.append(
                {
                    'url': row.url,
                    'title': row.title,
                    'snippet': row.snippet,
                    'discovered_at': row.discovered_at.isoformat() if row.discovered_at else None,
                    'last_seen_at': row.last_seen_at.isoformat() if row.last_seen_at else None,
                    'inlink_count': row.inlink_count,
                    'headings': result.get('headings') or {},
                    'entities': result.get('entities') or [],
                    'faqs': result.get('faqs') or [],
                    'metrics': result.get('metrics') or {},
                    'trust_signals': result.get('trust_signals') or {},
                    'plain_text': clipped_plain[:max_extract_chars],
                }
            )
            evidence_panel.append(
                {
                    'url': row.url,
                    'title': row.title,
                    'domain': row.domain,
                    'discovery_order': row.discovery_order,
                    'headings': result.get('headings') or {},
                    'entities': result.get('entities') or [],
                    'faqs': result.get('faqs') or [],
                    'content_length_estimate': int((result.get('metrics') or {}).get('word_count_estimate') or 0),
                    'media_count': int((result.get('metrics') or {}).get('media_count') or 0),
                    'table_count': int((result.get('metrics') or {}).get('table_count') or 0),
                    'trust_signals': result.get('trust_signals') or {},
                    'plain_text': clipped_plain[:max_extract_chars],
                    'competitive_strength_score': float(row.competitive_strength_score or 0.0),
                    'freshness_score': float(row.freshness_score or 0.0),
                    'inlink_count': row.inlink_count,
                    'fetch_status': 'ok',
                    'fetch_error_type': '',
                }
            )
        db.commit()

    filtered_extracts = [
        row
        for row in extracts_ok
        if _is_blog_like_external_url(str(row.get('url') or ''), str(row.get('title') or ''))
    ]
    topic_map = analyze_competitors(filtered_extracts, keyword=topic.primary_keyword, max_pages=max_competitor_pages)
    score_by_url = {
        str(item.get('url') or ''): float(item.get('competitive_strength_score') or 0.0)
        for item in (topic_map.get('page_scores') or [])
    }
    for row in competitor_pages:
        if row.url in score_by_url:
            row.competitive_strength_score = score_by_url[row.url]
            db.add(row)
    db.commit()
    ai_subtopics = list(topic_map.get('union_headings') or [])[:12]
    ai_entities = list(topic_map.get('top_entities') or [])[:20]
    ai_competitor_domains = sorted(
        {
            (urlparse(str(row.get('url') or '')).netloc or '').lower().replace('www.', '')
            for row in filtered_extracts
            if str(row.get('url') or '').startswith('http')
        }
    )
    ai_competitor_urls = [str(row.get('url') or '') for row in filtered_extracts if str(row.get('url') or '').startswith('http')]

    query_text = _build_retrieval_query(topic, ai_subtopics or [topic.primary_keyword])
    rag_top_k = int(runtime.get('rag_top_k') or 8)
    internal_links_max = max(1, int(runtime.get('internal_links_max') or 8))
    openai_key = runtime.get('openai_api_key')
    internal_candidates = retrieve_internal_link_candidates(
        project_id=project.id,
        query_text=query_text,
        top_k=max(3, rag_top_k),
        openai_api_key=openai_key,
        rag_enabled=bool(runtime.get('rag_enabled', True)),
    )
    fallback_links = pick_internal_links(
        [
            row
            for row in augmented_library
            if _is_page_like_internal_url(str(row.get('url') or ''), str(row.get('type') or ''))
        ],
        topic.primary_keyword,
        max_links=max(30, internal_links_max * 3),
    )
    if not internal_candidates:
        internal_candidates = [
            {
                'item_id': idx + 1,
                'title': row.get('anchor', ''),
                'url': row.get('url', ''),
                'type': 'library',
                'tags': [],
                'score': 999.0,
            }
            for idx, row in enumerate(fallback_links)
        ]
    else:
        internal_candidates = [
            row
            for row in internal_candidates
            if _is_page_like_internal_url(str(row.get('url') or ''), str(row.get('type') or ''))
        ]
        existing_urls = {str(row.get('url') or '').rstrip('/') for row in internal_candidates if row.get('url')}
        # Expand candidate pool to all relevant internal pages, not just blog URLs.
        for row in augmented_library:
            raw_url = str(row.get('url') or '').strip()
            normalized = raw_url.rstrip('/')
            if not normalized or normalized in existing_urls:
                continue
            if not _is_page_like_internal_url(raw_url, str(row.get('type') or '')):
                continue
            existing_urls.add(normalized)
            internal_candidates.append(
                {
                    'item_id': len(internal_candidates) + 1,
                    'title': str(row.get('title') or raw_url),
                    'url': raw_url,
                    'type': str(row.get('type') or 'library'),
                    'tags': list(row.get('tags_json') or []),
                    'score': 970.0 + len(existing_urls),
                }
            )
        for row in fallback_links:
            normalized = str(row.get('url') or '').rstrip('/')
            if not normalized or normalized in existing_urls:
                continue
            existing_urls.add(normalized)
            internal_candidates.append(
                {
                    'item_id': len(internal_candidates) + 1,
                    'title': row.get('anchor', ''),
                    'url': row.get('url', ''),
                    'type': 'library',
                    'tags': [],
                    'score': 950.0 + len(existing_urls),
                }
            )

    internal_link_plan = build_internal_link_plan(
        internal_candidates,
        topic.primary_keyword,
        max_links=max(1, internal_links_max),
    )
    log_pipeline_event(
        db,
        run.id,
        'info',
        'Internal link planning completed',
        {
            'candidate_count': len(internal_candidates),
            'plan_count': len(internal_link_plan),
            'planned_urls': [row.get('url') for row in internal_link_plan if row.get('url')],
        },
    )

    domain_guard = classify_domain_context(
        topic.primary_keyword,
        ai_entities,
        extracted_text=' '.join(str(row.get('plain_text') or '')[:2000] for row in filtered_extracts[:3]),
    )

    competitor_domains = ai_competitor_domains[:10]
    sources = [
        {
            'url': row.get('url'),
            'title': row.get('title') or f"Competitor result #{idx + 1}",
            'domain': (urlparse(str(row.get('url') or '')).netloc or '').lower().replace('www.', ''),
        }
        for idx, row in enumerate(filtered_extracts)
        if row.get('url')
    ]
    crawl_sources = [
        {
            'discovery_order': int(item.get('position') or 0),
            'title': str(item.get('title') or ''),
            'url': str(item.get('url') or ''),
            'domain': str(item.get('domain') or ''),
            'snippet': str(item.get('snippet') or ''),
            'discovered_at': str(item.get('discovered_at') or crawl_result.get('fetched_at') or datetime.utcnow().isoformat()),
            'last_seen_at': str(item.get('last_seen_at') or ''),
            'inlink_count': int(item.get('inlink_count') or 0) if item.get('inlink_count') is not None else None,
            'content_length_estimate': int(item.get('content_length_estimate') or 0)
            if item.get('content_length_estimate') is not None
            else None,
            'competitive_strength_score': float(score_by_url.get(str(item.get('url') or ''), 0.0)),
            'fetch_status': 'pending',
        }
        for item in crawl_items[:max_competitor_pages]
        if _is_blog_like_external_url(str(item.get('url') or ''), str(item.get('title') or ''))
    ]
    meta = {
        'sources': sources,
        'crawl_sources': crawl_sources,
        'evidence_panel': evidence_panel,
        'subtopics': ai_subtopics[:12] or [topic.primary_keyword],
        'entities': sorted(set(ai_entities))[:20],
        'internal_links': internal_link_plan,
        'internal_link_candidates': internal_candidates,
        'research_off': no_competitor_mode,
        'research_trace': {
            'web_source_count': len(crawl_items),
            'crawl_error': crawl_error_text,
            'competitor_domains': competitor_domains,
            'library_items_count': len(library),
            'sitemap_urls_count': len(sitemap_urls),
            'internal_candidate_count': len(internal_candidates),
            'internal_plan_count': len(internal_link_plan),
            'no_competitor_mode': no_competitor_mode,
            'crawl_provider': crawl_result.get('provider'),
            'crawl_cache_key': crawl_result.get('cache_key'),
            'crawl_from_cache': bool(crawl_result.get('from_cache')),
            'crawl_from_stale_cache': bool(crawl_result.get('from_stale_cache')),
            'present_intent_clusters': dedup_cluster.get('present_clusters') or [],
            'missing_intent_clusters': dedup_cluster.get('missing_clusters') or [],
            'dropped_for_domain_cap': int(dedup_cluster.get('dropped_for_domain_cap') or 0),
            'domain_guard': domain_guard,
            'budget_caps': {
                'max_competitor_pages': max_competitor_pages,
                'max_extract_chars': max_extract_chars,
                'total_fetch_timeout': total_fetch_timeout,
                'max_opencrawl_candidates': max_opencrawl_candidates,
            },
        },
        'title_candidates': [str(item.get('title') or '').strip() for item in crawl_items[:8] if str(item.get('title') or '').strip()],
        'topic_map': topic_map,
        'topic_map_sources': filtered_extracts,
        'domain_guard': domain_guard,
        'intent_clusters': {
            'present': dedup_cluster.get('present_clusters') or [],
            'missing': dedup_cluster.get('missing_clusters') or [],
        },
    }

    payload.update(meta)
    log_pipeline_event(
        db,
        run.id,
        'info',
        'Research stage completed',
        {
            'source_count': len(sources),
            'crawl_source_count': len(crawl_sources),
            'evidence_count': len(evidence_panel),
            'internal_candidates': len(internal_candidates),
            'internal_plan_count': len(internal_link_plan),
            'library_items_count': len(library),
            'sitemap_urls_count': len(sitemap_urls),
            'competitor_domains': competitor_domains,
            'top_competitor_urls': ai_competitor_urls[:10],
            'no_competitor_mode': no_competitor_mode,
            'crawl_error': crawl_error_text,
            'crawl_provider': crawl_result.get('provider'),
            'crawl_from_stale_cache': bool(crawl_result.get('from_stale_cache')),
            'present_intent_clusters': dedup_cluster.get('present_clusters') or [],
            'missing_intent_clusters': dedup_cluster.get('missing_clusters') or [],
            'domain_mismatch_score': domain_guard.get('domain_mismatch_score'),
        },
    )
    return payload


async def stage_brief(db: Session, run: PipelineRun, payload: dict[str, Any]) -> dict[str, Any]:
    run.stage = 'brief'
    db.add(run)
    db.commit()

    topic = db.get(Topic, run.topic_id)
    project = db.get(Project, run.project_id)
    if not topic or not project:
        raise RuntimeError('Pipeline entities not found')

    forced_structure = payload.get('force_structure_type')
    pattern = None
    if forced_structure:
        pattern = db.execute(
            select(ContentPattern).where(
                ContentPattern.project_id == project.id,
                ContentPattern.pattern_key == forced_structure,
            )
        ).scalar_one_or_none()
    if not pattern:
        pattern = choose_pattern(db, project.id)
    style_rules = project.settings_json.get('style_rules', [])
    tone = payload.get('tone') or project.settings_json.get('tone', 'professional')
    persona = project.settings_json.get('persona', 'subject matter expert')
    reading_level = project.settings_json.get('reading_level', 'grade 8')

    pattern_outline = pattern.outline_json or []
    if pattern_outline:
        headings = [
            _sanitize_generated_phrase(str(line).replace('{keyword}', topic.primary_keyword), topic.primary_keyword)
            for line in pattern_outline
            if _sanitize_generated_phrase(str(line).replace('{keyword}', topic.primary_keyword), topic.primary_keyword)
        ]
    else:
        headings = [
            _sanitize_generated_phrase(str(item), topic.primary_keyword)
            for item in (payload.get('subtopics', []) or [])[:8]
            if _sanitize_generated_phrase(str(item), topic.primary_keyword)
        ]

    if not headings:
        headings = [
            f'Why {topic.primary_keyword} matters',
            f'Common mistakes with {topic.primary_keyword}',
            f'Implementation steps for {topic.primary_keyword}',
            f'Measuring outcomes for {topic.primary_keyword}',
        ]

    fingerprint = build_fingerprint(pattern.pattern_key, headings)
    if fingerprint_is_recent(db, project.id, fingerprint):
        headings = [f'{h} ({topic.primary_keyword})' for h in headings]
        fingerprint = build_fingerprint(pattern.pattern_key, headings)

    topic_map = payload.get('topic_map') or {}
    evidence_text = ' '.join(
        str(item.get('plain_text') or '')
        for item in (payload.get('evidence_panel') or [])[:8]
        if str(item.get('plain_text') or '').strip()
    )
    niche_payload = _classify_topic_niche(
        topic.primary_keyword,
        list(topic.secondary_keywords_json or []),
        topic.title,
        evidence_text,
    )
    strategic_brief = build_content_brief(
        keyword=topic.primary_keyword,
        title=topic.title,
        topic_map=topic_map if isinstance(topic_map, dict) else {},
        internal_link_plan=payload.get('internal_links', []) or [],
        desired_word_count=int(topic.desired_word_count or 1200),
    )
    required_sections = [str(item).strip() for item in (strategic_brief.get('required_sections') or []) if str(item).strip()]
    if not required_sections:
        required_sections = _build_required_sections(niche_payload, topic.primary_keyword)
    intent_clusters = payload.get('intent_clusters') or {}
    present_clusters = [str(item) for item in (intent_clusters.get('present') or []) if str(item)]
    missing_clusters = [str(item) for item in (intent_clusters.get('missing') or []) if str(item)]
    if required_sections:
        headings = required_sections
    cluster_sections = {
        'informational_howto': f'How {topic.primary_keyword} works: practical implementation guide',
        'commercial_supplier': f'How to evaluate suppliers for {topic.primary_keyword}',
        'standards_compliance': f'Standards and compliance checks for {topic.primary_keyword}',
        'pricing_cost': f'Pricing and cost factors for {topic.primary_keyword}',
    }
    for cluster in present_clusters:
        section = cluster_sections.get(cluster)
        if section and section not in headings:
            headings.append(section)

    domain_guard = payload.get('domain_guard') or {}
    mismatch_tokens = list(domain_guard.get('mismatch_tokens') or [])
    if mismatch_tokens:
        headings = [sanitize_domain_vocabulary(item, mismatch_tokens, str(domain_guard.get('domain') or 'general')) for item in headings]

    research_faqs: list[str] = []
    keyword_terms = _tokenize_overlap_terms(topic.primary_keyword)
    for row in (payload.get('evidence_panel') or [])[:12]:
        for q in (row.get('faqs') or [])[:4]:
            value = str(q or '').strip()
            q_terms = _tokenize_overlap_terms(value)
            if value and ((not keyword_terms) or bool(q_terms & keyword_terms)):
                research_faqs.append(value)

    brief = {
        'angle': f"{pattern.pattern_key} content with practical specificity for {topic.primary_keyword}",
        'h2': headings[:5],
        'h3': headings[5:10],
        'faqs': _normalize_faqs(
            [*research_faqs, *(payload.get('subtopics', [f'What is {topic.primary_keyword}?']) or [])],
            topic.primary_keyword,
        ),
        'entity_checklist': payload.get('entities', []),
        'pattern_key': pattern.pattern_key,
        'fingerprint': fingerprint,
        'tone': tone,
        'persona': persona,
        'reading_level': reading_level,
        'style_rules': style_rules,
        'cta_text': pattern.cta_text or f'Build a repeatable {topic.primary_keyword} workflow.',
        'faq_schema_enabled': bool(pattern.faq_schema_enabled),
        'structure_type': pattern.pattern_key,
        'intro_style': payload.get('force_intro_style') or 'problem-agitate-solve',
        'cta_style': payload.get('force_cta_style') or 'soft-next-step',
        'target_intent_mix': strategic_brief.get('target_intent_mix') or {},
        'required_sections': required_sections,
        'differentiators': strategic_brief.get('differentiators') or [],
        'cta_plan': strategic_brief.get('cta_plan') or {},
        'qa_targets': strategic_brief.get('qa_targets') or {},
        'source_count': int(strategic_brief.get('source_count') or 0),
        'present_intent_clusters': present_clusters,
        'missing_intent_clusters': missing_clusters,
        'domain_guard': domain_guard,
        'niche_payload': niche_payload,
    }

    db.execute(delete(BlogBrief).where(BlogBrief.pipeline_run_id == run.id))
    brief_row = BlogBrief(
        pipeline_run_id=run.id,
        project_id=project.id,
        keyword=topic.primary_keyword,
        intent_mix_json=brief.get('target_intent_mix') or {},
        required_sections_json=brief.get('required_sections') or [],
        differentiators_json=brief.get('differentiators') or [],
        internal_link_plan_json=payload.get('internal_links') or [],
        cta_plan_json=brief.get('cta_plan') or {},
        brief_json=brief,
    )
    db.add(brief_row)
    db.commit()

    payload['brief'] = brief
    log_pipeline_event(
        db,
        run.id,
        'info',
        'Brief stage completed',
        {
            'pattern': pattern.pattern_key,
            'required_sections': brief.get('required_sections', [])[:10],
            'differentiators': brief.get('differentiators', [])[:6],
        },
    )
    return payload


async def stage_draft(db: Session, run: PipelineRun, payload: dict[str, Any]) -> dict[str, Any]:
    run.stage = 'draft'
    db.add(run)
    db.commit()

    topic = db.get(Topic, run.topic_id)
    project = db.get(Project, run.project_id)
    if not topic or not project:
        raise RuntimeError('Pipeline entities not found')

    brief = payload['brief']
    internal_link_plan = payload.get('internal_links', [])
    candidates = payload.get('internal_link_candidates', [])
    title_candidates = payload.get('title_candidates', [])

    runtime = resolve_project_runtime_config(db, project)
    openai_key = runtime.get('openai_api_key')
    provider = OpenAIProvider(
        api_key=openai_key,
        model=runtime.get('openai_model'),
        image_model=runtime.get('image_model'),
    )

    requested_link_cap = max(1, int(runtime.get('internal_links_max') or 8))
    min_links = min(requested_link_cap, len(candidates)) if candidates else 0
    desired_word_count = int(topic.desired_word_count or 1200)
    density_limit = max(3, desired_word_count // 160)
    max_links = min(requested_link_cap, density_limit, max(1, len(candidates) or 1))
    image_mode = str(payload.get('image_mode') or 'featured_only')
    inline_images_count = int(payload.get('inline_images_count') or 0)

    known_site_context = [
        {'title': row.get('title', ''), 'url': row.get('url', ''), 'type': row.get('type', '')}
        for row in (candidates or [])[:20]
        if row.get('url')
    ]
    competitor_domains = sorted(
        {
            (urlparse(str(row.get('url') or '')).netloc or '').lower().replace('www.', '')
            for row in (payload.get('sources') or [])
            if row.get('url')
        }
    )[:10]
    domain_guard = payload.get('domain_guard') or {}
    mismatch_tokens = list(domain_guard.get('mismatch_tokens') or [])
    evidence_text = ' '.join(
        str(item.get('plain_text') or '')
        for item in (payload.get('evidence_panel') or [])[:8]
        if str(item.get('plain_text') or '').strip()
    )
    niche_payload = brief.get('niche_payload') or _classify_topic_niche(
        topic.primary_keyword,
        list(topic.secondary_keywords_json or []),
        topic.title,
        evidence_text,
    )
    disallowed_phrases = list(dict.fromkeys([*(niche_payload.get('disallowed_phrases') or []), *BAN_PHRASES]))
    health_topic = bool(niche_payload.get('niche') == 'health') or _is_health_related_topic(topic.title, topic.primary_keyword, *(topic.secondary_keywords_json or []))

    prompt = (
        'You are an SEO content strategist. Return strict JSON only (no markdown) with keys: '
        'title,meta_title,meta_description,slug,html,title_variants,featured_image_prompt,alt_text,caption. '
        f"Topic: {topic.title}. Primary keyword: {topic.primary_keyword}. Secondary keywords: {topic.secondary_keywords_json}. "
        f"Project base URL: {project.base_url}. "
        f"Pattern: {brief['pattern_key']}. Tone: {brief['tone']}. Persona: {brief['persona']}. Reading level: {brief['reading_level']}. "
        f"Structure type: {brief.get('structure_type')}. Intro style: {brief.get('intro_style')}. CTA style: {brief.get('cta_style')}. "
        f"Outline H2/H3: {brief['h2'] + brief['h3']}. FAQ ideas: {brief['faqs']}. "
        f"CTA requirement: {brief.get('cta_text')}. FAQ schema enabled: {brief.get('faq_schema_enabled')}. "
        f"Competitor-informed title candidates: {title_candidates}. "
        f"Competitor domain set (for intent/context only): {competitor_domains}. "
        f"Intent clusters present: {brief.get('present_intent_clusters', [])}. Missing clusters: {brief.get('missing_intent_clusters', [])}. "
        f"Domain-mismatch forbidden tokens: {mismatch_tokens}. If present, avoid them and use domain-correct vocabulary. "
        f"Website internal context (use naturally in content where relevant): {known_site_context}. "
        f"Internal link candidates: {candidates}. Suggested link plan: {internal_link_plan}. "
        f"Internal linking constraints: include at least {min_links} internal links if available, "
        f"never repeat exact same anchor text, and keep at most {max_links} total links for ~{desired_word_count} words. "
        "Use natural anchor styles like 'Read more', 'Explore this', 'Learn more', and context-specific anchors "
        "(avoid repetitive 'Reference:' wording). "
        f"Niche classification: {niche_payload}. "
        "Keyword alignment rules: primary keyword must appear naturally in intro (first 120 words), at least 2 H2 headings, and conclusion. "
        "Use at least 3 secondary keywords naturally across sections. Avoid stuffing. "
        f"Forbidden phrase list: {disallowed_phrases}. Never use these phrases. "
        "Never include source URLs, research links, source appendices, key research signals, citations, or references sections in final HTML. "
        f"Content length requirement: produce approximately {desired_word_count} words in body_html with detailed multi-paragraph sections. "
        "Depth requirement: each H2 section must include at least 2 substantial paragraphs (around 70+ words each) and one practical element "
        "(bullet checklist, comparison list, or concrete example). Avoid short one-line descriptions under headings. "
        "Mandatory structure: engaging hook intro, detailed H2/H3 sections, practical examples, bullets/checklists where useful, "
        "a dedicated FAQ section (exactly 5 Q&A), and a strong conclusion section with CTA. "
        "FAQ rules: each FAQ answer must directly answer its question, no generic manufacturing/QA text, "
        "and reject answer patterns like process controls, acceptance criteria, pilot validation, defect trends, total landed cost. "
        "Title constraints: do not use generic prefixes like 'Complete Guide' or 'Ultimate Guide'; "
        "never append project/site name (for example, avoid 'for My SEO Blog'). "
        "Use a natural, trend-aware, intent-specific title that looks like a modern ranking article headline. "
        "Do not output placeholders or template answers. If unsure, omit. Avoid keyword stuffing. Keep paragraphs natural, specific, and conversion-oriented. "
        f"Image mode: {image_mode}. Inline image count target: {inline_images_count}. "
        f"Banned claims: {project.settings_json.get('banned_claims', [])}."
    )

    generation: dict[str, Any]
    input_tokens = 0
    output_tokens = 0
    raw_generation_text = ''
    if provider.enabled:
        try:
            result = await provider.generate_text(prompt)
            input_tokens += result.input_tokens
            output_tokens += result.output_tokens
            raw_generation_text = result.text or ''
            generation = _parse_generation_json(raw_generation_text)
            if not generation and raw_generation_text.strip():
                repair_prompt = (
                    'Convert the following content to strict valid JSON only with keys '
                    'title,meta_title,meta_description,slug,html,title_variants,featured_image_prompt,alt_text,caption. '
                    'If html is missing, produce full detailed html article content.\n\n'
                    f"CONTENT:\n{raw_generation_text[:12000]}"
                )
                repair = await provider.generate_text(repair_prompt)
                input_tokens += repair.input_tokens
                output_tokens += repair.output_tokens
                generation = _parse_generation_json(repair.text or '')
        except Exception as exc:
            msg = str(exc or '').lower()
            if 'auth failed' in msg or '401' in msg or 'unauthorized' in msg:
                raise RuntimeError(
                    'OpenAI authorization failed while generating blog content. '
                    'Please update OpenAI key in Settings and retry.'
                ) from exc
            log_pipeline_event(db, run.id, 'warning', 'LLM draft generation failed, fallback used', {'error': str(exc)})
            generation = {}
    else:
        generation = {}

    if provider.enabled and not generation:
        log_pipeline_event(
            db,
            run.id,
            'warning',
            'LLM output was not parseable JSON, fallback used',
            {'sample': raw_generation_text[:200]},
        )

    title = _resolve_draft_title(
        generation.get('title'),
        topic.primary_keyword,
        payload.get('subtopics', []),
        title_candidates,
    )
    h2s = brief.get('h2', [])
    generated_html = generation.get('html') or ''
    min_acceptable_words = max(1000, int(desired_word_count * 0.9))
    generated_words = _html_word_count(generated_html)
    if generated_html and generated_words < min_acceptable_words:
        if provider.enabled:
            try:
                expand_prompt = (
                    'Expand and improve the following HTML blog content while preserving topic intent. '
                    f'Target {desired_word_count} words. Must include: strong intro, rich H2/H3 sections, '
                    'at least 5 FAQ Q&A entries, and a clear Conclusion section with CTA. '
                    'Each H2 must have at least 2 substantial paragraphs with concrete, topic-specific detail and practical guidance. '
                    'Avoid thin one-line section descriptions. '
                    'Return strict JSON only with keys: title,meta_title,meta_description,slug,html,title_variants,'
                    'featured_image_prompt,alt_text,caption.\n\n'
                    f'CURRENT_JSON:\n{json.dumps(generation)[:12000]}'
                )
                expanded = await provider.generate_text(expand_prompt)
                input_tokens += expanded.input_tokens
                output_tokens += expanded.output_tokens
                expanded_generation = _parse_generation_json(expanded.text or '')
                expanded_html = expanded_generation.get('html') or ''
                if _html_word_count(expanded_html) >= min_acceptable_words:
                    generation.update(expanded_generation)
                    generated_html = expanded_html
                else:
                    generated_html = ''
            except Exception as exc:
                generated_html = ''
                log_pipeline_event(
                    db,
                    run.id,
                    'warning',
                    'LLM expansion failed, fallback used',
                    {'error': str(exc) or repr(exc)},
                )
        else:
            generated_html = ''
        if not generated_html:
            log_pipeline_event(
                db,
                run.id,
                'warning',
                'Generated draft too short for requested target, switching to longform fallback',
                {'generated_words': generated_words, 'required_min_words': min_acceptable_words},
            )

    used_fallback = not bool(str(generated_html or '').strip())
    if used_fallback:
        html = _build_fallback_html(
            title,
            brief['pattern_key'],
            topic.primary_keyword,
            h2s,
            internal_link_plan,
            desired_word_count=desired_word_count,
            secondary_keywords=topic.secondary_keywords_json,
            faqs=brief.get('faqs', []),
            cta_text=brief.get('cta_text'),
            niche_payload=niche_payload,
        )
    else:
        html = generated_html
    if mismatch_tokens:
        html = sanitize_domain_vocabulary(html, mismatch_tokens, str(domain_guard.get('domain') or 'general'))
    html = _sanitize_generated_blog_html(html)
    html = _remove_banned_phrase_paragraphs(html)
    html = _cleanup_repetition(html)
    if used_fallback:
        html = _cleanup_fallback_tail_spam(html)
        html = _sanitize_generated_blog_html(html)

    faq_items = _normalize_faqs(brief.get('faqs', []), topic.primary_keyword)
    lowered_html = (html or '').lower()
    has_faq_heading = bool(re.search(r'<h[23][^>]*>\s*(frequently asked questions|faq|faqs|faq section)\s*</h[23]>', lowered_html))
    if not has_faq_heading:
        faq_block = _build_faq_html_block(faq_items, topic.primary_keyword)
        if faq_block:
            html = _append_before_article_end(html, faq_block)
        lowered_html = (html or '').lower()

    if '<h2>conclusion' not in lowered_html and '<h2>final recommendations' not in lowered_html:
        conclusion_cta = _sanitize_placeholder_cta_text(
            str(brief.get('cta_text') or f'Start implementing {topic.primary_keyword} with a repeatable plan.')
        ).strip()
        html = _append_before_article_end(
            html,
            (
                "<h2>Conclusion</h2>"
                f"<p>{topic.primary_keyword} delivers stronger results when strategy, execution, and iteration stay aligned. "
                "Use the checklists and section framework in this guide to improve quality, consistency, and ranking stability.</p>"
                f"<p><strong>{conclusion_cta}</strong></p>"
            ),
        )

    html = _ensure_internal_links_placement(
        html,
        internal_link_plan or candidates,
        min_links=max(1, min_links) if (internal_link_plan or candidates) else 0,
        max_links=max(1, max_links) if (internal_link_plan or candidates) else 1,
        primary_keyword=topic.primary_keyword,
    )
    html = _dedupe_internal_link_urls(html, internal_link_plan or candidates)
    used_internal_links = _extract_used_internal_links(html, internal_link_plan or candidates)
    if not used_internal_links:
        used_internal_links = internal_link_plan[: min_links or requested_link_cap]

    external_candidate_urls = [
        str(item.get('url') or '')
        for item in (payload.get('sources') or [])
        if str(item.get('url') or '').strip()
    ] + [
        str(item.get('url') or '')
        for item in (candidates or [])
        if str(item.get('url') or '').strip()
    ]
    html = _sanitize_external_brand_mentions(
        html,
        project_base_url=project.base_url,
        candidate_urls=external_candidate_urls,
    )
    html = _remove_banned_phrase_paragraphs(html)
    html = _cleanup_repetition(html)

    if health_topic:
        html = _soften_health_claims(html)
        html = _insert_disclaimer_before_faq(html, MEDICAL_DISCLAIMER_TEXT)

    if _faq_contains_contamination(html):
        regenerated_faq_pairs = await _regenerate_topic_faq_pairs(
            provider,
            topic_title=topic.title,
            keyword=topic.primary_keyword,
            faqs=faq_items,
        )
        html = _remove_all_faq_blocks(html)
        faq_block = _build_collapsible_faq_html_from_pairs(regenerated_faq_pairs)
        if faq_block:
            html = _append_before_article_end(html, faq_block)
            faq_items = [str(item.get('question') or '').strip() for item in regenerated_faq_pairs if str(item.get('question') or '').strip()]

    if _faq_has_offtopic_or_banned_answers(html, topic.primary_keyword):
        repaired_faq_pairs = await _repair_faq_only_with_llm(
            provider,
            topic_title=topic.title,
            keyword=topic.primary_keyword,
            faq_questions=faq_items,
            faq_style=str(niche_payload.get('faq_style') or 'consumer'),
            disallowed_phrases=disallowed_phrases,
        )
        html = _remove_all_faq_blocks(html)
        repaired_block = _build_collapsible_faq_html_from_pairs(repaired_faq_pairs)
        if repaired_block:
            html = _append_before_article_end(html, repaired_block)
            faq_items = [str(item.get('question') or '').strip() for item in repaired_faq_pairs if str(item.get('question') or '').strip()]
    html = _remove_banned_phrase_paragraphs(html)
    html = _cleanup_repetition(html)

    title = _sanitize_misleading_case_study_title(title, topic.title, html)
    schema_jsonld = _build_faq_schema(title, faq_items) if brief.get('faq_schema_enabled') else {}

    competitor_texts = [
        str(item.get('plain_text') or '')
        for item in (payload.get('evidence_panel') or [])
        if str(item.get('plain_text') or '').strip()
    ]
    if not competitor_texts:
        competitor_texts = [
            str(item.get('plain_text') or '')
            for item in (payload.get('topic_map_sources') or [])
            if str(item.get('plain_text') or '').strip()
        ]

    originality = enforce_originality(
        html=html,
        competitor_texts=competitor_texts,
        primary_keyword=topic.primary_keyword,
        threshold=float(runtime.get('competitor_similarity_threshold') or 0.18),
    )
    html = str(originality.get('html') or html)
    if mismatch_tokens:
        html = sanitize_domain_vocabulary(html, mismatch_tokens, str(domain_guard.get('domain') or 'general'))
    layout_seed = '|'.join(
        [
            str(topic.primary_keyword or ''),
            str(topic.id or ''),
            str(brief.get('fingerprint') or ''),
            str(run.id or ''),
        ]
    )
    html = _apply_layout_variant(html, title, topic.primary_keyword, layout_seed)
    html = _sanitize_generated_blog_html(html)
    html = _remove_banned_phrase_paragraphs(html)
    html = _cleanup_repetition(html)
    if _has_repetitive_expansion(html):
        html = await _repair_repetition_with_llm(
            provider,
            html=html,
            topic_title=topic.title,
            primary_keyword=topic.primary_keyword,
            desired_word_count=desired_word_count,
        )
        html = _sanitize_generated_blog_html(html)
    html = _enforce_single_faq_block(html, faq_items, topic.primary_keyword)
    if health_topic:
        html = _soften_health_claims(html)
        html = _insert_disclaimer_before_faq(html, MEDICAL_DISCLAIMER_TEXT)
    html = _sanitize_generated_blog_html(html)
    html = _remove_banned_phrase_paragraphs(html)
    html = _cleanup_repetition(html)
    html = _strip_known_artifacts(html)
    html = _sanitize_generated_blog_html(html)
    if _faq_contains_contamination(html):
        regenerated_faq_pairs = await _regenerate_topic_faq_pairs(
            provider,
            topic_title=topic.title,
            keyword=topic.primary_keyword,
            faqs=faq_items,
        )
        html = _remove_all_faq_blocks(html)
        faq_block = _build_collapsible_faq_html_from_pairs(regenerated_faq_pairs)
        if faq_block:
            html = _append_before_article_end(html, faq_block)
            faq_items = [str(item.get('question') or '').strip() for item in regenerated_faq_pairs if str(item.get('question') or '').strip()]
        html = _sanitize_generated_blog_html(html)
    if _faq_has_offtopic_or_banned_answers(html, topic.primary_keyword):
        repaired_faq_pairs = await _repair_faq_only_with_llm(
            provider,
            topic_title=topic.title,
            keyword=topic.primary_keyword,
            faq_questions=faq_items,
            faq_style=str(niche_payload.get('faq_style') or 'consumer'),
            disallowed_phrases=disallowed_phrases,
        )
        html = _remove_all_faq_blocks(html)
        repaired_block = _build_collapsible_faq_html_from_pairs(repaired_faq_pairs)
        if repaired_block:
            html = _append_before_article_end(html, repaired_block)
            faq_items = [str(item.get('question') or '').strip() for item in repaired_faq_pairs if str(item.get('question') or '').strip()]
        html = _sanitize_generated_blog_html(html)
    html = _enforce_single_faq_block(html, faq_items, topic.primary_keyword)
    html = _sanitize_generated_blog_html(html)
    html = _remove_banned_phrase_paragraphs(html)
    html = _cleanup_repetition(html)
    if used_fallback:
        html = _cleanup_fallback_tail_spam(html)
        html = _sanitize_generated_blog_html(html)
    html = _rebalance_html_word_count(
        html,
        keyword=topic.primary_keyword,
        desired_words=desired_word_count,
        min_ratio=0.92,
        max_ratio=1.12,
    )
    html = _sanitize_generated_blog_html(html)
    html = _ensure_internal_links_placement(
        html,
        internal_link_plan or candidates,
        min_links=max(1, min_links) if (internal_link_plan or candidates) else 0,
        max_links=max(1, max_links) if (internal_link_plan or candidates) else 1,
        primary_keyword=topic.primary_keyword,
    )
    html = _dedupe_internal_link_urls(html, internal_link_plan or candidates)
    html = _sanitize_generated_blog_html(html)
    used_internal_links = _extract_used_internal_links(html, internal_link_plan or candidates)
    if not used_internal_links:
        used_internal_links = internal_link_plan[: min_links or requested_link_cap]

    resolved_meta_title = _clean_title_text(generation.get('meta_title') or title)
    if not resolved_meta_title or _is_generic_title(resolved_meta_title):
        resolved_meta_title = title
    resolved_meta_title = _sanitize_misleading_case_study_title(resolved_meta_title, topic.title, html)
    resolved_slug = str(generation.get('slug') or '').strip()
    if not resolved_slug or re.search(r'(?i)case-study', resolved_slug):
        resolved_slug = slugify(title)

    payload['draft'] = {
        'title': title,
        'slug': resolved_slug,
        'html': html,
        'meta_title': resolved_meta_title,
        'meta_description': generation.get('meta_description') or f"Research-backed guide on {topic.primary_keyword}.",
        'title_variants': generation.get('title_variants') or [title],
        'featured_image_prompt': generation.get('featured_image_prompt') or f"Editorial hero image for {topic.primary_keyword}",
        'alt_text': generation.get('alt_text') or f"Illustration for {title}",
        'caption': generation.get('caption') or f"Visual summary for {title}",
        'input_tokens': input_tokens,
        'output_tokens': output_tokens,
        'internal_links_used': used_internal_links,
        'outline_json': brief.get('h2', []) + brief.get('h3', []),
        'faq_json': faq_items,
        'schema_jsonld': schema_jsonld,
        'structure_type': brief.get('structure_type') or brief.get('pattern_key'),
        'outline_fingerprint': brief.get('fingerprint'),
        'intro_style': brief.get('intro_style'),
        'cta_style': brief.get('cta_style'),
        'layout_variant': f"v{_stable_variant_index(layout_seed, 4) + 1}",
        'faq_count': len(faq_items),
        'originality': originality,
        'domain_mismatch_score': float(domain_guard.get('domain_mismatch_score') or 100.0),
    }
    log_pipeline_event(db, run.id, 'info', 'Draft stage completed', {'title': title})
    return payload


async def stage_qa(db: Session, run: PipelineRun, payload: dict[str, Any]) -> dict[str, Any]:
    run.stage = 'qa'
    db.add(run)
    db.commit()

    project = db.get(Project, run.project_id)
    runtime = resolve_project_runtime_config(db, project) if project else {}

    if runtime and not runtime.get('qa_enabled', True):
        qa = {'passed': True, 'warnings': [], 'stats': {'skipped': True}}
        payload['qa'] = qa
        log_pipeline_event(db, run.id, 'info', 'QA stage skipped (disabled by settings)', {})
        return payload

    draft_payload = payload.get('draft', {})
    topic = db.get(Topic, run.topic_id)
    qa = run_draft_qa(
        html=draft_payload.get('html', ''),
        internal_link_candidates=payload.get('internal_link_candidates', []),
        strictness=str(runtime.get('qa_strictness') or 'med'),
        internal_links_max=max(1, int(runtime.get('internal_links_max') or 8)),
        min_internal_links=min(max(1, int(runtime.get('internal_links_max') or 8)), len(payload.get('internal_link_candidates', []))),
        primary_keyword=(topic.primary_keyword if topic else None),
        minimum_word_count=max(
            int(runtime.get('minimum_word_count') or 220),
            int((topic.desired_word_count if topic else 1200) * 0.8),
        ),
        schema_jsonld=draft_payload.get('schema_jsonld'),
    )
    payload['qa'] = qa
    brief = payload.get('brief') or {}
    competitive_scores = _calc_competitive_scores(
        html=draft_payload.get('html', ''),
        required_sections=list(brief.get('required_sections') or brief.get('h2') or []),
        source_count=len(payload.get('sources') or []),
    )
    domain_mismatch_score = float(brief.get('domain_guard', {}).get('domain_mismatch_score') or 100.0)
    competitive_scores['domain_mismatch_score'] = domain_mismatch_score
    if domain_mismatch_score < 70.0:
        qa['passed'] = False
        qa['warnings'] = list(qa.get('warnings') or []) + [
            f'Domain mismatch score too low ({domain_mismatch_score}); content may be off-domain.'
        ]
    payload['qa_competitive'] = competitive_scores

    if qa['passed']:
        log_pipeline_event(
            db,
            run.id,
            'info',
            'QA stage passed',
            {**qa.get('stats', {}), **competitive_scores},
        )
    else:
        for warning in qa['warnings']:
            log_pipeline_event(db, run.id, 'warning', warning, qa.get('stats', {}))

    return payload


async def stage_image(db: Session, run: PipelineRun, payload: dict[str, Any]) -> dict[str, Any]:
    run.stage = 'image'
    db.add(run)
    db.commit()

    project = db.get(Project, run.project_id)
    if not project:
        raise RuntimeError('Project not found')

    draft_payload = payload['draft']
    image_prompt = draft_payload.get('featured_image_prompt')
    if image_prompt:
        image_prompt = (
            f"{image_prompt}. Photorealistic, natural lighting, no text, no words, no logos, no watermark."
        )

    runtime = resolve_project_runtime_config(db, project)
    openai_key = runtime.get('openai_api_key')
    provider = OpenAIProvider(
        api_key=openai_key,
        model=runtime.get('openai_model'),
        image_model=runtime.get('image_model'),
    )

    settings = get_settings()
    media_dir = settings.media_path / str(project.id)
    media_dir.mkdir(parents=True, exist_ok=True)

    image_path = None
    image_mode = str(payload.get('image_mode') or 'featured_only')
    if project.settings_json.get('image_generation_enabled', True) and image_mode != 'prompts_only':
        binary = None
        if provider.enabled:
            try:
                binary = await provider.generate_image(image_prompt)
            except Exception as exc:
                binary = None
                log_pipeline_event(
                    db,
                    run.id,
                    'warning',
                    'Image generation failed, keeping prompt only',
                    {'error': str(exc) or repr(exc), 'type': exc.__class__.__name__},
                )
        if binary:
            image_path = save_binary_image(
                project_id=project.id,
                draft_id=int(run.topic_id or run.id),
                kind='featured',
                index=int(run.id),
                binary=binary,
                extension=guess_image_extension(binary, fallback='png'),
                max_bytes=100 * 1024,
            )
        else:
            image_path = None
            log_pipeline_event(
                db,
                run.id,
                'warning',
                'Image provider unavailable, prompt saved for manual generation',
                {'prompt': image_prompt},
            )

    payload['image'] = {
        'prompt': image_prompt,
        'path': image_path,
    }
    if provider.enabled and not image_path:
        log_pipeline_event(
            db,
            run.id,
            'warning',
            'Image provider returned no asset, prompt saved for manual generation',
            {'prompt': image_prompt},
        )
    log_pipeline_event(db, run.id, 'info', 'Image stage completed', {'generated': bool(image_path)})
    return payload


async def stage_save_draft(db: Session, run: PipelineRun, payload: dict[str, Any]) -> dict[str, Any]:
    run.stage = 'save-draft'
    db.add(run)
    db.commit()

    topic = db.get(Topic, run.topic_id)
    project = db.get(Project, run.project_id)
    if not topic or not project:
        raise RuntimeError('Pipeline entities not found')

    brief = payload['brief']
    draft_payload = payload['draft']
    image_payload = payload.get('image', {})
    qa = payload.get('qa', {'passed': True, 'warnings': []})

    final_status = DraftStatus.draft if qa.get('passed', True) else DraftStatus.needs_review

    final_faq_items = _normalize_faqs(draft_payload.get('faq_json', []), topic.primary_keyword)
    final_html = _sanitize_generated_blog_html(str(draft_payload.get('html') or ''))
    final_html = _enforce_single_faq_block(final_html, final_faq_items, topic.primary_keyword)
    final_html = _strip_known_artifacts(final_html)
    final_html = _sanitize_generated_blog_html(final_html)

    draft = Draft(
        topic_id=topic.id,
        project_id=project.id,
        title=draft_payload['title'],
        slug=draft_payload['slug'],
        outline_json=draft_payload.get('outline_json', []),
        html=final_html,
        meta_title=draft_payload['meta_title'],
        meta_description=draft_payload['meta_description'],
        faq_json=final_faq_items,
        schema_jsonld=draft_payload.get('schema_jsonld', {}),
        internal_links_json=draft_payload.get('internal_links_used', payload.get('internal_links', [])),
        sources_json=payload.get('sources', []),
        image_path=image_payload.get('path'),
        image_prompt=image_payload.get('prompt'),
        alt_text=draft_payload.get('alt_text'),
        caption=draft_payload.get('caption'),
        pattern_key=brief['pattern_key'],
        structure_type=draft_payload.get('structure_type'),
        outline_fingerprint=draft_payload.get('outline_fingerprint'),
        intro_style=draft_payload.get('intro_style'),
        cta_style=draft_payload.get('cta_style'),
        faq_count=int(draft_payload.get('faq_count', 0)),
        similarity_score=float(payload.get('similarity_score', 0.0)),
        fingerprint=brief['fingerprint'],
        platform=str(payload.get('platform') or 'none'),
        platform_post_id=payload.get('platform_post_id'),
        publish_url=payload.get('publish_url'),
        token_input=draft_payload.get('input_tokens', 0),
        token_output=draft_payload.get('output_tokens', 0),
        cost_estimate_usd=estimate_cost(
            draft_payload.get('input_tokens', 0), draft_payload.get('output_tokens', 0)
        ),
        status=final_status,
    )
    db.add(draft)
    topic.status = TopicStatus.completed

    pattern = db.execute(
        select(ContentPattern).where(
            ContentPattern.project_id == project.id,
            ContentPattern.pattern_key == brief['pattern_key'],
        )
    ).scalar_one_or_none()
    if pattern:
        mark_pattern_used(db, pattern)

    run.status = PipelineStatus.completed
    run.stage = 'completed'
    run.finished_at = datetime.utcnow()

    db.add(topic)
    db.add(run)
    db.commit()
    db.refresh(draft)

    competitive_scores = payload.get('qa_competitive') or {}
    db.execute(delete(BlogQa).where(BlogQa.pipeline_run_id == run.id))
    db.add(
        BlogQa(
            draft_id=draft.id,
            pipeline_run_id=run.id,
            project_id=project.id,
            completeness_score=float(competitive_scores.get('completeness_score') or 0.0),
            readability_score=float(competitive_scores.get('readability_score') or 0.0),
            practicality_score=float(competitive_scores.get('practicality_score') or 0.0),
            eeat_score=float(competitive_scores.get('eeat_score') or 0.0),
            domain_mismatch_score=float(competitive_scores.get('domain_mismatch_score') or 100.0),
            overall_score=float(competitive_scores.get('overall_score') or 0.0),
            qa_json={
                'qa_pipeline': payload.get('qa') or {},
                'qa_competitive': competitive_scores,
                'domain_mismatch_score': float(competitive_scores.get('domain_mismatch_score') or 100.0),
            },
        )
    )
    db.commit()

    log_pipeline_event(
        db,
        run.id,
        'info',
        'Draft saved',
        {'draft_id': draft.id, 'status': final_status.value, 'qa_warnings': qa.get('warnings', [])},
    )
    payload['draft_id'] = draft.id
    return payload


async def run_pipeline(db: Session, run_id: int) -> dict[str, Any]:
    run = db.get(PipelineRun, run_id)
    if not run:
        raise RuntimeError(f'Pipeline run {run_id} not found')

    topic = db.get(Topic, run.topic_id)
    if not topic:
        raise RuntimeError('Topic not found')

    topic.status = TopicStatus.running
    db.add(topic)
    db.commit()

    payload: dict[str, Any] = {'run_id': run_id, 'topic_id': run.topic_id, 'project_id': run.project_id}

    try:
        payload = await stage_research(db, run, payload)
        payload = await stage_brief(db, run, payload)
        payload = await stage_draft(db, run, payload)
        payload = await stage_qa(db, run, payload)
        payload = await stage_image(db, run, payload)
        payload = await stage_save_draft(db, run, payload)
        return payload
    except Exception as exc:
        run.status = PipelineStatus.failed
        run.stage = 'failed'
        run.error_message = str(exc)
        run.finished_at = datetime.utcnow()
        topic.status = TopicStatus.failed
        db.add(run)
        db.add(topic)
        db.commit()
        log_pipeline_event(db, run.id, 'error', 'Pipeline failed', {'error': str(exc)})
        raise


def reset_project_library(db: Session, project_id: int) -> None:
    db.execute(delete(ContentLibraryItem).where(ContentLibraryItem.project_id == project_id))
    db.commit()


def save_library_items(db: Session, project_id: int, items: list[dict]) -> int:
    for item in items:
        db.add(
            ContentLibraryItem(
                project_id=project_id,
                type=item.get('type', 'page'),
                title=item.get('title', 'Untitled'),
                url=item.get('url', ''),
                handle=item.get('handle'),
                tags_json=item.get('tags_json', []),
                last_synced_at=item.get('last_synced_at'),
            )
        )
    db.commit()
    return len(items)
