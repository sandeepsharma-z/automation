from __future__ import annotations

import json
import os
from datetime import datetime, timedelta, timezone
from urllib.parse import urlsplit, urlunsplit

from sqlalchemy import text
from sqlalchemy.orm import Session

from app.core.celery_client import celery_client
from app.db.session import SessionLocal

HEARTBEAT_INTERVAL_SECONDS = 8
HEARTBEAT_STALE_SECONDS = 30


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


def _to_naive_utc(dt: datetime) -> datetime:
    if dt.tzinfo is None:
        return dt
    return dt.astimezone(timezone.utc).replace(tzinfo=None)


def _ensure_heartbeat_table(db: Session) -> None:
    db.execute(
        text(
            """
            CREATE TABLE IF NOT EXISTS worker_heartbeats (
                worker_name VARCHAR(191) PRIMARY KEY,
                last_heartbeat_at DATETIME NOT NULL,
                queues_json TEXT NULL,
                meta_json TEXT NULL
            )
            """
        )
    )
    db.commit()


def _json_dumps(value: object) -> str:
    try:
        return json.dumps(value or {}, ensure_ascii=True)
    except Exception:
        return "{}"


def _json_loads(value: str | None, fallback: object) -> object:
    if not value:
        return fallback
    try:
        return json.loads(value)
    except Exception:
        return fallback


def derive_worker_queues() -> list[str]:
    raw = str(os.getenv("CELERY_WORKER_QUEUES") or os.getenv("WORKER_QUEUES") or "celery")
    seen: set[str] = set()
    out: list[str] = []
    for item in raw.split(","):
        q = str(item or "").strip()
        if not q or q in seen:
            continue
        seen.add(q)
        out.append(q)
    return out or ["celery"]


def write_worker_heartbeat(
    *,
    worker_name: str,
    queues: list[str] | None = None,
    meta: dict | None = None,
) -> None:
    queues = queues or ["celery"]
    meta = meta or {}
    now = _to_naive_utc(_utcnow())
    db = SessionLocal()
    try:
        _ensure_heartbeat_table(db)
        dialect = str(db.bind.dialect.name).lower() if db.bind and db.bind.dialect else ""
        if "mysql" in dialect:
            db.execute(
                text(
                    """
                    INSERT INTO worker_heartbeats (worker_name, last_heartbeat_at, queues_json, meta_json)
                    VALUES (:worker_name, :last_heartbeat_at, :queues_json, :meta_json)
                    ON DUPLICATE KEY UPDATE
                        last_heartbeat_at = VALUES(last_heartbeat_at),
                        queues_json = VALUES(queues_json),
                        meta_json = VALUES(meta_json)
                    """
                ),
                {
                    "worker_name": worker_name,
                    "last_heartbeat_at": now,
                    "queues_json": _json_dumps(queues),
                    "meta_json": _json_dumps(meta),
                },
            )
        else:
            db.execute(
                text(
                    """
                    INSERT INTO worker_heartbeats (worker_name, last_heartbeat_at, queues_json, meta_json)
                    VALUES (:worker_name, :last_heartbeat_at, :queues_json, :meta_json)
                    ON CONFLICT(worker_name) DO UPDATE SET
                        last_heartbeat_at = excluded.last_heartbeat_at,
                        queues_json = excluded.queues_json,
                        meta_json = excluded.meta_json
                    """
                ),
                {
                    "worker_name": worker_name,
                    "last_heartbeat_at": now,
                    "queues_json": _json_dumps(queues),
                    "meta_json": _json_dumps(meta),
                },
            )
        db.commit()
    finally:
        db.close()


def _mask_broker(value: str) -> str:
    raw = str(value or "").strip()
    if not raw:
        return ""
    if raw.startswith("sqla+"):
        masked_inner = _mask_broker(raw[5:])
        return f"sqla+{masked_inner}"
    if raw.startswith("db+"):
        masked_inner = _mask_broker(raw[3:])
        return f"db+{masked_inner}"
    try:
        parts = urlsplit(raw)
        hostname = parts.hostname or ""
        port = f":{parts.port}" if parts.port else ""
        netloc = hostname + port
        if parts.username:
            netloc = f"{parts.username}:***@{netloc}"
        return urlunsplit((parts.scheme, netloc, parts.path, parts.query, parts.fragment))
    except Exception:
        return "***"


def _configured_queues() -> list[str]:
    seen: set[str] = set()
    out: list[str] = []
    default_queue = str(celery_client.conf.get("task_default_queue") or "celery").strip()
    if default_queue:
        seen.add(default_queue)
        out.append(default_queue)
    routes = celery_client.conf.get("task_routes") or {}
    if isinstance(routes, dict):
        for _, cfg in routes.items():
            if not isinstance(cfg, dict):
                continue
            q = str(cfg.get("queue") or "").strip()
            if q and q not in seen:
                seen.add(q)
                out.append(q)
    return out or ["celery"]


