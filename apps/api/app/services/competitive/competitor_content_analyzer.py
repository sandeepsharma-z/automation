
from __future__ import annotations

import asyncio
import json
import re
import time
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from urllib.parse import parse_qs, urlparse

import httpx
from bs4 import BeautifulSoup

from app.core.config import get_settings
from app.services.http_client import request_with_retries
from app.services.providers.openai_provider import OpenAIProvider

STOP_WORDS = {
    "the", "and", "for", "that", "with", "from", "this", "into", "your", "our", "you", "are", "was", "were",
    "have", "has", "had", "not", "can", "will", "their", "they", "them", "about", "than", "then", "also", "but",
    "how", "what", "when", "where", "why", "who", "which", "while", "each", "using", "use", "used", "more",
    "most", "very", "best", "top", "guide", "blog", "article", "page", "content", "over", "under", "such",
}
COOKIE_HINTS = ("cookie", "accept all", "privacy policy", "consent", "gdpr", "manage preferences")
MARKETPLACE_DOMAINS = {
    "amazon.com", "amazon.in", "amazon.co.uk", "flipkart.com", "ebay.com", "walmart.com", "etsy.com", "aliexpress.com",
}
PRODUCT_PATH_HINTS = (
    "/product/", "/products/", "/shop/", "/cart", "/checkout", "/collection/", "/collections/", "/variant", "/dp/",
)
ARTICLE_PATH_HINTS = (
    "/blog/", "/blogs/", "/news/", "/article/", "/articles/", "/guides/", "/guide/", "/learn/", "/resources/", "/health/", "/benefits/",
)
BADGE_TERMS = ("decision-ready", "reader-first", "execution-focused")
FAQ_CONTAMINATION_TERMS = (
    "acceptance criteria",
    "supplier proof points",
    "batch-level qa",
    "measurable tolerances",
    "quality drift",
    "reduces avoidable rework",
    "pilot validation",
    "defect trends",
    "process controls",
    "total landed cost",
    "deviations",
    "corrective actions",
)
FILLER_PHRASES = (
    "powerhouse",
    "revered",
    "ancient superfood",
    "holistic wellness journey",
    "harmonious blend",
    "modern nutritional awareness",
    "unlock the true potential",
)
HEALTH_SOFTEN_REPLACEMENTS = (
    (r"\bboosts immunity\b", "may help support immune function"),
    (r"\breduces inflammation\b", "some evidence suggests it may help support inflammation balance"),
    (r"\bimproves heart health\b", "may help support cardiovascular wellness"),
    (r"\bsupports heart health\b", "may help support cardiovascular wellness"),
    (r"\bantiviral properties\b", "traditionally believed to support antiviral defense"),
    (r"\bsupports cardiovascular health\b", "may contribute to cardiovascular wellness"),
)
HEALTH_TOPIC_TERMS = (
    "oil",
    "ghee",
    "immunity",
    "cholesterol",
    "heart",
    "metabolism",
    "weight",
    "inflammation",
    "nutrition",
    "diet",
)
GENERIC_BRAND_REPLACEMENTS = (
    "a reputable certified brand",
    "a trusted producer",
    "a certified organic option",
)
HEALTH_DISCLAIMER = (
    "This content is for informational purposes only and does not constitute medical advice. "
    "Consult a qualified healthcare professional before making dietary changes."
)


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _slugify(value: str) -> str:
    text = re.sub(r"[^a-zA-Z0-9\s-]", "", str(value or "")).strip().lower()
    text = re.sub(r"[\s_-]+", "-", text).strip("-")
    return text[:90] or "blog"


def _tokenize(value: str) -> list[str]:
    return [t for t in re.findall(r"[a-z0-9]{3,}", str(value or "").lower()) if t not in STOP_WORDS]


def _clean_whitespace(text: str) -> str:
    return re.sub(r"\s+", " ", str(text or "")).strip()


def _domain(url: str) -> str:
    return str(urlparse(str(url or "")).netloc or "").lower().replace("www.", "")


def _resolve_project_root() -> Path:
    return Path(__file__).resolve().parents[5]


def _write_artifacts(run_id: str, competitor_pack: dict[str, Any], outline: dict[str, Any], blog: dict[str, Any]) -> dict[str, str]:
    run_dir = _resolve_project_root() / "storage" / "runs" / str(run_id)
    run_dir.mkdir(parents=True, exist_ok=True)
    competitors_path = run_dir / "competitors.json"
    outline_path = run_dir / "outline.json"
    blog_path = run_dir / "blog.md"
    competitors_path.write_text(json.dumps(competitor_pack, indent=2), encoding="utf-8")
    outline_path.write_text(json.dumps(outline, indent=2), encoding="utf-8")
    blog_path.write_text(str(blog.get("markdown") or ""), encoding="utf-8")
    return {"competitors_json": str(competitors_path), "outline_json": str(outline_path), "blog_markdown": str(blog_path)}


def _classify_url(url: str) -> dict[str, Any]:
    parsed = urlparse(str(url or "").strip())
    host = str(parsed.netloc or "").lower().replace("www.", "")
    path = str(parsed.path or "").lower()
    q = parse_qs(parsed.query or "")
    article_score = 0
    product_score = 0
    hard_exclude = False
    excluded_reason = ""

    if any(host == m or host.endswith(f".{m}") for m in MARKETPLACE_DOMAINS):
        hard_exclude = True
        excluded_reason = "marketplace_domain"
        product_score += 8
    for hint in PRODUCT_PATH_HINTS:
        if hint in path:
            product_score += 4
    for hint in ARTICLE_PATH_HINTS:
        if hint in path:
            article_score += 4
    if "variant" in q:
        product_score += 3
    if "product" in host:
        product_score += 2
    if "blog" in host or "news" in host:
        article_score += 1

    page_type = "unknown"
    if product_score >= article_score + 2:
        page_type = "product"
    elif article_score >= product_score:
        page_type = "article"
    return {
        "page_type": page_type,
        "article_score": int(article_score),
        "product_score": int(product_score),
        "hard_exclude": hard_exclude,
        "excluded_reason": excluded_reason,
    }


