from __future__ import annotations

import json
import re
from datetime import datetime, timezone
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.config import get_settings
from app.core.security import decrypt_secret, encrypt_secret
from app.models.entities import Project, Setting

SECRET_KEYS = {'openai_api_key', 'opencrawl_api_key', 'anthropic_api_key'}
INTERNAL_KEYS = {'provider_health_openai', 'provider_health_opencrawl', 'provider_health_claude'}

SETTING_SPECS: dict[str, dict[str, Any]] = {
    'openai_api_key': {'type': 'str', 'secret': True},
    'openai_model': {'type': 'str'},
    'anthropic_api_key': {'type': 'str', 'secret': True},
    'anthropic_model': {'type': 'str'},
    'ai_provider': {'type': 'str', 'choices': {'openai', 'claude'}},
    'image_model': {'type': 'str'},
    'opencrawl_api_url': {'type': 'str'},
    'opencrawl_api_key': {'type': 'str', 'secret': True},
    'default_language': {'type': 'str'},
    'default_country': {'type': 'str'},
    'default_publish_mode': {'type': 'str', 'choices': {'draft', 'publish', 'scheduled'}},
    'rag_enabled': {'type': 'bool'},
    'rag_top_k': {'type': 'int'},
    'internal_links_max': {'type': 'int'},
    'qa_enabled': {'type': 'bool'},
    'qa_strictness': {'type': 'str', 'choices': {'low', 'med', 'high'}},
    'allow_autopublish': {'type': 'bool'},
    'similarity_threshold': {'type': 'float'},
    'diversity_window_n': {'type': 'int'},
    'image_provider': {'type': 'str', 'choices': {'openai', 'disabled'}},
    'image_style': {'type': 'str', 'choices': {'editorial', 'minimalist', '3d-illustration'}},
    'image_size': {'type': 'str'},
    'allow_inline_images': {'type': 'bool'},
    'minimum_word_count': {'type': 'int'},
}


def mask_secret(value: str | None) -> str:
    if not value:
        return ''
    if len(value) <= 6:
        return '*' * len(value)
    return f'{value[:3]}...{value[-4:]}'


def _is_masked_secret_candidate(value: Any) -> bool:
    text = str(value or '').strip()
    if not text:
        return False
    if text == '***':
        return True
    if '...' in text:
        return True
    return bool(re.fullmatch(r'\*+', text))


def _looks_like_openai_key(value: Any) -> bool:
    text = str(value or '').strip()
    if not text or _is_masked_secret_candidate(text):
        return False
    return text.startswith('sk-')


def _to_bool(value: Any) -> bool:
    if isinstance(value, bool):
        return value
    if isinstance(value, (int, float)):
        return bool(value)
    text = str(value).strip().lower()
    return text in {'1', 'true', 'yes', 'on'}


def _to_int(value: Any) -> int:
    if isinstance(value, int):
        return value
    return int(str(value).strip())


def _to_float(value: Any) -> float:
    if isinstance(value, float):
        return value
    if isinstance(value, int):
        return float(value)
    return float(str(value).strip())


def _normalize_value(key: str, value: Any) -> Any:
    spec = SETTING_SPECS.get(key, {})
    value_type = spec.get('type', 'str')
    if value in (None, ''):
        return None

    if value_type == 'bool':
        parsed = _to_bool(value)
    elif value_type == 'int':
        parsed = _to_int(value)
    elif value_type == 'float':
        parsed = _to_float(value)
    elif isinstance(value, str):
        parsed = value.strip()
    else:
        parsed = value

    if 'choices' in spec and parsed not in spec['choices']:
        choices = ', '.join(sorted(spec['choices']))
        raise ValueError(f"Invalid value for {key}. Allowed: {choices}")
    return parsed


def _serialize_non_secret(value: Any) -> str:
    return json.dumps(value)


def _deserialize_non_secret(value: str | None) -> Any:
    if value is None:
        return None
    try:
        return json.loads(value)
    except Exception:
        return value


def _setting_row(db: Session, key: str) -> Setting | None:
    return db.execute(select(Setting).where(Setting.key == key)).scalar_one_or_none()


