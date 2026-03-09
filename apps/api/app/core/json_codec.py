import json
from typing import Any

try:
    import orjson  # type: ignore
except Exception:  # pragma: no cover
    orjson = None


def dumps(payload: Any) -> str:
    if orjson:
        return orjson.dumps(payload).decode('utf-8')
    return json.dumps(payload)


def loads(raw: str) -> Any:
    if orjson:
        return orjson.loads(raw)
    return json.loads(raw)