def _extract_schema_types(soup: BeautifulSoup) -> set[str]:
    types: set[str] = set()
    for node in soup.find_all("script", attrs={"type": re.compile(r"ld\+json", re.I)}):
        raw = str(node.string or node.get_text() or "").strip()
        if not raw:
            continue
        try:
            parsed = json.loads(raw)
            stack = [parsed]
            while stack:
                cur = stack.pop()
                if isinstance(cur, list):
                    stack.extend(cur)
                    continue
                if not isinstance(cur, dict):
                    continue
                t = cur.get("@type")
                if isinstance(t, list):
                    for item in t:
                        types.add(str(item).lower())
                elif t:
                    types.add(str(t).lower())
                for item in cur.values():
                    if isinstance(item, (dict, list)):
                        stack.append(item)
        except Exception:
            continue
    return types


def _score_page_type_from_html(html: str, base: dict[str, Any]) -> dict[str, Any]:
    soup = BeautifulSoup(str(html or ""), "html.parser")
    lower = str(soup.get_text(" ", strip=True) or "").lower()
    article_score = int(base.get("article_score") or 0)
    product_score = int(base.get("product_score") or 0)
    schema_types = _extract_schema_types(soup)

    if any(t in schema_types for t in ("product", "offer")):
        product_score += 8
    if any(t in schema_types for t in ("article", "blogposting", "newsarticle")):
        article_score += 8

    og_node = soup.find("meta", attrs={"property": re.compile(r"og:type", re.I)})
    og_type = str(og_node.get("content") or "").lower() if og_node else ""
    if "product" in og_type:
        product_score += 5
    if "article" in og_type or "blog" in og_type:
        article_score += 4

    if soup.find("article"):
        article_score += 3
    if soup.find("time"):
        article_score += 2
    if soup.find(attrs={"rel": "author"}) or soup.find(class_=re.compile(r"author", re.I)):
        article_score += 2
    if re.search(r"\b(reading time|published|updated on|table of contents|toc)\b", lower):
        article_score += 2

    if re.search(r"\b(add to cart|buy now|quantity|sku|variant|checkout|in stock)\b", lower):
        product_score += 4
    if re.search(r"(₹|\$|€|£)\s?\d", lower) or re.search(r"\b\d+(\.\d{1,2})?\s?(usd|inr|eur|gbp)\b", lower):
        product_score += 3
    if soup.find("input", attrs={"name": re.compile(r"quantity", re.I)}):
        product_score += 2
    if soup.find(attrs={"class": re.compile(r"product|price|variant|cart", re.I)}):
        product_score += 2

    page_type = "unknown"
    if product_score >= article_score + 2:
        page_type = "product"
    elif article_score >= product_score:
        page_type = "article"
    return {
        "page_type": page_type,
        "article_score": int(article_score),
        "product_score": int(product_score),
        "schema_types": sorted(schema_types),
    }

def _remove_noise_nodes(soup: BeautifulSoup) -> None:
    for node in soup.select("script, style, noscript, svg, canvas, iframe, nav, footer, aside"):
        node.decompose()
    for node in soup.find_all(attrs={"class": re.compile(r"cookie|consent|banner|popup|modal", re.I)}):
        node.decompose()
    for node in soup.find_all(attrs={"id": re.compile(r"cookie|consent|banner|popup|modal", re.I)}):
        node.decompose()


def _best_main_container(soup: BeautifulSoup):
    preferred = ["article", "main", "[role='main']", ".post-content", ".entry-content", ".article-content", ".content", "#content", "#main"]
    for selector in preferred:
        node = soup.select_one(selector)
        if node:
            return node
    best = None
    best_score = -1
    for node in soup.find_all(["div", "section", "article", "main"]):
        text = _clean_whitespace(node.get_text(" ", strip=True))
        if len(text) < 280:
            continue
        score = len(text) + (len(node.find_all("p")) * 120) + (len(node.find_all(["h1", "h2", "h3"])) * 90)
        if score > best_score:
            best_score = score
            best = node
    return best or soup.body or soup


def _extract_headings(container) -> dict[str, list[str]]:
    headings = {"h1": [], "h2": [], "h3": []}
    for level in ("h1", "h2", "h3"):
        seen: set[str] = set()
        for node in container.find_all(level):
            txt = _clean_whitespace(node.get_text(" ", strip=True))
            txt = re.sub(r"^\s*\d{1,2}\s*[\.\):-]?\s*", "", txt).strip()
            if not txt:
                continue
            key = txt.lower()
            if key in seen:
                continue
            seen.add(key)
            headings[level].append(txt)
    return {"h1": headings["h1"][:5], "h2": headings["h2"][:60], "h3": headings["h3"][:80]}


def _extract_facts(container) -> list[str]:
    out: list[str] = []
    for node in container.find_all(["li", "p"]):
        line = _clean_whitespace(node.get_text(" ", strip=True))
        if len(line) < 28 or len(line) > 220:
            continue
        if any(h in line.lower() for h in COOKIE_HINTS):
            continue
        if re.search(r"\d", line) or ":" in line or re.search(r"\b(step|mistake|benefit|checklist|process|how to|important|key)\b", line.lower()):
            out.append(line)
    return list(dict.fromkeys(out))[:40]


def _extract_entities(text: str) -> list[str]:
    counts = Counter(_tokenize(text))
    return [w for w, c in counts.most_common(80) if c >= 2][:30]


def _readability(text: str) -> dict[str, float]:
    sentences = [s.strip() for s in re.split(r"[.!?]+", str(text or "")) if s.strip()]
    words = re.findall(r"\b\w+\b", str(text or ""))
    wc = float(len(words))
    sc = float(max(1, len(sentences)))
    return {"avg_sentence_words": round(wc / sc, 2), "avg_word_length": round((sum(len(w) for w in words) / wc) if wc else 0.0, 2)}


def _guess_tone(text: str) -> str:
    lower = str(text or "").lower()
    if re.search(r"\byou\b|\byour\b", lower):
        return "conversational"
    if re.search(r"\bmust\b|\bshould\b|\brequired\b", lower):
        return "directive"
    if re.search(r"\bdata\b|\bstudy\b|\bresearch\b|\bstat", lower):
        return "analytical"
    return "informational"


def _guess_intent(keyword: str, aggregate_signals: list[str]) -> str:
    joined = f"{str(keyword or '').lower()} {' '.join(aggregate_signals).lower()}"
    if re.search(r"\bprice|cost|buy|supplier|service|quote|company\b", joined):
        return "commercial"
    if re.search(r"\bhow to|steps|process|checklist|tutorial\b", joined):
        return "how-to"
    if re.search(r"\bbook|order|register|get started\b", joined):
        return "transactional"
    return "informational"


