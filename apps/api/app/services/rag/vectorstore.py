import json
import math
import shutil
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from app.core.config import get_settings
from app.services.rag.embeddings import LocalHashEmbeddings, get_embeddings

STATUS_FILE = 'status.json'
COLLECTION_NAME = 'content_library'
FALLBACK_FILE = 'fallback_docs.json'


def _project_dir(project_id: int) -> Path:
    settings = get_settings()
    directory = settings.chroma_base_path / str(project_id)
    directory.mkdir(parents=True, exist_ok=True)
    return directory


def _status_path(project_id: int) -> Path:
    return _project_dir(project_id) / STATUS_FILE


def _fallback_path(project_id: int) -> Path:
    return _project_dir(project_id) / FALLBACK_FILE


def _write_status(project_id: int, *, doc_count: int, indexed_at: str | None = None) -> None:
    payload = {
        'project_id': project_id,
        'doc_count': int(doc_count),
        'indexed_at': indexed_at or datetime.now(timezone.utc).isoformat(),
    }
    _status_path(project_id).write_text(json.dumps(payload, indent=2), encoding='utf-8')


def _read_status(project_id: int) -> dict[str, Any]:
    status_file = _status_path(project_id)
    if not status_file.exists():
        return {'project_id': project_id, 'doc_count': 0, 'indexed_at': None}
    try:
        return json.loads(status_file.read_text(encoding='utf-8'))
    except Exception:
        return {'project_id': project_id, 'doc_count': 0, 'indexed_at': None}


def _item_content(item: dict[str, Any]) -> str:
    tags = item.get('tags_json') or []
    tags_str = ', '.join(str(tag) for tag in tags)
    return (
        f"Title: {item.get('title', '')}\n"
        f"Type: {item.get('type', '')}\n"
        f"URL: {item.get('url', '')}\n"
        f"Tags: {tags_str}\n"
        f"Handle: {item.get('handle', '')}\n"
    )


def _item_metadata(item: dict[str, Any]) -> dict[str, Any]:
    return {
        'project_id': int(item['project_id']),
        'item_id': int(item['id']),
        'type': item.get('type', ''),
        'url': item.get('url', ''),
        'title': item.get('title', ''),
        'tags': item.get('tags_json') or [],
        'updated_at': item.get('updated_at') or datetime.now(timezone.utc).isoformat(),
    }


def _build_chroma_store(project_id: int, openai_api_key: str | None = None):
    try:
        from langchain_community.vectorstores import Chroma

        return Chroma(
            collection_name=COLLECTION_NAME,
            persist_directory=str(_project_dir(project_id)),
            embedding_function=get_embeddings(openai_api_key=openai_api_key),
        )
    except Exception:
        return None


def _cosine(vec_a: list[float], vec_b: list[float]) -> float:
    dot = sum(a * b for a, b in zip(vec_a, vec_b, strict=False))
    norm_a = math.sqrt(sum(a * a for a in vec_a)) or 1.0
    norm_b = math.sqrt(sum(b * b for b in vec_b)) or 1.0
    return dot / (norm_a * norm_b)


def _ingest_fallback(project_id: int, items: list[dict[str, Any]]) -> dict[str, Any]:
    embeddings = LocalHashEmbeddings()
    docs = []
    for item in items:
        text = _item_content(item)
        docs.append(
            {
                'id': f"lib-{project_id}-{item['id']}",
                'text': text,
                'metadata': _item_metadata(item),
                'vector': embeddings.embed_query(text),
            }
        )

    _fallback_path(project_id).write_text(json.dumps(docs), encoding='utf-8')
    _write_status(project_id, doc_count=len(docs))
    return {'project_id': project_id, 'doc_count': len(docs), 'store': 'fallback'}


