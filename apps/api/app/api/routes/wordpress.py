import logging

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.orm import Session

from app.api.deps import get_current_admin
from app.db.session import get_db
from app.models.entities import PlatformType, Project
from app.services.connectors.wordpress_runtime import (
    resolve_wordpress_runtime_config,
    wordpress_raw_auth_probe,
)

router = APIRouter(prefix='/api/wordpress', tags=['wordpress'], dependencies=[Depends(get_current_admin)])
logger = logging.getLogger(__name__)


@router.get('/raw-probe')
async def wordpress_raw_probe(project_id: int = Query(..., ge=1), db: Session = Depends(get_db)) -> dict:
    project = db.get(Project, project_id)
    if not project:
        raise HTTPException(status_code=404, detail='Project not found')
    if project.platform != PlatformType.wordpress:
        raise HTTPException(status_code=400, detail='Project is not a WordPress project')

    runtime = resolve_wordpress_runtime_config(db, project)
    probe = await wordpress_raw_auth_probe(runtime, timeout_seconds=15.0)

    logger.info(
        'wordpress_raw_probe',
        extra={
            'extra': {
                'project_id': project_id,
                'wp_url': probe.get('wp_url'),
                'wp_user_present': probe.get('wp_user_present'),
                'wp_app_password_present': probe.get('wp_app_password_present'),
                'wp_user_source': probe.get('wp_user_source'),
                'wp_pass_source': probe.get('wp_pass_source'),
                'auth_header_attached': probe.get('auth_header_attached'),
                'encoded_length': probe.get('encoded_length'),
                'decoded_length': probe.get('decoded_length'),
                'status': (probe.get('probe_with_auth') or {}).get('status'),
                'conclusion': probe.get('conclusion'),
            }
        },
    )

    return {
        'project_id': project_id,
        **probe,
    }
