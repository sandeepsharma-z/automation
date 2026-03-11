from __future__ import annotations

from pathlib import Path
from typing import Final

from app.core.config import get_settings

_ALLOWED_EXTENSIONS: Final[set[str]] = {"png", "jpg", "jpeg", "webp", "gif", "bmp"}


def guess_image_extension(binary: bytes, fallback: str = "png") -> str:
    data = bytes(binary or b"")
    if data.startswith(b"\x89PNG\r\n\x1a\n"):
        return "png"
    if data.startswith(b"\xff\xd8\xff"):
        return "jpg"
    if len(data) >= 12 and data[0:4] == b"RIFF" and data[8:12] == b"WEBP":
        return "webp"
    if data.startswith((b"GIF87a", b"GIF89a")):
        return "gif"
    if data.startswith(b"BM"):
        return "bmp"

    normalized = str(fallback or "png").strip().lower().lstrip(".")
    return normalized if normalized in _ALLOWED_EXTENSIONS else "png"


def save_binary_image(
    *,
    project_id: int,
    draft_id: int,
    kind: str,
    index: int,
    binary: bytes,
    extension: str,
    max_bytes: int = 2 * 1024 * 1024,
) -> str:
    payload = bytes(binary or b"")
    if not payload:
        raise ValueError("Cannot save empty image payload")
    if max_bytes > 0 and len(payload) > max_bytes:
        raise ValueError(f"Image payload exceeds max size ({max_bytes} bytes)")

    ext = str(extension or "png").strip().lower().lstrip(".")
    if ext not in _ALLOWED_EXTENSIONS:
        ext = "png"

    safe_kind = "".join(ch if ch.isalnum() or ch in {"_", "-"} else "_" for ch in str(kind or "image")).strip("_")
    if not safe_kind:
        safe_kind = "image"

    settings = get_settings()
    base_dir = Path(settings.media_path)
    target_dir = base_dir / f"project_{int(project_id)}" / f"draft_{int(draft_id)}"
    target_dir.mkdir(parents=True, exist_ok=True)

    filename = f"{safe_kind}_{int(index)}.{ext}"
    file_path = target_dir / filename
    file_path.write_bytes(payload)
    return str(file_path)
