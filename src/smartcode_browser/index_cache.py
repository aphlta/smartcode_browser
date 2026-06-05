"""符号索引磁盘缓存。

首次索引较慢；结果写入 ``~/.cache/smartcode-browser/<project_id>/``，
重启服务后若源码未变则直接加载，避免重复 tree-sitter 扫描。

失效条件：项目 root/include_paths/exclude 变化、缓存版本升级、
任一已索引文件的 mtime/size 变化。
"""

from __future__ import annotations

import os
import pickle
from dataclasses import dataclass
from pathlib import Path

from .models import Symbol
from .registry import Project

# 索引逻辑或 Symbol 字段变更时递增，使旧缓存自动失效
_CACHE_FORMAT = "v2"

# 环境变量 SMARTCODE_BROWSER_CACHE：缓存根目录；设为 ``0`` 或 ``off`` 禁用
_CACHE_ENV = "SMARTCODE_BROWSER_CACHE"


def cache_enabled() -> bool:
    v = os.environ.get(_CACHE_ENV, "").strip().lower()
    return v not in ("0", "off", "false", "no")


def cache_root() -> Path:
    raw = os.environ.get(_CACHE_ENV, "").strip()
    if raw and cache_enabled():
        return Path(raw).expanduser()
    return Path.home() / ".cache" / "smartcode-browser"


def cache_file(project_id: str) -> Path:
    return cache_root() / project_id / f"index-{_CACHE_FORMAT}.pkl"


@dataclass
class IndexCacheMeta:
    format: str
    project_id: str
    root: str
    language: str
    include_paths: list[str]
    exclude_dirs: list[str]
    max_files: int


@dataclass
class IndexCachePayload:
    meta: IndexCacheMeta
    manifest: dict[str, tuple[float, int]]  # rel -> (mtime_ns, size)
    by_name: dict[str, list[Symbol]]
    by_file: dict[str, list[Symbol]]
    file_count: int
    truncated: bool


def _meta_from_project(
    project: Project, project_id: str, max_files: int
) -> IndexCacheMeta:
    return IndexCacheMeta(
        format=_CACHE_FORMAT,
        project_id=project_id,
        root=str(project.root.resolve()),
        language=project.language,
        include_paths=list(project.include_paths),
        exclude_dirs=list(project.exclude_dirs),
        max_files=max_files,
    )


def _meta_matches(
    project: Project, project_id: str, meta: IndexCacheMeta, max_files: int
) -> bool:
    cur = _meta_from_project(project, project_id, max_files)
    return (
        meta.format == cur.format
        and meta.project_id == cur.project_id
        and meta.root == cur.root
        and meta.language == cur.language
        and meta.include_paths == cur.include_paths
        and meta.exclude_dirs == cur.exclude_dirs
        and meta.max_files == cur.max_files
    )


def file_stamp(path: Path) -> tuple[float, int] | None:
    try:
        st = path.stat()
        return (st.st_mtime_ns, st.st_size)
    except OSError:
        return None


def manifest_valid(project: Project, manifest: dict[str, tuple[float, int]]) -> bool:
    root = project.root
    for rel, stamp in manifest.items():
        cur = file_stamp(root / rel)
        if cur != stamp:
            return False
    return True


def try_load(
    project: Project, project_id: str, max_files: int
) -> IndexCachePayload | None:
    """命中则返回载荷，否则 None。"""
    if not cache_enabled():
        return None
    path = cache_file(project_id)
    if not path.is_file():
        return None
    try:
        with path.open("rb") as f:
            payload: IndexCachePayload = pickle.load(f)
    except Exception:
        return None
    if not _meta_matches(project, project_id, payload.meta, max_files):
        return None
    if not manifest_valid(project, payload.manifest):
        return None
    return payload


def save(
    project: Project,
    project_id: str,
    max_files: int,
    manifest: dict[str, tuple[float, int]],
    by_name: dict[str, list[Symbol]],
    by_file: dict[str, list[Symbol]],
    file_count: int,
    truncated: bool,
) -> None:
    if not cache_enabled():
        return
    path = cache_file(project_id)
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        payload = IndexCachePayload(
            meta=_meta_from_project(project, project_id, max_files),
            manifest=manifest,
            by_name=by_name,
            by_file=by_file,
            file_count=file_count,
            truncated=truncated,
        )
        tmp = path.with_suffix(".tmp")
        with tmp.open("wb") as f:
            pickle.dump(payload, f, protocol=pickle.HIGHEST_PROTOCOL)
        tmp.replace(path)
    except OSError:
        pass
