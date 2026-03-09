from __future__ import annotations

import base64
import json
import time
import os
from dataclasses import dataclass
from typing import Any

import httpx
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.security import decrypt_secret
from app.models.entities import Project, Setting


@dataclass(slots=True)
class WordPressRuntimeConfig:
    wp_url: str | None
    wp_user: str | None
    wp_app_password: str | None
    wp_connector_token: str | None = None
    wp_url_source: str = 'none'
    wp_user_source: str = 'none'
    wp_pass_source: str = 'none'
    wp_token_source: str = 'none'
    auth_mode_source: str = 'none'
    configured_auth_mode: str = 'auto'

    @property
    def auth_mode(self) -> str:
        mode = str(self.configured_auth_mode or 'auto').strip().lower()
        if mode == 'token_connector' and self.wp_connector_token:
            return 'token_connector'
        if mode == 'basic_app_password' and self.wp_user and self.wp_app_password:
            return 'basic_app_password'
        if self.wp_connector_token:
            return 'token_connector'
        if self.wp_user and self.wp_app_password:
            return 'basic_app_password'
        return 'none'

    @property
    def auth_header_attached(self) -> bool:
        return self.auth_mode == 'basic_app_password'


def _normalize_text(value: Any) -> str | None:
    if value is None:
        return None
    text = str(value).strip()
    return text or None


def _decrypt_or_passthrough(value: str | None) -> str | None:
    text = _normalize_text(value)
    if not text:
        return None
    try:
        return _normalize_text(decrypt_secret(text))
    except Exception:
        return text


def _parse_setting_text(value: str | None) -> str | None:
    text = _normalize_text(value)
    if not text:
        return None
    try:
        loaded = json.loads(text)
        if isinstance(loaded, str):
            return _normalize_text(loaded)
    except Exception:
        pass
    return text


def _read_setting(db: Session, key: str) -> Setting | None:
    return db.execute(select(Setting).where(Setting.key == key)).scalar_one_or_none()


def _read_global_wp_value(db: Session, key: str, *, secret: bool = False) -> str | None:
    row = _read_setting(db, key)
    if not row:
        return None
    if secret:
        if row.value_encrypted:
            return _decrypt_or_passthrough(row.value_encrypted)
        return _parse_setting_text(row.value_masked)
    return _parse_setting_text(row.value_masked) or _decrypt_or_passthrough(row.value_encrypted)


def _read_env_first(*keys: str) -> str | None:
    for key in keys:
        value = _normalize_text(os.getenv(key))
        if value:
            return value
    return None


def resolve_wordpress_runtime_config(db: Session, project: Project) -> WordPressRuntimeConfig:
    project_settings = dict(project.settings_json or {})

    wp_url = _normalize_text(project.base_url) or _normalize_text(project_settings.get('wordpress_url'))
    wp_url_source = 'project' if wp_url else 'none'

    wp_user = _normalize_text(project.wp_user) or _normalize_text(project_settings.get('wordpress_user'))
    wp_user_source = 'project' if wp_user else 'none'

    wp_pass = _decrypt_or_passthrough(project.wp_app_password_enc) or _normalize_text(
        project_settings.get('wordpress_app_password')
    )
    wp_pass_source = 'project' if wp_pass else 'none'
    wp_token = _decrypt_or_passthrough(project_settings.get('wp_connector_token_enc')) or _normalize_text(
        project_settings.get('wp_connector_token')
    )
    wp_token_source = 'project' if wp_token else 'none'
    configured_auth_mode = _normalize_text(project_settings.get('wordpress_auth_mode')) or 'auto'
    auth_mode_source = 'project' if _normalize_text(project_settings.get('wordpress_auth_mode')) else 'none'

    if not wp_url:
        wp_url = _read_global_wp_value(db, 'wordpress_url')
        if wp_url:
            wp_url_source = 'global'
    if not wp_user:
        wp_user = _read_global_wp_value(db, 'wordpress_user')
        if wp_user:
            wp_user_source = 'global'
    if not wp_pass:
        wp_pass = _read_global_wp_value(db, 'wordpress_app_password', secret=True)
        if wp_pass:
            wp_pass_source = 'global'
    if not wp_token:
        wp_token = _read_global_wp_value(db, 'wordpress_connector_token', secret=True)
        if wp_token:
            wp_token_source = 'global'
    if auth_mode_source == 'none':
        global_mode = _read_global_wp_value(db, 'wordpress_auth_mode')
        if global_mode:
            configured_auth_mode = global_mode
            auth_mode_source = 'global'

    if not wp_url:
        wp_url = _read_env_first('WORDPRESS_URL', 'WORDPRESS_BASE_URL', 'WP_URL', 'WP_BASE_URL')
        if wp_url:
            wp_url_source = 'env'
    if not wp_user:
        wp_user = _read_env_first('WORDPRESS_USER', 'WP_USER')
        if wp_user:
            wp_user_source = 'env'
    if not wp_pass:
        wp_pass = _read_env_first('WORDPRESS_APP_PASSWORD', 'WP_APP_PASSWORD')
        if wp_pass:
            wp_pass_source = 'env'
    if not wp_token:
        wp_token = _read_env_first('WORDPRESS_CONNECTOR_TOKEN', 'WP_CONNECTOR_TOKEN')
        if wp_token:
            wp_token_source = 'env'
    if auth_mode_source == 'none':
        env_mode = _read_env_first('WORDPRESS_AUTH_MODE', 'WP_AUTH_MODE')
        if env_mode:
            configured_auth_mode = env_mode
            auth_mode_source = 'env'

    return WordPressRuntimeConfig(
        wp_url=wp_url.rstrip('/') if wp_url else None,
        wp_user=wp_user,
        wp_app_password=wp_pass,
        wp_connector_token=wp_token,
        wp_url_source=wp_url_source,
        wp_user_source=wp_user_source,
        wp_pass_source=wp_pass_source,
        wp_token_source=wp_token_source,
        auth_mode_source=auth_mode_source,
        configured_auth_mode=configured_auth_mode,
    )


