from __future__ import annotations

from datetime import datetime, timezone
import os
from typing import Any
import base64
from urllib.parse import parse_qs, quote_plus, unquote, urlparse

import httpx
from bs4 import BeautifulSoup
from fastapi import FastAPI
from pydantic import BaseModel


app = FastAPI(title="Local OpenCrawl Stub", version="1.0.0")

BLOCKED = {
    "bing.com",
    "duckduckgo.com",
    "google.com",
    "youtube.com",
    "facebook.com",
    "instagram.com",
    "linkedin.com",
    "pinterest.com",
    "reddit.com",
    "wikipedia.org",
    "zhidao.baidu.com",
    "baidu.com",
}


class SearchPayload(BaseModel):
    query: str | None = None
    keyword: str | None = None
    limit: int | None = 10
    country: str | None = "in"
    language: str | None = "en"


def _sanitize_ssl_env() -> None:
    cert_file = os.environ.get("SSL_CERT_FILE")
    if cert_file and not os.path.exists(cert_file):
        os.environ.pop("SSL_CERT_FILE", None)
    cert_dir = os.environ.get("SSL_CERT_DIR")
    if cert_dir and not os.path.exists(cert_dir):
        os.environ.pop("SSL_CERT_DIR", None)


def _norm_url(value: str) -> str:
    raw = str(value or "").strip()
    if not raw.startswith("http://") and not raw.startswith("https://"):
        return ""
    parsed = urlparse(raw)
    host = (parsed.netloc or "").lower().replace("www.", "")
    if not host:
        return ""
    path = parsed.path or "/"
    out = f"{parsed.scheme}://{host}{path}"
    if parsed.query:
        out = f"{out}?{parsed.query}"
    return out.rstrip("/")


def _is_blocked(host: str) -> bool:
    h = str(host or "").lower()
    if not h:
        return True
    for d in BLOCKED:
        if h == d or h.endswith(f".{d}"):
            return True
    return False


def _parse_ddg_results(html: str, query: str, limit: int) -> list[dict[str, Any]]:
    soup = BeautifulSoup(html or "", "html.parser")
    rows: list[dict[str, Any]] = []
    seen: set[str] = set()
    now = datetime.now(timezone.utc).isoformat()
    for node in soup.select(".result, .result__body, .results_links, .result__content"):
        link = node.select_one("a.result__a, h2 a, .result__title a")
        if link is None:
            continue
        href = str(link.get("href") or "").strip()
        title = str(link.get_text(" ", strip=True) or "").strip()
        if href.startswith("/l/?") or "duckduckgo.com/l/?" in href:
            parsed_href = urlparse(href if href.startswith("http") else f"https://duckduckgo.com{href}")
            params = parse_qs(parsed_href.query or "")
            target = str((params.get("uddg") or params.get("rut") or [""])[0] or "").strip()
            if target:
                href = unquote(target)
        url = _norm_url(href)
        if not url or url in seen:
            continue
        host = (urlparse(url).netloc or "").lower().replace("www.", "")
        if _is_blocked(host):
            continue
        seen.add(url)
        rows.append(
            {
                "url": url,
                "title": title or host,
                "snippet": "",
                "domain": host,
                "discovered_at": now,
                "last_seen_at": now,
                "inlink_count": None,
                "content_length_estimate": None,
                "source": "local_stub",
                "query": query,
            }
        )
        if len(rows) >= limit:
            break
    return rows


def _decode_bing_href(value: str) -> str:
    raw = str(value or "").strip()
    if not raw:
        return ""
    try:
        parsed = urlparse(raw)
        host = (parsed.netloc or "").lower()
        if "bing.com" in host and parsed.path.startswith("/ck/a"):
            token = str((parse_qs(parsed.query or "").get("u") or [""])[0] or "").strip()
            if token.startswith("a1"):
                payload = token[2:]
                pad = "=" * ((4 - len(payload) % 4) % 4)
                try:
                    decoded = base64.b64decode((payload + pad).encode("utf-8")).decode("utf-8", errors="ignore").strip()
                    if decoded.startswith("http://") or decoded.startswith("https://"):
                        return decoded
                except Exception:
                    pass
            try:
                decoded = unquote(token)
                if decoded.startswith("http://") or decoded.startswith("https://"):
                    return decoded
            except Exception:
                pass
    except Exception:
        return raw
    return raw


def _parse_bing_results(html: str, query: str, limit: int) -> list[dict[str, Any]]:
    soup = BeautifulSoup(html or "", "html.parser")
    rows: list[dict[str, Any]] = []
    seen: set[str] = set()
    now = datetime.now(timezone.utc).isoformat()
    for link in soup.select("li.b_algo h2 a, #b_results h2 a, .b_algo h2 a, a.tilk, .algo h2 a"):
        href = str(link.get("href") or "").strip()
        title = str(link.get_text(" ", strip=True) or "").strip()
        url = _norm_url(_decode_bing_href(href))
        if not url or url in seen:
            continue
        host = (urlparse(url).netloc or "").lower().replace("www.", "")
        if _is_blocked(host):
            continue
        seen.add(url)
        rows.append(
            {
                "url": url,
                "title": title or host,
                "snippet": "",
                "domain": host,
                "discovered_at": now,
                "last_seen_at": now,
                "inlink_count": None,
                "content_length_estimate": None,
                "source": "local_stub",
                "query": query,
            }
        )
        if len(rows) >= limit:
            break
    return rows


@app.post("/search")
async def search(payload: SearchPayload) -> dict[str, Any]:
    _sanitize_ssl_env()
    query = str(payload.query or payload.keyword or "").strip()
    if not query:
        return {"ok": False, "error": "query_required", "items": []}
    limit = max(1, min(int(payload.limit or 10), 30))
    ddg_url = f"https://html.duckduckgo.com/html/?q={quote_plus(query)}"
    bing_url = f"https://www.bing.com/search?q={quote_plus(query)}&count=50&setlang=en-US&cc=IN&ensearch=1"
    try:
        async with httpx.AsyncClient(timeout=20, follow_redirects=True) as client:
            ddg_resp = await client.get(ddg_url, headers={"User-Agent": "ContentOpsAI/1.0"})
            bing_resp = await client.get(bing_url, headers={"User-Agent": "ContentOpsAI/1.0"})
        items: list[dict[str, Any]] = []
        if int(ddg_resp.status_code or 0) < 400:
            items = _parse_ddg_results(ddg_resp.text or "", query, limit)
        if not items and int(bing_resp.status_code or 0) < 400:
            items = _parse_bing_results(bing_resp.text or "", query, limit)
        return {"ok": True, "provider": "opencrawl-local-stub", "items": items}
    except Exception as exc:
        return {"ok": False, "error": f"search_failed:{exc}", "items": []}
