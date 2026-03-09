from fastapi import APIRouter, HTTPException

from app.api.deps import verify_login
from app.core.security import create_access_token
from app.schemas.entities import TokenRequest, TokenResponse

router = APIRouter(prefix='/api/auth', tags=['auth'])


@router.post('/login', response_model=TokenResponse)
def login(payload: TokenRequest) -> TokenResponse:
    if not verify_login(payload.username, payload.password):
        raise HTTPException(status_code=401, detail='Invalid credentials')
    token = create_access_token(payload.username)
    return TokenResponse(access_token=token)
