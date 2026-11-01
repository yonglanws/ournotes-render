"""Write a generated script to the plugin data directory and prune old files."""

from __future__ import annotations

import json
import re
import unicodedata
from datetime import datetime
from pathlib import Path
from typing import Any


def safe_stem(title: Any, fallback: str = "script") -> str:
    value = unicodedata.normalize("NFKC", str(title or "")).strip()
    value = re.sub(r"[^\w-]+", "-", value, flags=re.UNICODE)
    value = re.sub(r"-{2,}", "-", value).strip("-._")
    return value[:60].strip("-._") or fallback


def script_path(
    data_dir: Path | str, title: Any, *, when: datetime | None = None
) -> Path:
    stamp = (when or datetime.now().astimezone()).strftime("%Y%m%d-%H%M%S-%f")[:-3]
    return Path(data_dir) / f"{safe_stem(title)}-{stamp}.json"


def write_script_file(
    data_dir: Path | str,
    document: Any,
    *,
    title: Any = "",
    when: datetime | None = None,
) -> Path:
    directory = Path(data_dir)
    directory.mkdir(parents=True, exist_ok=True)
    if not title and isinstance(document, dict):
        title = document.get("title") or ""
    path = script_path(directory, title, when=when)
    path.write_text(
        json.dumps(document, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    return path


def prune_scripts(data_dir: Path | str, keep: int = 50) -> int:
    """Delete the oldest ``*.json`` scripts beyond ``keep``. Returns the number deleted."""
    keep = max(1, int(keep))
    directory = Path(data_dir)
    if not directory.is_dir():
        return 0
    files = sorted(
        (path for path in directory.glob("*.json") if path.is_file()),
        key=lambda path: path.stat().st_mtime,
        reverse=True,
    )
    deleted = 0
    for path in files[keep:]:
        try:
            path.unlink()
            deleted += 1
        except OSError:
            continue
    return deleted
