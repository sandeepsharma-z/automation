from abc import ABC, abstractmethod

from app.models.entities import Project


class ConnectorError(RuntimeError):
    pass


class BaseConnector(ABC):
    def __init__(self, project: Project):
        self.project = project

    @abstractmethod
    async def test_connection(self) -> dict:
        raise NotImplementedError

    @abstractmethod
    async def sync_library(self) -> list[dict]:
        raise NotImplementedError

    @abstractmethod
    async def publish(self, payload: dict) -> dict:
        raise NotImplementedError
