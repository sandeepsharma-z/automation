import os

from app.core.config import get_settings


def test_invalid_ssl_env_paths_are_removed(monkeypatch):
    monkeypatch.setenv('SSL_CERT_FILE', 'C:/missing/path/cacert.pem')
    monkeypatch.setenv('SSL_CERT_DIR', 'C:/missing/path/certs')
    monkeypatch.setenv('FERNET_MASTER_KEY', 'u3fKzvTjv0YgS5ER5YjZL5QkNo4fU6Y4ZCkxzgv2F0A=')
    monkeypatch.setenv('DATABASE_URL', 'sqlite+pysqlite:///:memory:')
    get_settings.cache_clear()

    _ = get_settings()

    assert 'SSL_CERT_FILE' not in os.environ
    assert 'SSL_CERT_DIR' not in os.environ
