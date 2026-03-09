from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from app.api.deps import get_current_admin
from app.db.session import get_db
from app.schemas.entities import SeoReportRunRequest, SeoReportRunResponse
from app.services.seo.reporting import generate_seo_report
from app.services.settings import get_setting_value

router = APIRouter(prefix='/api/seo-reports', tags=['seo-reports'], dependencies=[Depends(get_current_admin)])


@router.post('/run', response_model=SeoReportRunResponse)
async def run_seo_report(payload: SeoReportRunRequest, db: Session = Depends(get_db)) -> dict:
    provider = str(get_setting_value(db, 'serp_provider', include_env_fallback=True) or 'none').lower()
    serp_api_key = get_setting_value(db, 'serp_api_key', decrypt_secrets=True, include_env_fallback=True)

    if provider == 'none':
        raise HTTPException(status_code=400, detail='Set SERP provider in Settings (serpapi/dataforseo/zenserp).')
    if provider in {'serpapi', 'zenserp'} and not serp_api_key:
        raise HTTPException(status_code=400, detail='SERP API key missing in Settings.')

    try:
        report = await generate_seo_report(
            website_url=payload.website_url,
            keywords=payload.keywords,
            country=payload.country,
            language=payload.language,
            provider_name=provider,
            serp_api_key=serp_api_key,
        )
        return report
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(status_code=400, detail=str(exc) or 'SEO report generation failed') from exc

