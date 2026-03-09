import base64
from dataclasses import dataclass

import httpx

from app.core.config import get_settings
from app.services.http_client import request_with_retries


@dataclass
class OpenAITextResult:
    text: str
    input_tokens: int
    output_tokens: int


class OpenAIProvider:
    def __init__(
        self,
        api_key: str | None = None,
        model: str | None = None,
        fallback_model: str | None = None,
        image_model: str | None = None,
    ):
        settings = get_settings()
        self.api_key = api_key or settings.openai_api_key
        self.model = model or settings.openai_model
        self.fallback_model = fallback_model or settings.openai_fallback_model
        self.image_model = image_model or settings.openai_image_model
        self.image_size = settings.image_size or 'landscape'

    @property
    def enabled(self) -> bool:
        return bool(self.api_key)

    @property
    def _headers(self) -> dict[str, str]:
        if not self.api_key:
            raise RuntimeError('OpenAI API key not configured')
        return {'Authorization': f'Bearer {self.api_key}', 'Content-Type': 'application/json'}

    async def _call_responses(self, model: str, prompt: str) -> OpenAITextResult:
        url = 'https://api.openai.com/v1/responses'
        payload = {
            'model': model,
            'input': prompt,
            'temperature': 0.8,
        }
        timeout = httpx.Timeout(connect=10.0, read=120.0, write=60.0, pool=30.0)
        async with httpx.AsyncClient(timeout=timeout) as client:
            def _factory() -> httpx.Request:
                return client.build_request('POST', url, headers=self._headers, json=payload)

            try:
                response = await request_with_retries(_factory, client, retries=4, backoff_base=1.0)
            except httpx.HTTPStatusError as exc:
                code = exc.response.status_code if exc.response is not None else None
                body = ''
                try:
                    body = exc.response.text if exc.response is not None else ''
                except Exception:
                    body = ''
                lowered = body.lower()
                if code in {401, 403}:
                    if 'invalid_api_key' in lowered or 'incorrect api key' in lowered:
                        raise RuntimeError('OpenAI auth failed (invalid_api_key). Please replace API key in Settings.') from exc
                    raise RuntimeError('OpenAI auth failed (401/403). Update API key in Settings.') from exc
                if code == 429:
                    if 'insufficient_quota' in lowered or 'quota' in lowered or 'billing' in lowered:
                        raise RuntimeError('OpenAI quota exceeded (insufficient_quota). Add billing/credits and retry.') from exc
                    raise RuntimeError('OpenAI rate limit hit (429). Wait briefly and retry.') from exc
                raise
            if response.status_code in {401, 403}:
                raise RuntimeError('OpenAI auth failed (401/403). Update API key in Settings.')
            if response.status_code == 429:
                raise RuntimeError('OpenAI quota exceeded (429 insufficient_quota). Update billing/limits and retry.')
            response.raise_for_status()
            data = response.json()

        text = data.get('output_text')
        if not text:
            fragments = []
            for out in data.get('output', []):
                for content in out.get('content', []):
                    if content.get('type') in {'output_text', 'text'}:
                        fragments.append(content.get('text', ''))
            text = '\n'.join(fragments)

        usage = data.get('usage', {})
        return OpenAITextResult(
            text=(text or '').strip(),
            input_tokens=int(usage.get('input_tokens', 0)),
            output_tokens=int(usage.get('output_tokens', 0)),
        )

    async def generate_text(self, prompt: str) -> OpenAITextResult:
        if not self.enabled:
            raise RuntimeError('OpenAI disabled')
        try:
            return await self._call_responses(self.model, prompt)
        except RuntimeError:
            raise
        except httpx.HTTPStatusError as exc:
            code = exc.response.status_code if exc.response is not None else None
            if code in {401, 403}:
                raise RuntimeError('OpenAI auth failed (401/403). Update API key in Settings.') from exc
            if not self.fallback_model or self.fallback_model == self.model:
                raise
            try:
                return await self._call_responses(self.fallback_model, prompt)
            except RuntimeError as fallback_exc:
                fallback_msg = str(fallback_exc or '').lower()
                if 'auth failed' in fallback_msg or 'unauthorized' in fallback_msg or '401' in fallback_msg or '403' in fallback_msg:
                    raise exc
                raise
        except Exception:
            if not self.fallback_model or self.fallback_model == self.model:
                raise
            try:
                return await self._call_responses(self.fallback_model, prompt)
            except RuntimeError as fallback_exc:
                fallback_msg = str(fallback_exc or '').lower()
                if 'auth failed' in fallback_msg or 'unauthorized' in fallback_msg or '401' in fallback_msg or '403' in fallback_msg:
                    raise
                raise

    async def generate_image(self, prompt: str) -> bytes | None:
        if not self.enabled:
            return None
        url = 'https://api.openai.com/v1/images/generations'
        # Force landscape-only outputs for blog publishing consistency.
        landscape_sizes = ['1536x1024', '1792x1024', '1024x576']
        candidate_models = [str(self.image_model or '').strip(), 'gpt-image-1']
        models = [model for model in dict.fromkeys(candidate_models) if model]
        min_image_bytes = 28 * 1024
        payloads: list[dict] = []
        for model in models:
            for size in landscape_sizes:
                payloads.append(
                    {
                        'model': model,
                        'prompt': prompt,
                        'size': size,
                        'response_format': 'b64_json',
                        'quality': 'high',
                        'output_format': 'webp',
                        'output_compression': 85,
                    }
                )
                payloads.append({'model': model, 'prompt': prompt, 'size': size})
        async with httpx.AsyncClient(timeout=httpx.Timeout(connect=10.0, read=90.0, write=60.0, pool=20.0)) as client:
            last_error: Exception | None = None
            for payload in payloads:
                def _factory() -> httpx.Request:
                    return client.build_request('POST', url, headers=self._headers, json=payload)

                response = await request_with_retries(_factory, client, retries=2, backoff_base=0.8)
                if response.status_code == 400:
                    continue
                if response.status_code in {401, 403}:
                    raise RuntimeError('OpenAI image auth failed (401/403). Update API key in Settings.')
                if response.status_code == 429:
                    raise RuntimeError('OpenAI image quota exceeded (429 insufficient_quota). Update billing/limits and retry.')
                response.raise_for_status()
                data = response.json()
                entries = data.get('data', [])
                if not entries:
                    continue

                b64 = entries[0].get('b64_json')
                if b64:
                    try:
                        decoded = base64.b64decode(b64)
                        if len(decoded) < min_image_bytes:
                            continue
                        return decoded
                    except Exception as exc:
                        last_error = exc
                        continue

                image_url = entries[0].get('url')
                if image_url:
                    try:
                        def _download_factory() -> httpx.Request:
                            return client.build_request('GET', image_url)

                        img_response = await request_with_retries(_download_factory, client, retries=2, backoff_base=0.6)
                        img_response.raise_for_status()
                        if img_response.content and len(img_response.content) >= min_image_bytes:
                            return img_response.content
                    except Exception as exc:
                        last_error = exc
                        continue

            if last_error:
                raise last_error
            return None
