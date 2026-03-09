from __future__ import annotations

import os
import socket
import threading
import time

from celery.signals import worker_ready, worker_shutdown

from app.services.worker_health import HEARTBEAT_INTERVAL_SECONDS, derive_worker_queues, write_worker_heartbeat

_stop_event = threading.Event()
_thread: threading.Thread | None = None
_worker_name = ""


def _resolve_worker_name() -> str:
    host = socket.gethostname()
    pid = os.getpid()
    return f"{host}:{pid}"


def _heartbeat_loop() -> None:
    queues = derive_worker_queues()
    while not _stop_event.is_set():
        try:
            write_worker_heartbeat(
                worker_name=_worker_name,
                queues=queues,
                meta={
                    "status": "running",
                    "pid": os.getpid(),
                },
            )
        except Exception:
            # Keep worker alive even if heartbeat persistence fails.
            pass
        _stop_event.wait(HEARTBEAT_INTERVAL_SECONDS)


@worker_ready.connect
def on_worker_ready(sender=None, **kwargs) -> None:
    global _thread, _worker_name
    if _thread and _thread.is_alive():
        return
    _worker_name = _resolve_worker_name()
    _stop_event.clear()
    try:
        write_worker_heartbeat(
            worker_name=_worker_name,
            queues=derive_worker_queues(),
            meta={"status": "ready", "pid": os.getpid()},
        )
    except Exception:
        pass
    _thread = threading.Thread(target=_heartbeat_loop, name="worker-heartbeat", daemon=True)
    _thread.start()


@worker_shutdown.connect
def on_worker_shutdown(sender=None, **kwargs) -> None:
    _stop_event.set()
    try:
        write_worker_heartbeat(
            worker_name=_worker_name or _resolve_worker_name(),
            queues=derive_worker_queues(),
            meta={"status": "stopping", "pid": os.getpid()},
        )
    except Exception:
        pass
