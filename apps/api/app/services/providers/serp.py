from abc import ABC, abstractmethod

import httpx

from app.core.config import get_settings
from app.services.http_client import DEFAULT_TIMEOUT, request_with_retries


class SerpProvider(ABC):
    @abstractmethod
    async def search(self, keyword: str, country: str, language: str) -> list[dict]:
        raise NotImplementedError


class NoopSerpProvider(SerpProvider):
    async def search(self, keyword: str, country: str, language: str) -> list[dict]:
        return []


class SerpApiProvider(SerpProvider):
    def __init__(self, api_key: str | None = None):
        settings = get_settings()
        self.api_key = api_key or settings.serpapi_key

    async def search(self, keyword: str, country: str, language: str) -> list[dict]:
        if not self.api_key:
            return []
        url = 'https://serpapi.com/search.json'
        params = {
            'api_key': self.api_key,
            'engine': 'google',
            'q': keyword,
            'gl': country,
            'hl': language,
            'num': 10,
        }
        async with httpx.AsyncClient(timeout=DEFAULT_TIMEOUT) as client:
            def _factory() -> httpx.Request:
                return client.build_request('GET', url, params=params)

            response = await request_with_retries(_factory, client)
            response.raise_for_status()
            data = response.json()
        return [
            {'url': item.get('link'), 'title': item.get('title')}
            for item in data.get('organic_results', [])
            if item.get('link')
        ]


class ZenSerpProvider(SerpProvider):
    def __init__(self, api_key: str | None = None):
        settings = get_settings()
        self.api_key = api_key or settings.zenserp_key

    async def search(self, keyword: str, country: str, language: str) -> list[dict]:
        if not self.api_key:
            return []
        url = 'https://app.zenserp.com/api/v2/search'
        headers = {'apikey': self.api_key}
        params = {'q': keyword, 'hl': language, 'gl': country}
        async with httpx.AsyncClient(timeout=DEFAULT_TIMEOUT) as client:
            def _factory() -> httpx.Request:
                return client.build_request('GET', url, headers=headers, params=params)

            response = await request_with_retries(_factory, client)
            response.raise_for_status()
            data = response.json()
        return [
            {'url': item.get('url'), 'title': item.get('title')}
            for item in data.get('organic', [])
            if item.get('url')
        ]


class DataForSeoProvider(SerpProvider):
    def __init__(self, login: str | None = None, password: str | None = None):
        settings = get_settings()
        self.login = login or settings.dataforseo_login
        self.password = password or settings.dataforseo_password

    async def search(self, keyword: str, country: str, language: str) -> list[dict]:
        if not self.login or not self.password:
            return []
        url = 'https://api.dataforseo.com/v3/serp/google/organic/live/advanced'
        payload = [
            {
                'keyword': keyword,
                'location_code': 2840,
                'language_code': language,
                'device': 'desktop',
            }
        ]
        async with httpx.AsyncClient(timeout=DEFAULT_TIMEOUT, auth=(self.login, self.password)) as client:
            def _factory() -> httpx.Request:
                return client.build_request('POST', url, json=payload)

            response = await request_with_retries(_factory, client)
            response.raise_for_status()
            data = response.json()

        tasks = data.get('tasks', [])
        results: list[dict] = []
        for task in tasks:
            for result in task.get('result', []):
                for item in result.get('items', []):
                    if item.get('type') == 'organic':
                        results.append({'url': item.get('url'), 'title': item.get('title')})
        return results


def build_serp_provider(
    *,
    provider_name: str | None = None,
    serp_api_key: str | None = None,
    dataforseo_login: str | None = None,
    dataforseo_password: str | None = None,
) -> SerpProvider:
    settings = get_settings()
    provider = (provider_name or settings.serp_provider or 'none').lower()
    if provider == 'serpapi':
        return SerpApiProvider(api_key=serp_api_key)
    if provider == 'dataforseo':
        return DataForSeoProvider(login=dataforseo_login, password=dataforseo_password)
    if provider == 'zenserp':
        return ZenSerpProvider(api_key=serp_api_key)
    return NoopSerpProvider()
