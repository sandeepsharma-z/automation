import hashlib
import math
from typing import Iterable

from langchain_core.embeddings import Embeddings
from langchain_openai import OpenAIEmbeddings

from app.core.config import get_settings


class LocalHashEmbeddings(Embeddings):
    """Deterministic fallback embeddings for local/offline testing."""

    def __init__(self, size: int = 256):
        self.size = size

    def _embed(self, text: str) -> list[float]:
        vec = [0.0] * self.size
        if not text:
            return vec
        for token in text.lower().split():
            digest = hashlib.sha256(token.encode()).digest()
            idx = digest[0] % self.size
            sign = -1.0 if digest[1] % 2 else 1.0
            vec[idx] += sign * ((digest[2] / 255.0) + 0.1)

        norm = math.sqrt(sum(v * v for v in vec)) or 1.0
        return [v / norm for v in vec]

    def embed_documents(self, texts: list[str]) -> list[list[float]]:
        return [self._embed(text) for text in texts]

    def embed_query(self, text: str) -> list[float]:
        return self._embed(text)


def get_embeddings(openai_api_key: str | None = None) -> Embeddings:
    settings = get_settings()
    key = openai_api_key or settings.openai_api_key
    if key:
        return OpenAIEmbeddings(api_key=key, model='text-embedding-3-small')
    return LocalHashEmbeddings()
