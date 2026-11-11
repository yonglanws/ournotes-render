"""本地状态：JSON 持久化、产物清理与剧本落盘。"""

from __future__ import annotations

import json
import os
import re
import time
import unicodedata
from datetime import datetime
from pathlib import Path
from typing import Any


class JsonState:
    """单文件 JSON 状态；写入走临时文件 + 原子替换，进程退出不会留下半截文件。"""

    def __init__(self, path: Path) -> None:
        self.path = path

    def load(self, default: Any) -> Any:
        try:
            if not self.path.exists():
                return default
            with open(self.path, "r", encoding="utf-8") as handle:
                data = json.load(handle)
            return data if isinstance(data, type(default)) else default
        except (OSError, ValueError):
            return default

    def save(self, data: Any) -> None:
        try:
            self.path.parent.mkdir(parents=True, exist_ok=True)
            tmp = self.path.with_suffix(self.path.suffix + ".tmp")
            with open(tmp, "w", encoding="utf-8") as handle:
                json.dump(data, handle, ensure_ascii=False, indent=2)
            os.replace(tmp, self.path)
        except (OSError, ValueError):
            # 持久化失败不影响本次生成，下次启动退回默认值即可
            pass


def safe_stem(value: Any, fallback: str = "script") -> str:
    text = unicodedata.normalize("NFKC", str(value or "")).strip()
    text = re.sub(r"[^\w-]+", "-", text, flags=re.UNICODE)
    text = re.sub(r"-{2,}", "-", text).strip("-._")
    return text[:60].strip("-._") or fallback


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


def write_json_file(path: Path, data: Any) -> bool:
    """写一份 UTF-8 JSON；失败只记录为 False，由调用方决定如何提示。"""
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp = path.with_suffix(path.suffix + ".tmp")
        with open(tmp, "w", encoding="utf-8") as handle:
            json.dump(data, handle, ensure_ascii=False, indent=2)
        os.replace(tmp, path)
        return True
    except (OSError, TypeError, ValueError):
        return False


def prune_files(directory: Path, max_files: int, pattern: str = "*.mp4") -> int:
    """按修改时间保留最近 max_files 个文件，返回删除数量。"""
    if max_files <= 0:
        return 0
    try:
        files = sorted(
            (entry for entry in directory.glob(pattern) if entry.is_file()),
            key=lambda entry: entry.stat().st_mtime,
            reverse=True,
        )
    except OSError:
        return 0
    removed = 0
    for entry in files[max_files:]:
        try:
            entry.unlink()
            removed += 1
        except OSError:
            pass
    return removed


def prune_scripts(data_dir: Path | str, keep: int = 50) -> int:
    """Delete the oldest ``*.json`` scripts beyond ``keep``. Returns the number deleted."""
    return prune_files(Path(data_dir), keep, "*.json")


def prune_old_files(directory: Path, max_age_seconds: float, pattern: str = "*") -> int:
    """删除超过时限的产物，返回删除数量。"""
    if max_age_seconds <= 0:
        return 0
    cutoff = time.time() - max_age_seconds
    removed = 0
    try:
        entries = list(directory.glob(pattern))
    except OSError:
        return 0
    for entry in entries:
        try:
            if entry.is_file() and entry.stat().st_mtime < cutoff:
                entry.unlink()
                removed += 1
        except OSError:
            pass
    return removed
