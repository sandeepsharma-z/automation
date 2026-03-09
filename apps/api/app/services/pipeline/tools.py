import asyncio
import json
from typing import Any

from langchain_core.runnables import RunnableLambda, RunnableSequence
from langchain_openai import ChatOpenAI
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models.entities import ContentLibraryItem
from app.services.pipeline.research import extract_outline, fetch_html
from app.services.rag.vectorstore import retrieve_internal_link_candidates


async def serp_search(query: str, country: str = 'us', language: str = 'en') -> list[dict[str, Any]]:
    return []


async def fetch_url(url: str) -> dict[str, Any]:
    html = await fetch_html(url)
    if not html:
        return {'url': url, 'ok': False}
    return {'url': url, 'ok': True, 'outline': extract_outline(html)}


async def library_search(query: str, project_id: int) -> list[dict[str, Any]]:
    return retrieve_internal_link_candidates(project_id=project_id, query_text=query, top_k=6)


async def _collect_tool_outputs(data: dict[str, Any]) -> dict[str, Any]:
    query = data['query']
    project_id = int(data['project_id'])
    candidate_urls = [str(url).strip() for url in (data.get('candidate_urls') or []) if str(url).strip().startswith('http')]
    library = await library_search(query=query, project_id=project_id)
    if not candidate_urls:
        candidate_urls = [row.get('url') for row in library[:6] if row.get('url')]
    top_urls = candidate_urls[:3]

    fetch_results = await asyncio.gather(*[fetch_url(url) for url in top_urls], return_exceptions=True)
    competitor = [row for row in fetch_results if isinstance(row, dict) and row.get('ok')]

    return {
        'query': query,
        'web': [{'url': url} for url in top_urls],
        'competitor': competitor,
        'library': library,
    }


async def _summarize_with_llm(data: dict[str, Any]) -> dict[str, Any]:
    api_key = data.get('openai_api_key')
    if not api_key:
        data['tool_summary'] = {
            'mode': 'deterministic',
            'notes': (
                f"Scanned {len(data.get('web', []))} candidate URLs and "
                f"{len(data.get('library', []))} internal matches."
            ),
        }
        return data

    model_name = data.get('openai_model') or 'gpt-4.1-mini'
    model = ChatOpenAI(model=model_name, temperature=0.2, api_key=api_key)
    prompt = (
        'Summarize research tool output into compact JSON with keys '
        'insights, subtopics, risks. Keep max 5 items each.\n'
        f"Data: {json.dumps({'web': data.get('web', []), 'competitor': data.get('competitor', [])})}"
    )
    response = await model.ainvoke(prompt)
    data['tool_summary'] = {'mode': 'llm', 'notes': response.content}
    return data


async def run_optional_research_tools(
    project_id: int,
    query: str,
    country: str,
    language: str,
    openai_api_key: str | None,
    openai_model: str | None = None,
    candidate_urls: list[str] | None = None,
) -> dict[str, Any]:
    sequence: RunnableSequence = RunnableSequence(
        RunnableLambda(afunc=_collect_tool_outputs),
        RunnableLambda(afunc=_summarize_with_llm),
    )
    return await sequence.ainvoke(
        {
            'project_id': project_id,
            'query': query,
            'country': country,
            'language': language,
            'openai_api_key': openai_api_key,
            'openai_model': openai_model,
            'candidate_urls': candidate_urls or [],
        }
    )


def library_search_db(db: Session, query: str, project_id: int, limit: int = 8) -> list[dict[str, Any]]:
    rows = db.execute(
        select(ContentLibraryItem)
        .where(ContentLibraryItem.project_id == project_id)
        .order_by(ContentLibraryItem.last_synced_at.desc().nulls_last())
        .limit(limit * 3)
    ).scalars().all()

    tokens = set(query.lower().split())
    scored: list[tuple[int, ContentLibraryItem]] = []
    for row in rows:
        title_tokens = set((row.title or '').lower().split())
        overlap = len(tokens.intersection(title_tokens))
        scored.append((overlap, row))

    scored.sort(key=lambda item: item[0], reverse=True)
    return [
        {
            'item_id': row.id,
            'title': row.title,
            'url': row.url,
            'type': row.type,
            'score': score,
        }
        for score, row in scored[:limit]
    ]
