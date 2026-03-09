from functools import lru_cache
import os
from pathlib import Path

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file='.env', env_file_encoding='utf-8', extra='ignore')

    env: str = Field(default='development', alias='ENV')
    api_host: str = Field(default='0.0.0.0', alias='API_HOST')
    api_port: int = Field(default=8000, alias='API_PORT')

    jwt_secret: str = Field(default='change-me', alias='JWT_SECRET')
    jwt_expires_minutes: int = Field(default=720, alias='JWT_EXPIRES_MINUTES')
    admin_username: str = Field(default='admin', alias='ADMIN_USERNAME')
    admin_password: str = Field(default='admin123', alias='ADMIN_PASSWORD')

    fernet_master_key: str = Field(alias='FERNET_MASTER_KEY')

    database_url: str = Field(alias='DATABASE_URL')
    mysql_host: str = Field(default='mysql', alias='MYSQL_HOST')
    mysql_port: int = Field(default=3306, alias='MYSQL_PORT')
    mysql_user: str = Field(default='contentops', alias='MYSQL_USER')
    mysql_password: str = Field(default='contentops', alias='MYSQL_PASSWORD')
    mysql_db: str = Field(default='contentops', alias='MYSQL_DB')

    redis_url: str | None = Field(default='redis://redis:6379/0', alias='REDIS_URL')
    celery_broker_url: str | None = Field(default=None, alias='CELERY_BROKER_URL')
    celery_result_backend: str | None = Field(default=None, alias='CELERY_RESULT_BACKEND')

    openai_api_key: str | None = Field(default=None, alias='OPENAI_API_KEY')
    openai_model: str = Field(default='gpt-4.1-mini', alias='OPENAI_MODEL')
    openai_fallback_model: str = Field(default='gpt-4o-mini', alias='OPENAI_FALLBACK_MODEL')
    openai_image_model: str = Field(default='gpt-image-1', alias='OPENAI_IMAGE_MODEL')
    openai_monthly_budget_usd: float = Field(default=100.0, alias='OPENAI_MONTHLY_BUDGET_USD')

    rag_enabled: bool = Field(default=True, alias='RAG_ENABLED')
    rag_top_k: int = Field(default=8, alias='RAG_TOP_K')
    internal_links_max: int = Field(default=5, alias='INTERNAL_LINKS_MAX')
    qa_enabled: bool = Field(default=True, alias='QA_ENABLED')
    qa_strictness: str = Field(default='med', alias='QA_STRICTNESS')
    minimum_word_count: int = Field(default=220, alias='MINIMUM_WORD_COUNT')
    allow_autopublish: bool = Field(default=False, alias='ALLOW_AUTOPUBLISH')
    default_publish_mode: str = Field(default='draft', alias='DEFAULT_PUBLISH_MODE')
    default_language: str = Field(default='en', alias='DEFAULT_LANGUAGE')
    default_country: str = Field(default='us', alias='DEFAULT_COUNTRY')
    similarity_threshold: float = Field(default=0.78, alias='SIMILARITY_THRESHOLD')
    diversity_window_n: int = Field(default=25, alias='DIVERSITY_WINDOW_N')
    chroma_persist_dir: str = Field(default='./storage/chroma', alias='CHROMA_PERSIST_DIR')
    image_provider: str = Field(default='openai', alias='IMAGE_PROVIDER')
    image_style: str = Field(default='editorial', alias='IMAGE_STYLE')
    image_size: str = Field(default='landscape', alias='IMAGE_SIZE')
    allow_inline_images: bool = Field(default=True, alias='ALLOW_INLINE_IMAGES')
    max_competitor_pages: int = Field(default=10, alias='MAX_COMPETITOR_PAGES')
    max_extract_chars: int = Field(default=40000, alias='MAX_EXTRACT_CHARS')
    total_fetch_timeout: int = Field(default=60, alias='TOTAL_FETCH_TIMEOUT')
    max_opencrawl_candidates: int = Field(default=30, alias='MAX_OPENCRAWL_CANDIDATES')
    opencrawl_timeout: int = Field(default=20, alias='OPENCRAWL_TIMEOUT')
    opencrawl_api_url: str | None = Field(default=None, alias='OPENCRAWL_API_URL')
    opencrawl_api_key: str | None = Field(default=None, alias='OPENCRAWL_API_KEY')

    media_dir: str = Field(default='/app/storage/media', alias='MEDIA_DIR')

    @property
    def media_path(self) -> Path:
        return Path(self.media_dir)

    @property
    def chroma_base_path(self) -> Path:
        return Path(self.chroma_persist_dir)


def _sanitize_ssl_env() -> None:
    cert_file = os.environ.get('SSL_CERT_FILE')
    if cert_file and not Path(cert_file).exists():
        os.environ.pop('SSL_CERT_FILE', None)

    cert_dir = os.environ.get('SSL_CERT_DIR')
    if cert_dir and not Path(cert_dir).exists():
        os.environ.pop('SSL_CERT_DIR', None)


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    _sanitize_ssl_env()
    return Settings()
