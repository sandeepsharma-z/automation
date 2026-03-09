from datetime import datetime, timedelta, timezone

from cryptography.fernet import Fernet
from jose import JWTError, jwt

from app.core.config import get_settings

ALGORITHM = 'HS256'


def get_fernet() -> Fernet:
    settings = get_settings()
    return Fernet(settings.fernet_master_key.encode())


def encrypt_secret(value: str | None) -> str | None:
    if not value:
        return None
    return get_fernet().encrypt(value.encode()).decode()


def decrypt_secret(value: str | None) -> str | None:
    if not value:
        return None
    return get_fernet().decrypt(value.encode()).decode()


def create_access_token(subject: str) -> str:
    settings = get_settings()
    expire = datetime.now(timezone.utc) + timedelta(minutes=settings.jwt_expires_minutes)
    payload = {'sub': subject, 'exp': expire}
    return jwt.encode(payload, settings.jwt_secret, algorithm=ALGORITHM)


def verify_token(token: str) -> str | None:
    settings = get_settings()
    try:
        payload = jwt.decode(token, settings.jwt_secret, algorithms=[ALGORITHM])
        return payload.get('sub')
    except JWTError:
        return None