def _pending_messages(db: Session, queues: list[str]) -> dict:
    info = {"total": None, "by_queue": {}, "error": ""}
    broker = str(celery_client.conf.get("broker_url") or "")
    if not broker.startswith("sqla+"):
        info["error"] = "pending message count is only available for sqla broker"
        return info
    try:
        placeholders = ", ".join([f":q{i}" for i in range(len(queues))]) or "NULL"
        params = {f"q{i}": q for i, q in enumerate(queues)}
        rows = db.execute(
            text(
                f"""
                SELECT q.name AS queue_name, COUNT(m.id) AS pending_count
                FROM kombu_queue q
                LEFT JOIN kombu_message m ON m.queue_id = q.id
                WHERE q.name IN ({placeholders})
                GROUP BY q.name
                """
            ),
            params,
        ).all()
        by_queue = {str(r.queue_name): int(r.pending_count or 0) for r in rows}
        info["by_queue"] = by_queue
        info["total"] = int(sum(by_queue.values()))
        return info
    except Exception as exc:
        info["error"] = str(exc)
        return info


def _latest_heartbeat(db: Session) -> dict:
    _ensure_heartbeat_table(db)
    row = db.execute(
        text(
            """
            SELECT worker_name, last_heartbeat_at, queues_json, meta_json
            FROM worker_heartbeats
            ORDER BY last_heartbeat_at DESC
            LIMIT 1
            """
        )
    ).first()
    if not row:
        return {
            "worker_name": "",
            "last_heartbeat_at": None,
            "queues": [],
            "meta": {},
        }
    queues = _json_loads(row.queues_json, [])
    meta = _json_loads(row.meta_json, {})
    return {
        "worker_name": str(row.worker_name or ""),
        "last_heartbeat_at": row.last_heartbeat_at,
        "queues": queues if isinstance(queues, list) else [],
        "meta": meta if isinstance(meta, dict) else {},
    }


def get_worker_health_snapshot(db: Session) -> dict:
    configured = _configured_queues()
    hb = _latest_heartbeat(db)
    pending = _pending_messages(db, configured)
    broker = str(celery_client.conf.get("broker_url") or "")
    backend = str(celery_client.conf.get("result_backend") or "")

    now = _utcnow()
    last = hb.get("last_heartbeat_at")
    if isinstance(last, datetime):
        last_utc = last if last.tzinfo else last.replace(tzinfo=timezone.utc)
        heartbeat_age_sec = max(0, int((now - last_utc).total_seconds()))
    else:
        heartbeat_age_sec = None

    worker_queues = [str(x).strip() for x in (hb.get("queues") or []) if str(x).strip()]
    queue_overlap = sorted(set(worker_queues).intersection(set(configured)))

    ok = False
    reason = "no_heartbeat"
    suggestion = "Start worker using scripts/local_run_worker.ps1."

    if heartbeat_age_sec is not None and heartbeat_age_sec <= HEARTBEAT_STALE_SECONDS:
        if configured and worker_queues and not queue_overlap:
            ok = False
            reason = "queue_mismatch"
            suggestion = "Worker queues do not match task routes. Start worker with -Q celery."
        else:
            ok = True
            reason = "healthy"
            suggestion = "Worker heartbeat is fresh."
    else:
        pending_total = pending.get("total")
        if isinstance(pending_total, int) and pending_total > 0:
            reason = "no_recent_heartbeat_with_backlog"
            suggestion = "Tasks are queued but worker heartbeat is stale. Restart worker and verify queue list."
        else:
            reason = "no_recent_heartbeat"
            suggestion = "No fresh heartbeat detected. Confirm worker process is running."

    return {
        "ok": ok,
        "reason": reason,
        "suggestion": suggestion,
        "last_heartbeat_at": last.isoformat() if isinstance(last, datetime) else None,
        "heartbeat_age_sec": heartbeat_age_sec,
        "worker_name": hb.get("worker_name") or None,
        "queues": {
            "configured": configured,
            "worker": worker_queues,
            "overlap": queue_overlap,
        },
        "broker": _mask_broker(broker),
        "result_backend": _mask_broker(backend),
        "pending_messages": pending,
        "routing": {
            "task_default_queue": celery_client.conf.get("task_default_queue"),
            "task_routes": celery_client.conf.get("task_routes") or {},
        },
        "heartbeat_threshold_sec": HEARTBEAT_STALE_SECONDS,
    }
