from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.orm import Session

from app.api.deps import get_current_admin
from app.db.session import get_db
from app.models.entities import PlatformType, Project
from app.services.connectors.base import ConnectorError
from app.services.connectors.factory import build_connector

router = APIRouter(prefix='/api/shopify', tags=['shopify'], dependencies=[Depends(get_current_admin)])


@router.get('/blogs')
async def list_shopify_blogs(
    project_id: int = Query(...),
    db: Session = Depends(get_db),
) -> dict:
    project = db.get(Project, project_id)
    if not project:
        raise HTTPException(status_code=404, detail='Project not found')
    if project.platform != PlatformType.shopify:
        raise HTTPException(status_code=400, detail='Project platform is not Shopify')

    try:
        connector = build_connector(project)
        if not hasattr(connector, 'list_blogs'):
            raise HTTPException(status_code=400, detail='Shopify connector does not support blogs list')
        blogs = await connector.list_blogs()
        return {'ok': True, 'blogs': blogs}
    except ConnectorError as exc:
        text = str(exc or '').strip()
        if '401' in text or '403' in text:
            raise HTTPException(status_code=401, detail=f'Shopify auth failed: {text}') from exc
        raise HTTPException(status_code=400, detail=f'Shopify blogs fetch failed: {text}') from exc