def apply_wordpress_runtime_to_project(project: Project, config: WordPressRuntimeConfig) -> None:
    if config.wp_url:
        project.base_url = config.wp_url
    if config.wp_user:
        project.wp_user = config.wp_user
    if config.wp_app_password:
        # Connector factory decrypts when needed; plain value is acceptable.
        project.wp_app_password_enc = config.wp_app_password
    if config.wp_connector_token:
        settings_json = dict(project.settings_json or {})
        settings_json['wp_connector_token'] = config.wp_connector_token
        settings_json['wordpress_auth_mode'] = config.auth_mode
        project.settings_json = settings_json


def _build_auth_header(config: WordPressRuntimeConfig) -> dict[str, str]:
    if not config.auth_header_attached:
        return {}
    encoded, _, _ = build_basic_auth_token(config.wp_user, config.wp_app_password)
    return {'Authorization': f'Basic {encoded}'}


def build_basic_auth_token(user: str | None, app_password: str | None) -> tuple[str, int, int]:
    raw = f'{str(user or "")}:{str(app_password or "")}'
    encoded = base64.b64encode(raw.encode('utf-8')).decode('utf-8')
    return encoded, len(encoded), len(raw)


def _sanitize_headers(headers: httpx.Headers) -> dict[str, str]:
    redacted = {'authorization', 'cookie', 'set-cookie', 'x-auth-token', 'x-authorization'}
    output: dict[str, str] = {}
    for key, value in headers.items():
        lower = key.lower()
        if lower in redacted:
            output[key] = '***'
            continue
        text = str(value)
        output[key] = text if len(text) <= 300 else f'{text[:300]}...'
    return output


def _wp_error_fields(text: str) -> tuple[str | None, str | None]:
    wp_code = None
    wp_message = None
    try:
        data = json.loads(text or '{}')
        if isinstance(data, dict):
            wp_code = data.get('code')
            wp_message = data.get('message')
    except Exception:
        pass
    return wp_code, wp_message


def _responses_equivalent(a: dict[str, Any], b: dict[str, Any]) -> bool:
    return (
        int(a.get('status') or 0) == int(b.get('status') or 0)
        and str(a.get('response_snippet') or '') == str(b.get('response_snippet') or '')
        and str(a.get('wp_code') or '') == str(b.get('wp_code') or '')
        and str(a.get('wp_message') or '') == str(b.get('wp_message') or '')
    )