def _derive_subtopics(headings: dict[str, list[str]], facts: list[str]) -> list[str]:
    candidates = [*headings.get("h2", []), *headings.get("h3", [])]
    if len(candidates) < 12:
        candidates.extend([f.split(":")[0].strip() for f in facts if ":" in f][:12])
    out: list[str] = []
    seen: set[str] = set()
    for item in candidates:
        value = _clean_whitespace(item)
        if len(value) < 4:
            continue
        key = re.sub(r"[^a-z0-9]+", " ", value.lower()).strip()
        if not key or key in seen:
            continue
        seen.add(key)
        out.append(value)
    return out[:30]


def _build_per_url_summary(url: str, html: str, max_chars: int, page_type_meta: dict[str, Any]) -> dict[str, Any]:
    soup = BeautifulSoup(str(html or ""), "html.parser")
    _remove_noise_nodes(soup)
    container = _best_main_container(soup)
    title = _clean_whitespace((soup.title.string if soup.title and soup.title.string else "") or "")
    headings = _extract_headings(container)
    facts = _extract_facts(container)
    raw_text = _clean_whitespace(container.get_text(" ", strip=True))
    cleaned_text = "\n".join(list(dict.fromkeys([_clean_whitespace(x) for x in re.split(r"\n+", raw_text) if _clean_whitespace(x)])))
    if len(cleaned_text) > max_chars:
        cleaned_text = cleaned_text[:max_chars]

    page_type = str(page_type_meta.get("page_type") or "unknown")
    if page_type == "product":
        cleaned_text = cleaned_text[: min(2200, max_chars)]
        facts = facts[:8]

    entities = _extract_entities(cleaned_text)
    subtopics = _derive_subtopics(headings, facts)
    return {
        "url": url,
        "domain": _domain(url),
        "status": "ok",
        "page_type": page_type,
        "article_score": int(page_type_meta.get("article_score") or 0),
        "product_score": int(page_type_meta.get("product_score") or 0),
        "excluded_reason": str(page_type_meta.get("excluded_reason") or ""),
        "title": title,
        "headings": headings,
        "subtopics": subtopics,
        "facts_claims": facts[:30],
        "entities_terms": entities,
        "content_length": {"chars": len(cleaned_text), "words": len(re.findall(r"\b\w+\b", cleaned_text))},
        "readability": _readability(cleaned_text),
        "tone": _guess_tone(cleaned_text),
        "signals": {
            "has_table": bool(container.find_all("table")),
            "faq_count": len([h for h in subtopics if "?" in h]) + len([f for f in facts if "?" in f]),
            "has_examples": any(re.search(r"\bexample|for instance|case\b", f.lower()) for f in facts),
        },
        "cleaned_text": cleaned_text,
    }


