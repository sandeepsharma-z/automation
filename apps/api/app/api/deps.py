from fastapi import Depends, HTTPException
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer

from app.core.config import get_settings
from app.core.security import verify_token

security = HTTPBearer(auto_error=False)


def get_current_admin(credentials: HTTPAuthorizationCredentials | None = Depends(security)) -> str:
    if not credentials:
        raise HTTPException(status_code=401, detail='Missing auth token')
    subject = verify_token(credentials.credentials)
    if not subject:
        raise HTTPException(status_code=401, detail='Invalid auth token')
    return subject


def verify_login(username: str, password: str) -> bool:
    settings = get_settings()
    return username == settings.admin_username and password == settings.admin_password