def _env_default(key: str) -> Any:
    settings = get_settings()
    defaults = {
        'openai_api_key': settings.openai_api_key,
        'openai_model': settings.openai_model,
        'image_model': settings.openai_image_model,
        'opencrawl_api_url': settings.opencrawl_api_url,
        'opencrawl_api_key': settings.opencrawl_api_key,
        'default_language': settings.default_language,
        'default_country': settings.default_country,
        'default_publish_mode': settings.default_publish_mode,
        'rag_enabled': settings.rag_enabled,
        'rag_top_k': settings.rag_top_k,
        'internal_links_max': settings.internal_links_max,
        'qa_enabled': settings.qa_enabled,
        'qa_strictness': settings.qa_strictness,
        'allow_autopublish': settings.allow_autopublish,
        'similarity_threshold': settings.similarity_threshold,
        'diversity_window_n': settings.diversity_window_n,
        'image_provider': settings.image_provider,
        'image_style': settings.image_style,
        'image_size': settings.image_size,
        'allow_inline_images': settings.allow_inline_images,
        'minimum_word_count': settings.minimum_word_count,
    }
    return defaults.get(key)


def get_setting_value(
    db: Session,
    key: str,
    *,
    decrypt_secrets: bool = False,
    include_env_fallback: bool = True,
) -> Any:
    if key not in SETTING_SPECS and key not in INTERNAL_KEYS:
        return None

    row = _setting_row(db, key)
    if row:
        if key in SECRET_KEYS:
            if decrypt_secrets:
                return decrypt_secret(row.value_encrypted)
            return row.value_masked or ''
        return _deserialize_non_secret(row.value_masked)

    if not include_env_fallback:
        return None

    default = _env_default(key)
    if key in SECRET_KEYS and not decrypt_secrets:
        return mask_secret(str(default)) if default else ''
    return default


def _looks_like_anthropic_key(value: Any) -> bool:
    text = str(value or '').strip()
    if not text or _is_masked_secret_candidate(text):
        return False
    return text.startswith('sk-ant-')


def _upsert_raw(db: Session, key: str, value_encrypted: str | None, value_masked: str | None) -> Setting:
    row = _setting_row(db, key)
    if not row:
        row = Setting(key=key)
    row.value_encrypted = value_encrypted
    row.value_masked = value_masked
    row.updated_at = datetime.now(timezone.utc)
    db.add(row)
    db.commit()
    db.refresh(row)
    return row


def upsert_setting(db: Session, key: str, value: Any) -> Setting:
    if key not in SETTING_SPECS:
        raise ValueError(f'Unsupported setting key: {key}')

    normalized = _normalize_value(key, value)
    if key in SECRET_KEYS:
        if not normalized:
            return _upsert_raw(db, key, None, '')
        secret = str(normalized)
        if key == 'openai_api_key':
            if _is_masked_secret_candidate(secret):
                raise ValueError('Please paste full OpenAI API key, not masked value.')
            if not _looks_like_openai_key(secret):
                raise ValueError('Invalid OpenAI API key format. Expected key starting with sk-.')
        if key == 'anthropic_api_key':
            if _is_masked_secret_candidate(secret):
                raise ValueError('Please paste full Anthropic API key, not masked value.')
            if not _looks_like_anthropic_key(secret):
                raise ValueError('Invalid Anthropic API key format. Expected key starting with sk-ant-.')
        return _upsert_raw(db, key, encrypt_secret(secret), mask_secret(secret))

    serialized = _serialize_non_secret(normalized)
    return _upsert_raw(db, key, None, serialized)


def list_settings(db: Session) -> list[dict[str, Any]]:
    items: list[dict[str, Any]] = []
    for key in SETTING_SPECS:
        row = _setting_row(db, key)
        value = get_setting_value(db, key, decrypt_secrets=False, include_env_fallback=True)
        items.append(
            {
                'key': key,
                'value': value,
                'is_secret': key in SECRET_KEYS,
                'updated_at': row.updated_at if row else None,
            }
        )
    return items