def _retrieve_fallback(project_id: int, query_text: str, top_k: int) -> list[dict[str, Any]]:
    path = _fallback_path(project_id)
    if not path.exists():
        return []

    try:
        rows = json.loads(path.read_text(encoding='utf-8'))
    except Exception:
        return []

    embeddings = LocalHashEmbeddings()
    query_vec = embeddings.embed_query(query_text)

    scored = []
    for row in rows:
        score = _cosine(query_vec, row.get('vector', []))
        meta = row.get('metadata', {})
        scored.append(
            {
                'item_id': int(meta.get('item_id', 0)),
                'title': meta.get('title', ''),
                'url': meta.get('url', ''),
                'type': meta.get('type', ''),
                'tags': meta.get('tags', []),
                'score': round(1 - score, 6),
            }
        )

    scored.sort(key=lambda item: item['score'])
    return scored[:top_k]


def ingest_library_items(project_id: int, items: list[dict[str, Any]], openai_api_key: str | None = None) -> dict[str, Any]:
    project_dir = _project_dir(project_id)
    if project_dir.exists():
        shutil.rmtree(project_dir, ignore_errors=True)
    project_dir.mkdir(parents=True, exist_ok=True)

    if not items:
        _write_status(project_id, doc_count=0)
        return {'project_id': project_id, 'doc_count': 0, 'store': 'none'}

    store = _build_chroma_store(project_id=project_id, openai_api_key=openai_api_key)
    if not store:
        return _ingest_fallback(project_id, items)

    from langchain_core.documents import Document

    docs = [Document(page_content=_item_content(item), metadata=_item_metadata(item)) for item in items]
    ids = [f"lib-{project_id}-{item['id']}" for item in items]
    store.add_documents(documents=docs, ids=ids)
    store.persist()

    count = store._collection.count()  # noqa: SLF001
    _write_status(project_id, doc_count=count)
    return {'project_id': project_id, 'doc_count': int(count), 'store': 'chroma'}


def retrieve_internal_link_candidates(
    project_id: int,
    query_text: str,
    top_k: int = 8,
    openai_api_key: str | None = None,
    rag_enabled: bool | None = None,
) -> list[dict[str, Any]]:
    settings = get_settings()
    enabled = settings.rag_enabled if rag_enabled is None else rag_enabled
    if not enabled:
        return []

    store = _build_chroma_store(project_id=project_id, openai_api_key=openai_api_key)
    if not store:
        return _retrieve_fallback(project_id=project_id, query_text=query_text, top_k=top_k)

    if store._collection.count() == 0:  # noqa: SLF001
        return []

    rows = store.similarity_search_with_score(query_text, k=top_k)
    results: list[dict[str, Any]] = []
    for doc, score in rows:
        meta = doc.metadata or {}
        results.append(
            {
                'item_id': int(meta.get('item_id', 0)),
                'title': meta.get('title', ''),
                'url': meta.get('url', ''),
                'type': meta.get('type', ''),
                'tags': meta.get('tags', []),
                'score': float(score),
            }
        )

    results.sort(key=lambda row: row.get('score', 0.0))
    return results


def build_internal_link_plan(
    candidates: list[dict[str, Any]],
    primary_keyword: str,
    max_links: int = 5,
) -> list[dict[str, str]]:
    links: list[dict[str, str]] = []
    used_anchors: set[str] = set()

    for candidate in candidates:
        if len(links) >= max_links:
            break
        title = (candidate.get('title') or '').strip()
        url = (candidate.get('url') or '').strip()
        if not title or not url:
            continue

        anchor_options = [
            title,
            f"{title} guide",
            f"{primary_keyword}: {title}",
        ]
        chosen_anchor = None
        for anchor in anchor_options:
            key = anchor.lower().strip()
            if key and key not in used_anchors:
                used_anchors.add(key)
                chosen_anchor = anchor
                break

        if not chosen_anchor:
            continue

        links.append(
            {
                'url': url,
                'anchor': chosen_anchor,
                'reason': f"High relevance to {primary_keyword}",
                'section_hint': title,
            }
        )

    return links


def get_rag_status(project_id: int) -> dict[str, Any]:
    status = _read_status(project_id)
    store = _build_chroma_store(project_id=project_id)
    if store:
        status['doc_count'] = int(store._collection.count())  # noqa: SLF001
    else:
        path = _fallback_path(project_id)
        if path.exists():
            try:
                status['doc_count'] = len(json.loads(path.read_text(encoding='utf-8')))
            except Exception:
                status['doc_count'] = 0
    return status