def _build_aggregate(keyword: str, pages: list[dict[str, Any]], failed: list[dict[str, Any]]) -> dict[str, Any]:
    subtopic_counter: Counter[str] = Counter()
    title_words: Counter[str] = Counter()
    all_facts: list[str] = []
    all_entities: Counter[str] = Counter()
    tones: Counter[str] = Counter()
    word_counts: list[int] = []
    coverage_matrix: dict[str, list[str]] = {}

    for page in pages:
        url = str(page.get("url") or "")
        tones.update([str(page.get("tone") or "informational")])
        words = int(page.get("content_length", {}).get("words") or 0)
        if words > 0:
            word_counts.append(words)
        for term in _tokenize(str(page.get("title") or "")):
            title_words.update([term])
        for fact in page.get("facts_claims", []) or []:
            all_facts.append(str(fact))
        for entity in page.get("entities_terms", []) or []:
            all_entities.update([str(entity)])
        for subtopic in page.get("subtopics", []) or []:
            normalized = _clean_whitespace(str(subtopic))
            if not normalized:
                continue
            subtopic_counter.update([normalized])
            coverage_matrix.setdefault(normalized, []).append(url)

    common_sections = [topic for topic, count in subtopic_counter.most_common(20) if count >= 2]
    gaps = [topic for topic, count in subtopic_counter.most_common(30) if count == 1]
    median_words = sorted(word_counts)[len(word_counts) // 2] if word_counts else 1200
    rec_min = max(900, min(3500, int(median_words * 1.15)))
    rec_max = max(rec_min + 200, min(4200, int(median_words * 1.45)))
    return {
        "keyword": keyword,
        "pages_processed": len(pages),
        "pages_failed": len(failed),
        "common_sections": common_sections[:15],
        "gaps_missing_subtopics": gaps[:12],
        "coverage_matrix": {k: sorted(v) for k, v in coverage_matrix.items()},
        "recurring_points": list(dict.fromkeys(all_facts))[:25],
        "unique_angles": [f"{k} (only in {_domain(v[0])})" for k, v in coverage_matrix.items() if len(v) == 1][:15],
        "intent_fit_recommended": _guess_intent(keyword, common_sections + gaps),
        "recommended_word_count_range": {"min": rec_min, "max": rec_max},
        "tone_distribution": dict(tones),
        "top_title_terms": [term for term, _ in title_words.most_common(20)],
        "top_entities": [term for term, _ in all_entities.most_common(30)],
    }

async def _fetch_via_opencrawl(url: str, *, api_url: str, api_key: str, timeout_seconds: int) -> tuple[bool, str, str]:
    base = str(api_url or "").strip().rstrip("/")
    if not base:
        return False, "", "opencrawl_api_url_missing"
    if base.endswith("/search"):
        root = base[: -len("/search")]
        endpoints = [f"{root}/extract", f"{root}/fetch", f"{root}/page"]
    else:
        endpoints = [f"{base}/extract", f"{base}/fetch", f"{base}/page"]

    headers = {"Content-Type": "application/json", "User-Agent": "ContentOpsAI/1.0"}
    if api_key:
        headers["Authorization"] = f"Bearer {api_key}"
    payloads = [{"url": url, "mode": "extract"}, {"url": url, "extract": True}, {"target_url": url}]

    timeout = httpx.Timeout(connect=10.0, read=float(max(10, timeout_seconds)), write=30.0, pool=10.0)
    async with httpx.AsyncClient(timeout=timeout, follow_redirects=True) as client:
        last_error = "opencrawl_fetch_failed"
        for endpoint in endpoints:
            for payload in payloads:
                try:
                    def _factory() -> httpx.Request:
                        return client.build_request("POST", endpoint, headers=headers, json=payload)
                    resp = await request_with_retries(_factory, client, retries=2, backoff_base=0.6)
                    if int(resp.status_code or 0) >= 400:
                        last_error = f"http_{int(resp.status_code or 0)}"
                        continue
                    data = resp.json() if resp.content else {}
                    html = ""
                    if isinstance(data, dict):
                        if data.get("ok") is False:
                            last_error = str(data.get("error") or "provider_error")
                            continue
                        html = str(data.get("html") or data.get("raw_html") or data.get("content_html") or data.get("content") or "")
                    if html:
                        return True, html, ""
                    last_error = "empty_response"
                except Exception as exc:
                    last_error = f"request_failed:{exc}"
                    continue
        return False, "", last_error


def _parse_json_response(raw: str) -> dict[str, Any]:
    text = str(raw or "").strip()
    if not text:
        return {}
    options = [text]
    fenced = re.search(r"```(?:json)?\s*(\{.*?\})\s*```", text, flags=re.IGNORECASE | re.DOTALL)
    if fenced:
        options.insert(0, fenced.group(1).strip())
    start = text.find("{")
    end = text.rfind("}")
    if start >= 0 and end > start:
        options.append(text[start : end + 1])
    for option in options:
        try:
            parsed = json.loads(option)
            if isinstance(parsed, dict):
                return parsed
        except Exception:
            continue
    return {}


def _build_generation_prompt(keyword: str, aggregate: dict[str, Any], page_signals: list[dict[str, Any]], brand_voice: str | None, target_audience: str | None, locale: str | None) -> str:
    signal_rows = []
    for page in page_signals:
        signal_rows.append({
            "domain": page.get("domain"),
            "title": page.get("title"),
            "h2": (page.get("headings", {}) or {}).get("h2", [])[:10],
            "h3": (page.get("headings", {}) or {}).get("h3", [])[:14],
            "subtopics": page.get("subtopics", [])[:16],
            "facts_claims": page.get("facts_claims", [])[:10],
            "signals": page.get("signals", {}),
            "words": page.get("content_length", {}).get("words"),
            "readability": page.get("readability", {}),
            "tone": page.get("tone"),
        })
    compact = json.dumps({
        "keyword": keyword,
        "locale": locale or "en-US",
        "brand_voice": brand_voice or "clear, practical, expert",
        "target_audience": target_audience or "decision-making readers",
        "aggregate": aggregate,
        "competitor_signals": signal_rows,
    }, ensure_ascii=True)
    return (
        "Generate a high-quality original blog from extracted competitor signals only.\n"
        "Rules:\n"
        "- Do not mention SERP/rankings/Google/search-results.\n"
        "- No plagiarism.\n"
        "- Keep tone specific and practical; avoid generic filler language.\n"
        "- Do not output UI badges: Decision-ready, Reader-first, Execution-focused.\n"
        "- Do not output lines starting with Action sprint.\n"
        "- Do not output heading numeric prefixes like 01/02.\n"
        "- Output exactly one FAQ section.\n"
        "- Do not mention competitor brand names in final body.\n"
        "- Avoid manufacturing/operations jargon in FAQ unless topic is explicitly manufacturing.\n"
        "- Include buyer-intent coverage: comparison, authenticity checks, usage guidance, storage, and safety notes.\n"
        "- Use health language cautiously (may help / traditionally believed / some evidence suggests).\n"
        "- Never output templating syntax: {{...}} or {%...%}.\n"
        "- Return strict JSON keys only: title_options(5), chosen_title, slug, meta_title, meta_description, winning_outline, markdown, faq, faq_schema_jsonld.\n"
        f"Input signals:\n{compact}"
    )


def _sanitize_generated_markdown(markdown: str) -> str:
    text = str(markdown or "")
    text = re.sub(r"\{\{[^{}]*\}\}", "", text)
    text = re.sub(r"\{%\s*[^%]*%\}", "", text)
    out: list[str] = []
    faq_seen = False
    for raw in text.splitlines():
        line = str(raw or "")
        lower = line.lower()
        if any(term in lower for term in BADGE_TERMS):
            continue
        if re.match(r"^\s*action\s+sprint\s*:", lower):
            continue
        m = re.match(r"^(\s{0,3}#{1,6}\s+)(.*)$", line)
        if m:
            content = re.sub(r"^\s*\d{1,2}\s*[\.\):-]?\s*", "", m.group(2)).strip()
            if not content:
                continue
            norm = re.sub(r"[^a-z0-9]+", " ", content.lower()).strip()
            if norm.startswith("frequently asked questions") or norm in {"faq", "faqs"}:
                if faq_seen:
                    continue
                faq_seen = True
            out.append(f"{m.group(1)}{content}")
            continue
        out.append(line)
    return re.sub(r"\n{3,}", "\n\n", "\n".join(out)).strip()


def _sentence_count(text: str) -> int:
    return len([s for s in re.split(r"[.!?]+", str(text or "")) if s.strip()])


def _domain_labels(host: str) -> list[str]:
    raw = str(host or "").lower().replace("www.", "").strip()
    if not raw:
        return []
    parts = [p for p in re.split(r"[.\-]+", raw) if p]
    tld_noise = {"com", "in", "org", "net", "co", "io", "ai", "shop", "store", "online", "biz"}
    return [p for p in parts if len(p) >= 3 and p not in tld_noise]


def _collect_forbidden_brand_terms(pages: list[dict[str, Any]], allowed_domain: str) -> set[str]:
    allow = set(_domain_labels(allowed_domain))
    banned: set[str] = set()
    for page in pages:
        for label in _domain_labels(page.get("domain") or ""):
            if label not in allow:
                banned.add(label)
        title = str(page.get("title") or "")
        for token in re.findall(r"\b[A-Z][a-zA-Z]{2,}\b", title):
            t = token.lower()
            if t not in allow and t not in STOP_WORDS:
                banned.add(t)
    return {x for x in banned if len(x) >= 3}


def _neutralize_brand_mentions(markdown: str, forbidden_terms: set[str]) -> str:
    text = str(markdown or "")
    if not text or not forbidden_terms:
        return text
    idx = 0
    for term in sorted(forbidden_terms, key=len, reverse=True):
        replacement = GENERIC_BRAND_REPLACEMENTS[idx % len(GENERIC_BRAND_REPLACEMENTS)]
        idx += 1
        text = re.sub(rf"\b{re.escape(term)}\b", replacement, text, flags=re.IGNORECASE)
    return text


def _soften_health_claims(markdown: str) -> str:
    text = str(markdown or "")
    for pattern, replacement in HEALTH_SOFTEN_REPLACEMENTS:
        text = re.sub(pattern, replacement, text, flags=re.IGNORECASE)
    return text


def _ensure_safety_line(markdown: str) -> str:
    text = str(markdown or "").strip()
    if HEALTH_DISCLAIMER.lower() in text.lower():
        return text
    return f"{text}\n\n{HEALTH_DISCLAIMER}".strip()


def _is_health_topic(keyword: str, markdown: str) -> bool:
    joined = f"{str(keyword or '').lower()} {str(markdown or '').lower()}"
    return any(term in joined for term in HEALTH_TOPIC_TERMS)


def _has_case_study_evidence(markdown: str) -> bool:
    text = str(markdown or "")
    if not text.strip():
        return False
    metrics = bool(re.search(r"\b(\d{1,3}%|\d+(?:\.\d+)?\s*(?:days|weeks|months|years|participants|samples|patients|users))\b", text, flags=re.IGNORECASE))
    study_words = bool(re.search(r"\b(sample size|dataset|trial|experiment|measured|baseline|follow-up|cohort|statistically)\b", text, flags=re.IGNORECASE))
    return metrics and study_words


def _fix_misleading_case_study_title(title: str, keyword: str, markdown: str) -> str:
    current = _clean_whitespace(title)
    if "case study" not in current.lower():
        return current
    if _has_case_study_evidence(markdown):
        return current
    topic = _clean_whitespace(keyword) or "Topic"
    return f"{topic}: Preparation, Benefits, Uses, and Buying Guide"


def _extract_h2_titles(markdown: str) -> list[str]:
    out: list[str] = []
    for line in str(markdown or "").splitlines():
        m = re.match(r"^\s*##\s+(.+?)\s*$", line)
        if not m:
            continue
        title = re.sub(r"[^a-z0-9]+", " ", m.group(1).lower()).strip()
        if title:
            out.append(title)
    return out


def _dedupe_h2_sections(markdown: str) -> str:
    lines = str(markdown or "").splitlines()
    out: list[str] = []
    seen: set[str] = set()
    skip = False
    for line in lines:
        m = re.match(r"^\s*##\s+(.+?)\s*$", line)
        if m:
            key = re.sub(r"[^a-z0-9]+", " ", m.group(1).lower()).strip()
            if key in seen:
                skip = True
                continue
            seen.add(key)
            skip = False
            out.append(line)
            continue
        if re.match(r"^\s*#\s+.+$", line):
            skip = False
            out.append(line)
            continue
        if not skip:
            out.append(line)
    return re.sub(r"\n{3,}", "\n\n", "\n".join(out)).strip()


def _remove_lead_magnet_ctas(markdown: str) -> str:
    out: list[str] = []
    for line in str(markdown or "").splitlines():
        low = line.lower()
        if "download checklist" in low or "download workflow" in low or "download the checklist" in low:
            continue
        out.append(line)
    return "\n".join(out).strip()


def _contains_faq_contamination(faq: list[dict[str, str]]) -> bool:
    for row in faq:
        answer = str(row.get("answer") or "").lower()
        if any(term in answer for term in FAQ_CONTAMINATION_TERMS):
            return True
    return False


def _normalize_faq_list(faq: list[dict[str, Any]], keyword: str) -> list[dict[str, str]]:
    out: list[dict[str, str]] = []
    seen: set[str] = set()
    for row in faq:
        if not isinstance(row, dict):
            continue
        q = _clean_whitespace(str(row.get("question") or ""))
        a = _clean_whitespace(str(row.get("answer") or ""))
        if not q or not a:
            continue
        key = re.sub(r"[^a-z0-9]+", " ", q.lower()).strip()
        if key in seen:
            continue
        seen.add(key)
        sc = _sentence_count(a)
        if sc < 2:
            a = f"{a}. In practical use, compare quality indicators, sourcing transparency, and fit for your daily routine."
        if sc > 4:
            parts = [p.strip() for p in re.split(r"(?<=[.!?])\s+", a) if p.strip()]
            a = " ".join(parts[:4]).strip()
        # Ensure answer directly responds to the question by carrying core question terms.
        q_terms = [t for t in re.findall(r"[a-z0-9]{3,}", q.lower()) if t not in STOP_WORDS][:3]
        if q_terms and not any(t in a.lower() for t in q_terms):
            a = f"{a} For {keyword}, this specifically addresses {' / '.join(q_terms)}."
        if not re.search(rf"\b{re.escape(str(keyword or '').lower())}\b", a.lower()) and len(str(keyword or "")) >= 3:
            a = f"{a} This is relevant when evaluating {keyword} options."
        out.append({"question": q.rstrip("?") + "?", "answer": a})
    if not out:
        seed = str(keyword or "this topic")
        out = [
            {
                "question": f"What should I compare before buying {seed}?",
                "answer": f"Compare sourcing transparency, processing method, and cost per serving for {seed}. Review label clarity and independent quality checks before purchase.",
            },
            {
                "question": f"How can I verify authenticity for {seed}?",
                "answer": f"Check origin disclosures, batch or certification details, and consistency in ingredient labeling. Prefer sellers that provide traceability and clear quality documentation.",
            },
            {
                "question": f"How much {seed} should be used daily?",
                "answer": f"Daily intake should be moderated based on diet goals and total calorie needs. Start with small portions and adjust gradually based on tolerance and guidance from a qualified professional.",
            },
            {
                "question": f"How should {seed} be stored?",
                "answer": f"Store in an airtight container away from direct sunlight, moisture, and excess heat. Use a dry spoon to preserve freshness and avoid contamination.",
            },
            {
                "question": f"Who should avoid or limit {seed}?",
                "answer": f"People with specific medical conditions, dietary restrictions, or intolerance symptoms should use caution. Consult a qualified clinician for personalized guidance before regular use.",
            },
        ]
    return out[:8]


def _strip_all_faq_from_markdown(markdown: str) -> str:
    lines = str(markdown or "").splitlines()
    out: list[str] = []
    skip = False
    for line in lines:
        l = line.strip().lower()
        if re.match(r"^\s*##\s+", line):
            heading = re.sub(r"^\s*##\s+", "", line).strip().lower()
            if heading.startswith("frequently asked questions") or heading in {"faq", "faqs", "faq section"}:
                skip = True
                continue
            skip = False
            out.append(line)
            continue
        if skip:
            continue
        # remove html accordion residue if present
        if "<details" in l or "</details>" in l or "<summary" in l or "</summary>" in l:
            continue
        out.append(line)
    return re.sub(r"\n{3,}", "\n\n", "\n".join(out)).strip()


def _append_single_faq_block(markdown: str, faq: list[dict[str, str]]) -> str:
    base = _strip_all_faq_from_markdown(markdown).strip()
    if not faq:
        return base
    block = ["## Frequently Asked Questions"]
    for row in faq:
        block.append(f"### {row['question']}")
        block.append(str(row["answer"]))
        block.append("")
    return re.sub(r"\n{3,}", "\n\n", f"{base}\n\n" + "\n".join(block).strip()).strip()


def _insert_before_conclusion(markdown: str, section_markdown: str) -> str:
    lines = str(markdown or "").splitlines()
    insert_at = None
    for i, line in enumerate(lines):
        m = re.match(r"^\s*##\s+(.+?)\s*$", line)
        if not m:
            continue
        heading = m.group(1).strip().lower()
        if heading.startswith("conclusion"):
            insert_at = i
            break
    if insert_at is None:
        return re.sub(r"\n{3,}", "\n\n", f"{markdown.strip()}\n\n{section_markdown.strip()}").strip()
    merged = lines[:insert_at] + ["", section_markdown.strip(), ""] + lines[insert_at:]
    return re.sub(r"\n{3,}", "\n\n", "\n".join(merged)).strip()


def _ensure_buyer_intent_layer(markdown: str, keyword: str) -> str:
    text = str(markdown or "")
    h2 = " ".join(_extract_h2_titles(text))
    kw = str(keyword or "this topic")
    sections: list[str] = []
    if "vs" not in h2 and "comparison" not in h2:
        sections.append(
            f"## {kw} vs Regular Alternatives\n"
            f"- Compare sourcing, processing method, taste profile, and pricing transparency.\n"
            f"- Check label claims against independent certifications and batch information.\n"
            f"- Evaluate value per serving, not just package price."
        )
    if "authentic" not in h2 and "verify" not in h2:
        sections.append(
            f"## How to Verify Authenticity\n"
            f"- Review source disclosures, extraction method, and testing/certification notes.\n"
            f"- Avoid products with vague origin claims or inconsistent labeling.\n"
            f"- Prefer suppliers that provide clear traceability and quality documentation."
        )
    if "daily intake" not in h2 and "how to use" not in h2:
        sections.append(
            f"## How to Use It Daily\n"
            f"- Start with small servings and monitor tolerance.\n"
            f"- Use measured portions in meals rather than untracked additions.\n"
            f"- Align usage with your dietary goals and total calorie intake."
        )
    if "storage" not in h2:
        sections.append(
            "## Storage Guidance\n"
            "- Keep in an airtight container away from heat, moisture, and direct sunlight.\n"
            "- Use a dry spoon to avoid contamination and flavor degradation.\n"
            "- Check aroma and texture periodically before use."
        )
    if "who should avoid" not in h2 and "safety" not in h2:
        sections.append(
            f"## Who Should Avoid or Limit Use\n"
            f"- People with specific medical conditions or dietary restrictions should consult a qualified clinician.\n"
            f"- If you notice intolerance symptoms, reduce intake and seek professional guidance.\n"
            f"- Children, pregnant individuals, and elderly readers should follow individualized dietary advice."
        )
    for section in sections:
        text = _insert_before_conclusion(text, section)
    return text


def _filler_density(markdown: str) -> float:
    text = str(markdown or "").lower()
    if not text:
        return 0.0
    words = max(1, len(re.findall(r"\b\w+\b", text)))
    hits = sum(len(re.findall(re.escape(p), text, flags=re.IGNORECASE)) for p in FILLER_PHRASES)
    return hits / words


def _rewrite_filler_paragraphs(markdown: str, keyword: str) -> str:
    blocks = re.split(r"\n\s*\n", str(markdown or ""))
    out: list[str] = []
    for block in blocks:
        b = str(block or "").strip()
        if not b:
            continue
        lower = b.lower()
        hit_count = sum(1 for p in FILLER_PHRASES if p in lower)
        if hit_count >= 2 and not b.lstrip().startswith("#"):
            out.append(
                f"For {keyword}, focus on verifiable factors: source quality, processing method, storage, serving guidance, and cost-per-use. "
                "Use specific checks and practical comparisons instead of broad promotional language."
            )
            continue
        out.append(b)
    return re.sub(r"\n{3,}", "\n\n", "\n\n".join(out)).strip()


def _build_faq_only_prompt(keyword: str, aggregate: dict[str, Any], locale: str | None, audience: str | None) -> str:
    compact = json.dumps(
        {
            "keyword": keyword,
            "locale": locale or "en-US",
            "target_audience": audience or "buyers",
            "common_sections": aggregate.get("common_sections", [])[:12],
            "gaps": aggregate.get("gaps_missing_subtopics", [])[:10],
        },
        ensure_ascii=True,
    )
    return (
        "Generate FAQ only as strict JSON object with key faq (array of 5-8 items).\n"
        "Each item keys: question, answer.\n"
        "Rules:\n"
        "- Answers must be 2-4 sentences.\n"
        "- Topic-specific and buyer-intent focused.\n"
        "- No manufacturing/operations jargon.\n"
        "- Do not use these phrases: acceptance criteria, supplier proof points, batch-level QA, measurable tolerances, quality drift, "
        "reduces avoidable rework, pilot validation, defect trends, process controls, total landed cost.\n"
        f"Context:\n{compact}"
    )


async def _regenerate_faq_only(
    provider: OpenAIProvider,
    keyword: str,
    aggregate: dict[str, Any],
    locale: str | None,
    target_audience: str | None,
) -> list[dict[str, str]]:
    raw = await provider.generate_text(_build_faq_only_prompt(keyword, aggregate, locale, target_audience))
    parsed = _parse_json_response(raw.text)
    faq = parsed.get("faq") if isinstance(parsed.get("faq"), list) else []
    return _normalize_faq_list(faq, keyword)


def _fallback_blog(keyword: str, aggregate: dict[str, Any]) -> dict[str, Any]:
    title = f"{keyword}: Complete Practical Guide"
    sections = aggregate.get("common_sections", [])[:6] or ["Overview", "Core Process", "Common Mistakes", "Checklist", "FAQ"]
    faq = [
        {"question": f"What is {keyword}?", "answer": f"{keyword} refers to a structured approach explained in this guide."},
        {"question": f"How do I start with {keyword}?", "answer": "Start with your objective, constraints, and a stepwise implementation plan."},
        {"question": "What are common mistakes?", "answer": "Skipping planning, unclear metrics, and weak execution consistency are common pitfalls."},
        {"question": "How long does it take?", "answer": "Timeline depends on scope, but a phased rollout usually works best."},
        {"question": "How do I measure outcomes?", "answer": "Track baseline metrics, interim progress, and final outcome quality."},
    ]
    markdown = _sanitize_generated_markdown(
        f"# {title}\n\nThis guide provides practical, complete coverage of the topic.\n\n"
        "## What You Will Learn\n" + "\n".join([f"- {s}" for s in sections]) +
        "\n\n## Step-by-Step Approach\n"
        "1. Define your goal and constraints.\n2. Compare options.\n3. Implement with measurable outcomes.\n4. Review and improve.\n\n"
        "[Internal Link: related-topic]\n"
    )
    return {
        "title_options": [title],
        "chosen_title": title,
        "slug": _slugify(title),
        "meta_title": title[:60],
        "meta_description": f"Practical guide to {keyword} with steps, examples, and FAQs."[:155],
        "winning_outline": {"h2": [{"title": s, "h3": []} for s in sections]},
        "markdown": markdown,
        "faq": faq,
        "faq_schema_jsonld": {
            "@context": "https://schema.org",
            "@type": "FAQPage",
            "mainEntity": [{"@type": "Question", "name": i["question"], "acceptedAnswer": {"@type": "Answer", "text": i["answer"]}} for i in faq],
        },
    }


async def _generate_blog_from_signals(
    keyword: str,
    aggregate: dict[str, Any],
    pages: list[dict[str, Any]],
    *,
    brand_voice: str | None,
    target_audience: str | None,
    locale: str | None,
    openai_api_key: str | None,
    openai_model: str | None,
    project_base_url: str | None = None,
    lead_magnets_enabled: bool = False,
) -> dict[str, Any]:
    provider = OpenAIProvider(api_key=openai_api_key, model=openai_model)
    if not provider.enabled:
        return _fallback_blog(keyword, aggregate)

    parsed = _parse_json_response((await provider.generate_text(_build_generation_prompt(keyword, aggregate, pages, brand_voice, target_audience, locale))).text)
    if not parsed:
        return _fallback_blog(keyword, aggregate)

    chosen_title = str(parsed.get("chosen_title") or keyword).strip()
    faq = parsed.get("faq") if isinstance(parsed.get("faq"), list) else []
    faq = _normalize_faq_list(faq, keyword)
    faq_contaminated = _contains_faq_contamination(faq)
    if faq_contaminated:
        # Remove model-provided FAQ block entirely before rebuilding clean FAQ.
        parsed_markdown = _strip_all_faq_from_markdown(str(parsed.get("markdown") or ""))
        parsed["markdown"] = parsed_markdown
        try:
            faq = await _regenerate_faq_only(provider, keyword, aggregate, locale, target_audience)
        except Exception:
            faq = _normalize_faq_list([], keyword)
    faq = _normalize_faq_list(faq, keyword)

    faq_schema = parsed.get("faq_schema_jsonld") if isinstance(parsed.get("faq_schema_jsonld"), dict) else {
        "@context": "https://schema.org",
        "@type": "FAQPage",
        "mainEntity": [{"@type": "Question", "name": str(i.get("question") or ""), "acceptedAnswer": {"@type": "Answer", "text": str(i.get("answer") or "")}} for i in faq if isinstance(i, dict)],
    }
    markdown = _sanitize_generated_markdown(str(parsed.get("markdown") or ""))
    if not markdown:
        return _fallback_blog(keyword, aggregate)

    # Post-generation quality layer.
    allowed_domain = _domain(project_base_url or "")
    forbidden_brands = _collect_forbidden_brand_terms(pages, allowed_domain)
    markdown = _neutralize_brand_mentions(markdown, forbidden_brands)
    is_health = _is_health_topic(keyword, markdown)
    if is_health:
        markdown = _soften_health_claims(markdown)
    markdown = _ensure_buyer_intent_layer(markdown, keyword)
    markdown = _append_single_faq_block(markdown, faq)
    markdown = _dedupe_h2_sections(markdown)
    markdown = _sanitize_generated_markdown(markdown)
    if not lead_magnets_enabled:
        markdown = _remove_lead_magnet_ctas(markdown)
    if _filler_density(markdown) > 0.012:
        markdown = _rewrite_filler_paragraphs(markdown, keyword)
    if is_health:
        markdown = _ensure_safety_line(markdown)

    chosen_title = _fix_misleading_case_study_title(chosen_title, keyword, markdown)

    faq = _normalize_faq_list(faq, keyword)
    return {
        "title_options": (parsed.get("title_options") if isinstance(parsed.get("title_options"), list) else [chosen_title])[:5],
        "chosen_title": chosen_title,
        "slug": str(parsed.get("slug") or _slugify(chosen_title)),
        "meta_title": str(_fix_misleading_case_study_title(str(parsed.get("meta_title") or chosen_title), keyword, markdown))[:70],
        "meta_description": str(parsed.get("meta_description") or f"Complete guide to {keyword}.")[:180],
        "winning_outline": parsed.get("winning_outline") if isinstance(parsed.get("winning_outline"), dict) else {"h2": []},
        "markdown": markdown,
        "faq": faq[:8],
        "faq_schema_jsonld": faq_schema,
    }

async def compose_from_competitors(
    *,
    keyword: str,
    competitor_urls: list[str],
    brand_voice: str | None = None,
    target_audience: str | None = None,
    locale: str | None = None,
    run_id: str | None = None,
    project_base_url: str | None = None,
    lead_magnets_enabled: bool = False,
    openai_api_key: str | None = None,
    openai_model: str | None = None,
    opencrawl_api_url: str | None = None,
    opencrawl_api_key: str | None = None,
) -> dict[str, Any]:
    settings = get_settings()
    max_pages = max(1, int(settings.max_competitor_pages or 10))
    max_extract_chars = max(1000, int(settings.max_extract_chars or 40000))
    total_timeout = max(10, int(settings.total_fetch_timeout or 60))

    clean_keyword = _clean_whitespace(keyword)
    candidates: list[dict[str, Any]] = []
    seen: set[str] = set()
    for raw in competitor_urls or []:
        url = str(raw or "").strip()
        if not url.startswith("http"):
            continue
        norm = url.rstrip("/")
        if norm.lower() in seen:
            continue
        seen.add(norm.lower())
        base_cls = _classify_url(norm)
        row = {
            "url": norm,
            "status": "queued",
            "page_type": base_cls["page_type"],
            "article_score": base_cls["article_score"],
            "product_score": base_cls["product_score"],
            "excluded_reason": base_cls["excluded_reason"],
            "domain": _domain(norm),
        }
        if base_cls["hard_exclude"]:
            row["status"] = "excluded"
            candidates.append(row)
            continue
        candidates.append(row)
        if len([c for c in candidates if c.get("status") != "excluded"]) >= max_pages:
            break

    pages: list[dict[str, Any]] = []
    failed: list[dict[str, Any]] = []
    chars_total = 0
    timeout_hit = False
    started = time.monotonic()
    crawl_api = str(opencrawl_api_url or settings.opencrawl_api_url or "").strip()
    crawl_key = str(opencrawl_api_key or settings.opencrawl_api_key or "").strip()
    product_reference_added = False

    for candidate in candidates:
        if candidate.get("status") == "excluded":
            failed.append(candidate)
            continue
        url = str(candidate.get("url") or "")
        remaining = total_timeout - int(time.monotonic() - started)
        if remaining <= 0:
            timeout_hit = True
            failed.append({**candidate, "status": "failed", "excluded_reason": "total_fetch_timeout_hit"})
            continue
        try:
            ok, html, err = await asyncio.wait_for(
                _fetch_via_opencrawl(url, api_url=crawl_api, api_key=crawl_key, timeout_seconds=remaining),
                timeout=float(max(3, remaining)),
            )
            if not ok or not html:
                failed.append({**candidate, "status": "failed", "excluded_reason": err or "fetch_failed"})
                continue
            html_cls = _score_page_type_from_html(html, candidate)
            per = _build_per_url_summary(url, html, max_extract_chars, {**candidate, **html_cls})

            if per["page_type"] == "product":
                if product_reference_added:
                    per["excluded_reason"] = "product_page_filtered"
                    per["status"] = "excluded"
                    failed.append(per)
                    continue
                product_reference_added = True
                per["excluded_reason"] = "product_reference_only"

            pages.append(per)
            chars_total += int(per.get("content_length", {}).get("chars") or 0)
        except asyncio.TimeoutError:
            failed.append({**candidate, "status": "failed", "excluded_reason": "timeout"})
        except Exception as exc:
            failed.append({**candidate, "status": "failed", "excluded_reason": f"unexpected:{exc}"})

    pages_sorted = sorted(pages, key=lambda x: (int(x.get("article_score") or 0), -int(x.get("product_score") or 0)), reverse=True)
    synthesis_pages = [p for p in pages_sorted if p.get("page_type") != "product"][:max_pages]
    pricing_reference_pages = [p for p in pages_sorted if p.get("page_type") == "product"][:1]

    aggregate = _build_aggregate(clean_keyword, synthesis_pages, failed)
    competitor_pack = {
        "urls": synthesis_pages + pricing_reference_pages + failed,
        "aggregate": aggregate,
        "synthesis_pages": [p.get("url") for p in synthesis_pages],
        "pricing_reference_pages": [p.get("url") for p in pricing_reference_pages],
    }

    generated = await _generate_blog_from_signals(
        clean_keyword,
        aggregate,
        synthesis_pages,
        brand_voice=brand_voice,
        target_audience=target_audience,
        locale=locale,
        project_base_url=project_base_url,
        lead_magnets_enabled=bool(lead_magnets_enabled),
        openai_api_key=openai_api_key or settings.openai_api_key,
        openai_model=openai_model or settings.openai_model,
    )

    winning_outline = generated.get("winning_outline") if isinstance(generated.get("winning_outline"), dict) else {"h2": []}
    blog = {
        "title": str(generated.get("chosen_title") or clean_keyword),
        "slug": str(generated.get("slug") or _slugify(clean_keyword)),
        "meta_title": str(generated.get("meta_title") or generated.get("chosen_title") or clean_keyword),
        "meta_description": str(generated.get("meta_description") or f"Comprehensive guide to {clean_keyword}."),
        "markdown": _sanitize_generated_markdown(str(generated.get("markdown") or "")),
        "faq": generated.get("faq") if isinstance(generated.get("faq"), list) else [],
        "faq_schema_jsonld": generated.get("faq_schema_jsonld") if isinstance(generated.get("faq_schema_jsonld"), dict) else {},
        "title_options": generated.get("title_options") if isinstance(generated.get("title_options"), list) else [],
    }

    effective_run_id = str(run_id or f"competitor-compose-{int(time.time())}")
    artifacts = _write_artifacts(effective_run_id, competitor_pack, winning_outline, blog)
    return {
        "keyword": clean_keyword,
        "competitor_pack": competitor_pack,
        "winning_outline": winning_outline,
        "blog": blog,
        "debug": {
            "run_id": effective_run_id,
            "pages_processed": len(synthesis_pages),
            "pages_failed": len(failed),
            "chars_extracted_total": chars_total,
            "timeout_hit": timeout_hit,
            "generated_at": _now_iso(),
            "artifacts": artifacts,
        },
    }
