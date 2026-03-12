from __future__ import annotations

from dataclasses import dataclass

import httpx

from app.services.http_client import request_with_retries


@dataclass
class ClaudeTextResult:
    text: str
    input_tokens: int
    output_tokens: int


class ClaudeProvider:
    def __init__(
        self,
        api_key: str | None = None,
        model: str | None = None,
    ):
        self.api_key = str(api_key or '').strip()
        self.model = str(model or '').strip() or 'claude-sonnet-4-6'

    @property
    def enabled(self) -> bool:
        return bool(self.api_key)

    @property
    def _headers(self) -> dict[str, str]:
        if not self.api_key:
            raise RuntimeError('Anthropic API key not configured')
        return {
            'x-api-key': self.api_key,
            'anthropic-version': '2023-06-01',
            'content-type': 'application/json',
        }

    async def generate_text(self, prompt: str) -> ClaudeTextResult:
        if not self.enabled:
            raise RuntimeError('Claude disabled — Anthropic API key not set')

        payload = {
            'model': self.model,
            'max_tokens': 8096,
            'messages': [{'role': 'user', 'content': prompt}],
        }
        timeout = httpx.Timeout(connect=10.0, read=180.0, write=60.0, pool=30.0)
        async with httpx.AsyncClient(timeout=timeout) as client:
            def _factory() -> httpx.Request:
                return client.build_request(
                    'POST',
                    'https://api.anthropic.com/v1/messages',
                    headers=self._headers,
                    json=payload,
                )

            try:
                resp = await request_with_retries(_factory, client, retries=3, backoff_base=1.0)
            except httpx.HTTPStatusError as exc:
                code = exc.response.status_code if exc.response is not None else None
                body = ''
                try:
                    body = exc.response.text if exc.response is not None else ''
                except Exception:
                    body = ''
                if code in {401, 403}:
                    raise RuntimeError(
                        'Claude auth failed (invalid API key). Update key in Settings.'
                    ) from exc
                if code == 429:
                    raise RuntimeError('Claude rate limit hit (429). Wait and retry.') from exc
                raise

            if resp.status_code in {401, 403}:
                raise RuntimeError('Claude auth failed (401/403). Update API key in Settings.')
            if resp.status_code == 429:
                raise RuntimeError('Claude rate limit hit (429). Wait and retry.')
            resp.raise_for_status()
            data = resp.json()

        text = ''
        for block in data.get('content', []):
            if isinstance(block, dict) and block.get('type') == 'text':
                text += str(block.get('text') or '')

        usage = data.get('usage', {})
        return ClaudeTextResult(
            text=text.strip(),
            input_tokens=int(usage.get('input_tokens', 0)),
            output_tokens=int(usage.get('output_tokens', 0)),
        )

    async def generate_image(self, prompt: str) -> bytes | None:
        # Claude does not support image generation
        return None
