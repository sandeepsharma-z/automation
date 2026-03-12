from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.orm import Session

from app.api.deps import get_current_admin
from app.db.session import get_db
from app.models.entities import PlatformType, Project
from app.schemas.entities import SettingItemResponse, SettingsListResponse, SettingValueUpdate
from app.services.connectors.base import ConnectorError
from app.services.connectors.factory import build_connector
from app.services.competitive.open_crawl_service import fetch_open_crawl_live
from app.services.providers.openai_provider import OpenAIProvider
from app.services.providers.claude_provider import ClaudeProvider
from app.services.settings import (
    SECRET_KEYS,
    SETTING_SPECS,
    get_provider_health,
    get_setting_value,
    list_settings,
    upsert_setting,
    update_provider_health,
)

router = APIRouter(prefix='/api/settings', tags=['settings'], dependencies=[Depends(get_current_admin)])


def _normalize_openai_error_message(err: Exception) -> str:
    text = str(err or '').strip()
    lowered = text.lower()

    status_code = None
    response_text = ''
    response_lowered = ''
    response = getattr(err, 'response', None)
    if response is not None:
        status_code = getattr(response, 'status_code', None)
        try:
            response_text = str(getattr(response, 'text', '') or '')
        except Exception:
            response_text = ''
        response_lowered = response_text.lower()

    combined = f'{lowered}\n{response_lowered}'
    if 'invalid_api_key' in combined or 'incorrect api key' in combined:
        return 'OpenAI API key is invalid. Generate a new key in OpenAI dashboard and save it here.'
    if 'insufficient_quota' in combined or ('429' in combined and ('quota' in combined or 'billing' in combined)):
        return (
            'OpenAI auth OK, but quota exhausted (insufficient_quota). '
            'Add billing/credits for this project and retry.'
        )
    if status_code == 429 or '429' in combined or 'too many requests' in combined or '/status/429' in combined:
        return 'OpenAI rate limit hit (429). Wait briefly and retry.'
    if status_code in {401, 403} or '401' in combined or '403' in combined or 'unauthorized' in combined or 'auth failed' in combined:
        return 'OpenAI auth failed (401/403). Update API key in Settings.'
    return text or 'OpenAI test failed'


def _setting_item(db: Session, key: str) -> dict[str, Any]:
    items = {item['key']: item for item in list_settings(db)}
    if key not in items:
        raise HTTPException(status_code=404, detail='Setting key not found')
    return items[key]


@router.get('', response_model=SettingsListResponse)
def get_settings_list(db: Session = Depends(get_db)) -> dict[str, Any]:
    return {
        'items': list_settings(db),
        'provider_health': {
            'openai': get_provider_health(db, 'openai'),
            'opencrawl': get_provider_health(db, 'opencrawl'),
            'claude': get_provider_health(db, 'claude'),
        },
    }


@router.put('/{key}', response_model=SettingItemResponse)
def put_setting(key: str, payload: SettingValueUpdate, db: Session = Depends(get_db)) -> dict[str, Any]:
    if key not in SETTING_SPECS:
        raise HTTPException(status_code=400, detail='Unsupported setting key')

    if key in SECRET_KEYS:
        current_masked = str(get_setting_value(db, key, decrypt_secrets=False, include_env_fallback=True) or '')
        incoming = str(payload.value).strip()
        if incoming in {'***', current_masked}:
            return _setting_item(db, key)

    try:
        upsert_setting(db, key, payload.value)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return _setting_item(db, key)


