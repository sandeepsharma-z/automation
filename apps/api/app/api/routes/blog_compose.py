from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException

from app.api.deps import get_current_admin
from app.schemas.entities import CompetitorComposeRequest, CompetitorComposeResponse
from app.services.competitive.competitor_content_analyzer import compose_from_competitors

router = APIRouter(prefix="/api/blog", tags=["blog"], dependencies=[Depends(get_current_admin)])


@router.post("/competitor-compose", response_model=CompetitorComposeResponse)
async def competitor_compose(payload: CompetitorComposeRequest) -> dict:
    keyword = str(payload.keyword or "").strip()
    if not keyword:
        raise HTTPException(status_code=400, detail="keyword is required")
    urls = [str(url or "").strip() for url in payload.competitor_urls if str(url or "").strip()]
    if not urls:
        raise HTTPException(status_code=400, detail="competitor_urls is required")

    try:
        return await compose_from_competitors(
            keyword=keyword,
            competitor_urls=urls,
            brand_voice=payload.brand_voice,
            target_audience=payload.target_audience,
            locale=payload.locale,
            run_id=payload.run_id,
        )
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(status_code=400, detail=str(exc) or "competitor-compose failed") from exc