async def _probe_users_me(
    *,
    wp_url: str,
    timeout_seconds: float,
    auth_header: str | None,
) -> dict[str, Any]:
    endpoint = '/wp-json/wp/v2/users/me'
    url = f'{wp_url}{endpoint}'
    headers: dict[str, str] = {}
    if auth_header:
        headers['Authorization'] = auth_header

    started = time.perf_counter()
    try:
        async with httpx.AsyncClient(timeout=httpx.Timeout(timeout_seconds)) as client:
            response = await client.get(url, headers=headers)
        duration_ms = int((time.perf_counter() - started) * 1000)
        text = response.text or ''
        wp_code, wp_message = _wp_error_fields(text)
        return {
            'endpoint': endpoint,
            'status': int(response.status_code),
            'wp_code': wp_code,
            'wp_message': wp_message,
            'response_snippet': text[:300],
            'response_headers': _sanitize_headers(response.headers),
            'duration_ms': duration_ms,
            'auth_header_attached': bool(auth_header),
        }
    except Exception as exc:
        duration_ms = int((time.perf_counter() - started) * 1000)
        return {
            'endpoint': endpoint,
            'status': 0,
            'wp_code': exc.__class__.__name__,
            'wp_message': str(exc),
            'response_snippet': '',
            'response_headers': {},
            'duration_ms': duration_ms,
            'auth_header_attached': bool(auth_header),
        }


async def wordpress_raw_auth_probe(config: WordPressRuntimeConfig, *, timeout_seconds: float = 15.0) -> dict[str, Any]:
    base = {
        'wp_url': config.wp_url,
        'wp_user_present': bool(config.wp_user),
        'wp_app_password_present': bool(config.wp_app_password),
        'wp_user_source': config.wp_user_source,
        'wp_pass_source': config.wp_pass_source,
    }
    if not config.wp_url:
        return {
            **base,
            'auth_header_attached': False,
            'encoded_length': 0,
            'decoded_length': 0,
            'probe_with_auth': {
                'endpoint': '/wp-json/wp/v2/users/me',
                'status': 0,
                'wp_code': 'missing_wp_url',
                'wp_message': 'WordPress URL is not configured',
                'response_snippet': '',
                'response_headers': {},
                'duration_ms': 0,
                'auth_header_attached': False,
            },
            'probe_without_auth': None,
            'authorization_header_reached_wp': False,
            'conclusion': 'missing_wordpress_url',
        }

    encoded, encoded_len, decoded_len = build_basic_auth_token(config.wp_user, config.wp_app_password)
    auth_header = f'Basic {encoded}' if config.auth_header_attached else None
    with_auth = await _probe_users_me(wp_url=config.wp_url, timeout_seconds=timeout_seconds, auth_header=auth_header)

    without_auth = None
    header_reached = with_auth.get('status', 0) not in (0,)
    conclusion = 'unknown'
    if int(with_auth.get('status') or 0) == 401:
        without_auth = await _probe_users_me(wp_url=config.wp_url, timeout_seconds=timeout_seconds, auth_header=None)
        if _responses_equivalent(with_auth, without_auth):
            header_reached = False
            conclusion = 'authorization_header_likely_stripped_by_server_or_waf'
        else:
            header_reached = True
            conclusion = 'authorization_header_reached_but_credentials_invalid_or_app_password_disabled'
    elif int(with_auth.get('status') or 0) == 200:
        conclusion = 'wordpress_basic_auth_ok'
    elif int(with_auth.get('status') or 0) == 0:
        conclusion = 'wordpress_unreachable_or_request_error'
    else:
        conclusion = f'wordpress_returned_status_{int(with_auth.get("status") or 0)}'

    return {
        **base,
        'auth_header_attached': bool(auth_header),
        'encoded_length': encoded_len if auth_header else 0,
        'decoded_length': decoded_len if auth_header else 0,
        'probe_with_auth': with_auth,
        'probe_without_auth': without_auth,
        'authorization_header_reached_wp': bool(header_reached),
        'conclusion': conclusion,
    }