def resolve_project_setting(db: Session, project: Project, key: str) -> Any:
    project_settings = project.settings_json or {}
    if key == 'openai_api_key':
        project_secret = project_settings.get('openai_api_key_enc')
        if project_secret and project_secret != '***':
            try:
                decrypted = decrypt_secret(project_secret)
            except Exception:
                decrypted = ''
            if _looks_like_openai_key(decrypted):
                return decrypted
        raw = project_settings.get('openai_api_key')
        if _looks_like_openai_key(raw):
            return raw
    elif key in project_settings and project_settings.get(key) not in (None, ''):
        return _normalize_value(key, project_settings.get(key))

    global_value = get_setting_value(db, key, decrypt_secrets=True, include_env_fallback=True)
    if key in SETTING_SPECS:
        return _normalize_value(key, global_value)
    return global_value


def resolve_project_runtime_config(db: Session, project: Project) -> dict[str, Any]:
    project_settings = project.settings_json or {}
    resolved = {
        'openai_api_key': resolve_project_setting(db, project, 'openai_api_key'),
        'openai_model': resolve_project_setting(db, project, 'openai_model'),
        'anthropic_api_key': resolve_project_setting(db, project, 'anthropic_api_key'),
        'anthropic_model': resolve_project_setting(db, project, 'anthropic_model'),
        'ai_provider': str(resolve_project_setting(db, project, 'ai_provider') or 'openai'),
        'image_model': resolve_project_setting(db, project, 'image_model'),
        'opencrawl_api_url': resolve_project_setting(db, project, 'opencrawl_api_url')
        or get_settings().opencrawl_api_url,
        'opencrawl_api_key': resolve_project_setting(db, project, 'opencrawl_api_key'),
        'language': project_settings.get('language') or resolve_project_setting(db, project, 'default_language') or 'en',
        'country': project_settings.get('country') or resolve_project_setting(db, project, 'default_country') or 'us',
        'default_publish_mode': project_settings.get('publish_mode')
        or resolve_project_setting(db, project, 'default_publish_mode')
        or 'draft',
        'rag_enabled': bool(resolve_project_setting(db, project, 'rag_enabled')),
        'rag_top_k': max(1, int(resolve_project_setting(db, project, 'rag_top_k') or 8)),
        'internal_links_max': max(1, min(3, int(resolve_project_setting(db, project, 'internal_links_max') or 3))),
        'qa_enabled': bool(resolve_project_setting(db, project, 'qa_enabled')),
        'qa_strictness': str(resolve_project_setting(db, project, 'qa_strictness') or 'med'),
        'allow_autopublish': bool(resolve_project_setting(db, project, 'allow_autopublish')),
        'similarity_threshold': float(resolve_project_setting(db, project, 'similarity_threshold') or 0.78),
        'diversity_window_n': max(5, int(resolve_project_setting(db, project, 'diversity_window_n') or 25)),
        'image_provider': str(resolve_project_setting(db, project, 'image_provider') or 'openai'),
        'image_style': str(resolve_project_setting(db, project, 'image_style') or 'editorial'),
        'image_size': str(resolve_project_setting(db, project, 'image_size') or 'landscape'),
        'allow_inline_images': bool(resolve_project_setting(db, project, 'allow_inline_images')),
        'minimum_word_count': max(120, int(resolve_project_setting(db, project, 'minimum_word_count') or 220)),
    }
    return resolved


def update_provider_health(db: Session, provider: str, ok: bool, message: str) -> None:
    key = f'provider_health_{provider}'
    payload = {
        'status': 'ok' if ok else 'failed',
        'message': message,
        'checked_at': datetime.now(timezone.utc).isoformat(),
    }
    _upsert_raw(db, key, None, _serialize_non_secret(payload))


def get_provider_health(db: Session, provider: str) -> dict[str, Any]:
    key = f'provider_health_{provider}'
    value = get_setting_value(db, key, include_env_fallback=False)
    if isinstance(value, dict):
        return value
    return {'status': 'unknown', 'message': 'Not tested yet', 'checked_at': None}
