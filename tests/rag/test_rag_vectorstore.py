from pathlib import Path

from app.core.config import get_settings
from app.services.rag.vectorstore import get_rag_status, ingest_library_items, retrieve_internal_link_candidates


def _item(project_id: int, item_id: int, title: str, url: str) -> dict:
    return {
        'id': item_id,
        'project_id': project_id,
        'type': 'post',
        'title': title,
        'url': url,
        'handle': title.lower().replace(' ', '-'),
        'tags_json': ['automation', 'seo'],
        'updated_at': '2026-02-11T00:00:00Z',
    }


def test_rag_ingestion_persists(monkeypatch, tmp_path):
    monkeypatch.setenv('CHROMA_PERSIST_DIR', str(tmp_path / 'chroma'))
    monkeypatch.setenv('OPENAI_API_KEY', '')
    get_settings.cache_clear()

    items = [
        _item(10, 1, 'SEO Automation Checklist', 'https://example.com/seo-checklist'),
        _item(10, 2, 'Internal Linking Guide', 'https://example.com/internal-linking'),
    ]
    result = ingest_library_items(project_id=10, items=items)

    assert result['doc_count'] == 2
    status = get_rag_status(10)
    assert status['doc_count'] == 2
    assert Path(tmp_path / 'chroma' / '10').exists()


def test_rag_retrieval_scoped_by_project(monkeypatch, tmp_path):
    monkeypatch.setenv('CHROMA_PERSIST_DIR', str(tmp_path / 'chroma'))
    monkeypatch.setenv('OPENAI_API_KEY', '')
    get_settings.cache_clear()

    ingest_library_items(
        project_id=21,
        items=[
            _item(21, 1, 'Shopify Collection Optimization', 'https://shop.example.com/collections/optimize'),
            _item(21, 2, 'Product Launch Blog Strategy', 'https://shop.example.com/blogs/news/launch-strategy'),
        ],
    )
    ingest_library_items(
        project_id=22,
        items=[
            _item(22, 3, 'WordPress Caching Setup', 'https://wp.example.com/caching-setup'),
        ],
    )

    results = retrieve_internal_link_candidates(project_id=21, query_text='shopify collection strategy', top_k=3)
    assert results
    assert all('shop.example.com' in row['url'] for row in results)
