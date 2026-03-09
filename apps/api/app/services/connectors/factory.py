from app.core.security import decrypt_secret
from app.models.entities import PlatformType, Project
from app.services.connectors.base import BaseConnector
from app.services.connectors.shopify import ShopifyConnector
from app.services.connectors.wordpress import WordPressConnector


def _decrypt_or_passthrough(value: str | None) -> str | None:
    if not value:
        return None
    try:
        return decrypt_secret(value)
    except Exception:
        # Backward compatibility: allow legacy plaintext credentials.
        return value


def build_connector(project: Project) -> BaseConnector:
    if project.platform == PlatformType.wordpress:
        project.wp_app_password_enc = _decrypt_or_passthrough(project.wp_app_password_enc)
        return WordPressConnector(project)
    if project.platform == PlatformType.shopify:
        project.shopify_token_enc = _decrypt_or_passthrough(project.shopify_token_enc)
        return ShopifyConnector(project)
    raise ValueError(f'Unsupported platform: {project.platform}')
