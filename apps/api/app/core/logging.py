import logging
from datetime import datetime, timezone

from app.core.json_codec import dumps


class JsonFormatter(logging.Formatter):
    def format(self, record: logging.LogRecord) -> str:
        payload = {
            'timestamp': datetime.now(tz=timezone.utc).isoformat(),
            'level': record.levelname,
            'logger': record.name,
            'message': record.getMessage(),
        }
        if record.exc_info:
            payload['exception'] = self.formatException(record.exc_info)
        extra = getattr(record, 'extra', None)
        if isinstance(extra, dict):
            payload.update(extra)
        return dumps(payload)


def configure_logging() -> None:
    handler = logging.StreamHandler()
    handler.setFormatter(JsonFormatter())

    root = logging.getLogger()
    root.setLevel(logging.INFO)
    root.handlers = [handler]