@router.post('/test/openai')
async def test_openai_settings(db: Session = Depends(get_db)) -> dict[str, Any]:
    api_key = get_setting_value(db, 'openai_api_key', decrypt_secrets=True, include_env_fallback=True)
    model = get_setting_value(db, 'openai_model', include_env_fallback=True) or 'gpt-4.1-mini'
    image_model = get_setting_value(db, 'image_model', include_env_fallback=True)
    if not api_key:
        update_provider_health(db, 'openai', False, 'Missing OpenAI API key')
        return {'ok': False, 'error': 'OpenAI API key is not configured'}

    provider = OpenAIProvider(api_key=api_key, model=model, image_model=image_model)
    try:
        result = await provider.generate_text('Reply with exactly: OK')
        update_provider_health(db, 'openai', True, f'Connected to model {model}')
        return {'ok': True, 'model': model, 'reply': result.text[:60]}
    except Exception as exc:
        normalized = _normalize_openai_error_message(exc)
        update_provider_health(db, 'openai', False, normalized)
        return {'ok': False, 'error': normalized, 'model': model}


@router.post('/test/claude')
async def test_claude_settings(db: Session = Depends(get_db)) -> dict[str, Any]:
    api_key = get_setting_value(db, 'anthropic_api_key', decrypt_secrets=True, include_env_fallback=True)
    model = get_setting_value(db, 'anthropic_model', include_env_fallback=True) or 'claude-sonnet-4-6'
    if not api_key:
        update_provider_health(db, 'claude', False, 'Missing Anthropic API key')
        return {'ok': False, 'error': 'Anthropic API key is not configured'}

    provider = ClaudeProvider(api_key=api_key, model=model)
    try:
        result = await provider.generate_text('Reply with exactly: OK')
        update_provider_health(db, 'claude', True, f'Connected to model {model}')
        return {'ok': True, 'model': model, 'reply': result.text[:60]}
    except Exception as exc:
        msg = str(exc or '').strip() or 'Claude test failed'
        update_provider_health(db, 'claude', False, msg)
        return {'ok': False, 'error': msg, 'model': model}


@router.post('/test/opencrawl')
async def test_opencrawl_settings(db: Session = Depends(get_db)) -> dict[str, Any]:
    api_url = str(get_setting_value(db, 'opencrawl_api_url', include_env_fallback=True) or '').strip()
    api_key = str(get_setting_value(db, 'opencrawl_api_key', decrypt_secrets=True, include_env_fallback=True) or '').strip()
    result = await fetch_open_crawl_live(
        keyword='bopp laminated bags',
        country='in',
        language='en',
        max_candidates=5,
        timeout=15,
        api_url=api_url,
        api_key=api_key,
    )
    if not result.get('ok'):
        message = str(result.get('error') or 'OpenCrawl test failed')
        update_provider_health(db, 'opencrawl', False, message)
        return {'ok': False, 'error': message}
    items = list(result.get('items') or [])
    auth_mode = 'token' if api_key else 'no-auth'
    update_provider_health(db, 'opencrawl', True, f'Connected to OpenCrawl ({auth_mode}), items={len(items)}')
    return {'ok': True, 'provider': 'opencrawl', 'auth_mode': auth_mode, 'results': len(items), 'sample': items[:3]}


@router.post('/test/shopify')
async def test_shopify_settings(
    project_id: int = Query(...),
    db: Session = Depends(get_db),
) -> dict[str, Any]:
    project = db.get(Project, project_id)
    if not project:
        raise HTTPException(status_code=404, detail='Project not found')
    if project.platform != PlatformType.shopify:
        raise HTTPException(status_code=400, detail='Project platform is not Shopify')

    try:
        connector = build_connector(project)
        result = await connector.test_connection()
        blogs = await connector.list_blogs() if hasattr(connector, 'list_blogs') else []
        return {
            'ok': True,
            'shop_name': result.get('shop'),
            'primary_domain': result.get('primary_domain'),
            'blogs_count': len(blogs),
        }
    except ConnectorError as exc:
        text = str(exc or '').strip()
        if '401' in text or '403' in text:
            raise HTTPException(status_code=401, detail=f'Shopify auth failed: {text}') from exc
        raise HTTPException(status_code=400, detail=f'Shopify connection failed: {text}') from exc