async def wordpress_whoami_probe(config: WordPressRuntimeConfig, *, timeout_seconds: float = 15.0) -> dict[str, Any]:
    endpoint = '/wp-json/wp/v2/users/me'
    if not config.wp_url:
        return {
            'endpoint': endpoint,
            'status': 0,
            'wp_code': 'missing_wp_url',
            'wp_message': 'WordPress URL is not configured',
            'response_snippet': '',
            'auth_header_attached': False,
        }
    if not config.auth_header_attached:
        return {
            'endpoint': endpoint,
            'status': 0,
            'wp_code': 'missing_credentials',
            'wp_message': 'WordPress user/app password is not configured',
            'response_snippet': '',
            'auth_header_attached': False,
        }

    url = f'{config.wp_url}{endpoint}'
    headers = _build_auth_header(config)
    timeout = httpx.Timeout(timeout_seconds)
    try:
        async with httpx.AsyncClient(timeout=timeout) as client:
            response = await client.get(url, headers=headers)
        body_text = response.text or ''
        snippet = body_text[:300]
        wp_code = None
        wp_message = None
        try:
            parsed = response.json()
            if isinstance(parsed, dict):
                wp_code = parsed.get('code')
                wp_message = parsed.get('message')
        except Exception:
            pass
        return {
            'endpoint': endpoint,
            'status': int(response.status_code),
            'wp_code': wp_code,
            'wp_message': wp_message,
            'response_snippet': snippet,
            'auth_header_attached': True,
        }
    except Exception as exc:
        return {
            'endpoint': endpoint,
            'status': 0,
            'wp_code': exc.__class__.__name__,
            'wp_message': str(exc),
            'response_snippet': '',
            'auth_header_attached': True,
        }


async def wordpress_token_ping_probe(config: WordPressRuntimeConfig, *, timeout_seconds: float = 15.0) -> dict[str, Any]:
    endpoint = '/wp-json/contentops/v1/ping'
    if not config.wp_url:
        return {
            'endpoint': endpoint,
            'status': 0,
            'wp_code': 'missing_wp_url',
            'wp_message': 'WordPress URL is not configured',
            'response_snippet': '',
            'auth_header_attached': False,
        }
    if not config.wp_connector_token:
        return {
            'endpoint': endpoint,
            'status': 0,
            'wp_code': 'missing_connector_token',
            'wp_message': 'ContentOps connector token is not configured',
            'response_snippet': '',
            'auth_header_attached': False,
        }

    url = f'{config.wp_url}{endpoint}'
    headers = {'X-ContentOps-Token': config.wp_connector_token}
    timeout = httpx.Timeout(timeout_seconds)
    try:
        async with httpx.AsyncClient(timeout=timeout) as client:
            response = await client.get(url, headers=headers)
        body_text = response.text or ''
        snippet = body_text[:300]
        wp_code = None
        wp_message = None
        supports = []
        max_upload_bytes = None
        try:
            parsed = response.json()
            if isinstance(parsed, dict):
                wp_code = parsed.get('code')
                wp_message = parsed.get('message')
                supports = list(parsed.get('supports') or [])
                max_upload_bytes = parsed.get('max_upload_bytes')
        except Exception:
            pass
        return {
            'endpoint': endpoint,
            'status': int(response.status_code),
            'wp_code': wp_code,
            'wp_message': wp_message,
            'response_snippet': snippet,
            'auth_header_attached': True,
            'supports': supports,
            'max_upload_bytes': max_upload_bytes,
        }
    except Exception as exc:
        return {
            'endpoint': endpoint,
            'status': 0,
            'wp_code': exc.__class__.__name__,
            'wp_message': str(exc),
            'response_snippet': '',
            'auth_header_attached': True,
            'supports': [],
            'max_upload_bytes': None,
        }


async def wordpress_token_publish(config: WordPressRuntimeConfig, payload: dict[str, Any], *, timeout_seconds: float = 60.0) -> dict[str, Any]:
    if not config.wp_url:
        raise RuntimeError('WordPress URL is not configured')
    if not config.wp_connector_token:
        raise RuntimeError('ContentOps connector token is not configured')
    endpoint = '/wp-json/contentops/v1/publish'
    url = f'{config.wp_url}{endpoint}'
    headers = {'X-ContentOps-Token': config.wp_connector_token}
    timeout = httpx.Timeout(timeout_seconds)
    async with httpx.AsyncClient(timeout=timeout) as client:
        response = await client.post(url, json=payload, headers=headers)
    if response.status_code >= 400:
        raise RuntimeError(f'WordPress token publish failed ({response.status_code}): {response.text[:300]}')
    try:
        data = response.json()
    except Exception as exc:
        raise RuntimeError(f'Invalid JSON from WordPress token publish: {exc}') from exc
    if not isinstance(data, dict):
        raise RuntimeError('Unexpected token publish response format')
    if not data.get('ok'):
        raise RuntimeError(str(data.get('message') or 'Token publish returned non-ok'))
    return data
