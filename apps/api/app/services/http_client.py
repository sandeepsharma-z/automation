import asyncio
from collections.abc import Callable
from typing import Any

import httpx

DEFAULT_TIMEOUT = httpx.Timeout(connect=5.0, read=20.0, write=20.0, pool=10.0)


async def request_with_retries(
    request_factory: Callable[[], httpx.Request],
    client: httpx.AsyncClient,
    retries: int = 3,
    backoff_base: float = 0.5,
) -> httpx.Response:
    last_error: Exception | None = None
    for attempt in range(retries):
        try:
            response = await client.send(request_factory())
            if response.status_code >= 500 or response.status_code == 429:
                response.raise_for_status()
            return response
        except (httpx.HTTPError, httpx.TimeoutException) as exc:
            last_error = exc
            if attempt == retries - 1:
                raise
            retry_after = 0.0
            if isinstance(exc, httpx.HTTPStatusError) and exc.response is not None:
                try:
                    retry_after = float(exc.response.headers.get('Retry-After', '0') or 0)
                except ValueError:
                    retry_after = 0.0
            await asyncio.sleep(max(backoff_base * (2 ** attempt), retry_after))
    if last_error:
        raise last_error
    raise RuntimeError('unreachable retry branch')


async def fetch_json(
    method: str,
    url: str,
    headers: dict[str, str] | None = None,
    params: dict[str, Any] | None = None,
    json_payload: dict[str, Any] | None = None,
    timeout: httpx.Timeout = DEFAULT_TIMEOUT,
) -> dict[str, Any]:
    async with httpx.AsyncClient(timeout=timeout) as client:
        def _factory() -> httpx.Request:
            return client.build_request(method=method, url=url, headers=headers, params=params, json=json_payload)

        response = await request_with_retries(_factory, client)
        response.raise_for_status()
        return response.json()
