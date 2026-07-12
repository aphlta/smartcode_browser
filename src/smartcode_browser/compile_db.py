"""编译数据库（``compile_commands.json``）适配。

为什么需要它：纯 tree-sitter + grep 只能按「名字」找定义，遇到多 arch 同名
（如内核 ``__am_irq_handle`` 在 6 个 arch 各有一份）、``#ifdef`` 条件编译时只能
靠启发式猜。编译数据库记录了**本次编译实际用到的每个翻译单元（.c/.S）及其
-I / -D**，于是我们可以：

1. 标记「哪些源文件真的被编译」→ 解析候选时让被编译的那一份排在最前（甚至独占）。
2. 拿到每个 TU 的头文件搜索路径（-I）→ 解析头文件里的宏/inline 时，优先选当前
   TU 可达的那个头文件，而不是别的 arch 的同名头。
3. 暴露每个 TU 的宏定义（-D）→ 供后续按 ``#ifdef`` 取活动分支（暂存留待扩展）。

设计原则：**纯增量、可缺省**。项目未配置 ``compile_commands`` 时，本模块完全不
参与，行为与之前一致。解析结果按 compile_commands.json 的 mtime/size 做磁盘缓存，
避免每次启动都重解析数万条目的大 JSON。
"""

from __future__ import annotations

import json
import os
import pickle
import shlex
import sys
from dataclasses import dataclass, field
from pathlib import Path

from .index_cache import cache_enabled, cache_root, file_stamp

# 解析逻辑或字段变更时递增，使旧缓存失效
_CACHE_FORMAT = "ccdb-v2"

# 视为「翻译单元源文件」的后缀（编译数据库通常只列这些）
_TU_EXTS = (".c", ".cc", ".cpp", ".cxx", ".c++", ".s", ".S")


@dataclass
class CompileDB:
    """解析后的编译数据库（路径均为相对项目根的 posix 字符串）。"""

    # 实际被编译的源文件（相对根）
    compiled_files: set[str] = field(default_factory=set)
    # 出现在编译集中的后缀集合（用于判断是否对某后缀启用「未编译惩罚」）
    compiled_exts: set[str] = field(default_factory=set)
    # 每个 TU 的头文件搜索目录（-I/-isystem/-iquote），相对根或绝对
    tu_includes: dict[str, tuple[str, ...]] = field(default_factory=dict)
    # 每个 TU 的宏定义（-D 之后的原始 token）
    tu_defines: dict[str, tuple[str, ...]] = field(default_factory=dict)

    def __bool__(self) -> bool:
        return bool(self.compiled_files)

    def is_compiled(self, rel: str) -> bool:
        return _norm(rel) in self.compiled_files

    def covers_ext(self, rel: str) -> bool:
        """该后缀是否出现在编译集中（否则不应对它施加未编译惩罚）。"""
        ext = os.path.splitext(rel)[1]
        return ext in self.compiled_exts

    def include_dirs_for(self, rel: str) -> tuple[str, ...]:
        return self.tu_includes.get(_norm(rel), ())

    def defines_for(self, rel: str) -> tuple[str, ...]:
        return self.tu_defines.get(_norm(rel), ())

    def resolve_tu(self, rel: str) -> str | None:
        """为任意源文件/头文件找到最相关的翻译单元（用于展示 -D/-I）。"""
        rel = _norm(rel)
        if rel in self.compiled_files:
            return rel
        stem, ext = os.path.splitext(rel)
        if ext in (".h", ".hpp", ".hh", ".inc"):
            for cext in (".c", ".cc", ".cpp", ".cxx", ".S", ".s"):
                cand = stem + cext
                if cand in self.compiled_files:
                    return cand
        parent = rel.rsplit("/", 1)[0] if "/" in rel else ""
        best: str | None = None
        for tu in self.compiled_files:
            tu_dir = tu.rsplit("/", 1)[0] if "/" in tu else ""
            if parent and (tu == parent or tu.startswith(parent + "/") or tu_dir == parent):
                if best is None or len(tu) < len(best):
                    best = tu
        return best

    def context_for(self, rel: str) -> dict:
        """返回某文件对应的编译上下文（供 API / 前端展示）。"""
        rel = _norm(rel)
        tu = self.resolve_tu(rel)
        if not tu:
            return {
                "available": True,
                "file": rel,
                "tu_file": None,
                "direct_compiled": False,
                "defines": [],
                "defines_total": 0,
                "includes": [],
                "includes_total": 0,
            }
        defines = self.tu_defines.get(tu, ())
        includes = self.tu_includes.get(tu, ())
        return {
            "available": True,
            "file": rel,
            "tu_file": tu,
            "direct_compiled": rel in self.compiled_files,
            "defines": list(defines[:48]),
            "defines_total": len(defines),
            "includes": list(includes[:24]),
            "includes_total": len(includes),
        }


def _norm(p: str) -> str:
    return p.replace("\\", "/")


def _rel_to_root(path: Path, root: Path) -> str | None:
    try:
        return _norm(str(path.resolve().relative_to(root)))
    except (ValueError, OSError):
        return None


def _arg_tokens(entry: dict) -> list[str]:
    """统一取出编译参数 token 列表（兼容 arguments 列表与 command 字符串）。"""
    args = entry.get("arguments")
    if isinstance(args, list) and args:
        return [str(a) for a in args]
    cmd = entry.get("command")
    if isinstance(cmd, str) and cmd:
        try:
            return shlex.split(cmd)
        except ValueError:
            return cmd.split()
    return []


def _parse_flags(
    tokens: list[str], directory: Path, root: Path
) -> tuple[tuple[str, ...], tuple[str, ...]]:
    """从参数里抽取头文件搜索目录与宏定义。

    -I/-iquote/-isystem 的目录相对 ``directory`` 解析，能落入项目根的转为
    根相对路径（便于与 by_file 的 key 比较），否则保留绝对路径。
    """
    includes: list[str] = []
    defines: list[str] = []
    i = 0
    n = len(tokens)

    def add_inc(raw: str) -> None:
        if not raw:
            return
        p = (directory / raw).resolve() if not os.path.isabs(raw) else Path(raw)
        rel = _rel_to_root(p, root)
        includes.append(rel if rel is not None else _norm(str(p)))

    while i < n:
        t = tokens[i]
        if t in ("-I", "-iquote", "-isystem", "-idirafter"):
            if i + 1 < n:
                add_inc(tokens[i + 1])
                i += 2
                continue
        elif t.startswith("-I"):
            add_inc(t[2:])
        elif t == "-D":
            if i + 1 < n:
                defines.append(tokens[i + 1])
                i += 2
                continue
        elif t.startswith("-D"):
            defines.append(t[2:])
        i += 1

    # 去重保序
    return tuple(dict.fromkeys(includes)), tuple(dict.fromkeys(defines))


def _parse_json(cc_path: Path, root: Path) -> CompileDB:
    try:
        raw = json.loads(cc_path.read_text(encoding="utf-8", errors="replace"))
    except (OSError, ValueError):
        return CompileDB()
    if not isinstance(raw, list):
        return CompileDB()

    db = CompileDB()
    for entry in raw:
        if not isinstance(entry, dict):
            continue
        f = entry.get("file")
        if not isinstance(f, str) or not f:
            continue
        directory = Path(entry.get("directory") or str(root))
        tu_path = (directory / f) if not os.path.isabs(f) else Path(f)
        rel = _rel_to_root(tu_path, root)
        if rel is None:
            continue
        ext = os.path.splitext(rel)[1]
        if ext not in _TU_EXTS:
            continue

        db.compiled_files.add(rel)
        db.compiled_exts.add(ext)

        tokens = _arg_tokens(entry)
        if tokens:
            includes, defines = _parse_flags(tokens, directory, root)
            # intern 目录字符串，降低大库（数万 TU）下的内存占用
            if includes:
                db.tu_includes[rel] = tuple(sys.intern(x) for x in includes)
            if defines:
                db.tu_defines[rel] = tuple(sys.intern(x) for x in defines)
    return db


# --- 磁盘缓存（按 compile_commands.json 的 mtime/size 失效） ---


def _cache_path(project_id: str) -> Path:
    return cache_root() / project_id / f"{_CACHE_FORMAT}.pkl"


def merge_compile_dbs(dbs: list[CompileDB]) -> CompileDB:
    """合并多份子工程的 compile_commands（后者覆盖同路径 TU 的 -I/-D）。"""
    out = CompileDB()
    for db in dbs:
        if not db:
            continue
        out.compiled_files |= db.compiled_files
        out.compiled_exts |= db.compiled_exts
        out.tu_includes.update(db.tu_includes)
        out.tu_defines.update(db.tu_defines)
    return out


def _resolve_cc_paths(root: Path, compile_commands: str | list[str]) -> list[Path]:
    if isinstance(compile_commands, str):
        paths = [compile_commands] if compile_commands else []
    else:
        paths = [p for p in compile_commands if p]
    resolved: list[Path] = []
    for rel in paths:
        cc_path = Path(rel)
        if not cc_path.is_absolute():
            cc_path = root / rel
        if cc_path.is_file():
            resolved.append(cc_path)
    return resolved


def load(
    root: Path, project_id: str, compile_commands: str | list[str]
) -> CompileDB | None:
    """加载并解析项目的编译数据库（支持多路径合并）；未配置或全部缺失返回 None。"""
    cc_paths = _resolve_cc_paths(root, compile_commands)
    if not cc_paths:
        return None

    stamps = tuple((str(p), file_stamp(p)) for p in cc_paths)
    cache_p = _cache_path(project_id)
    if cache_enabled() and cache_p.is_file():
        try:
            with cache_p.open("rb") as fh:
                cached = pickle.load(fh)
            if cached.get("stamps") == stamps and cached.get("format") == _CACHE_FORMAT:
                return cached["db"]
        except Exception:
            pass

    root_res = root.resolve()
    db = merge_compile_dbs([_parse_json(p, root_res) for p in cc_paths])
    if not db:
        return None

    if cache_enabled():
        try:
            cache_p.parent.mkdir(parents=True, exist_ok=True)
            tmp = cache_p.with_suffix(".tmp")
            with tmp.open("wb") as fh:
                pickle.dump(
                    {"format": _CACHE_FORMAT, "stamps": stamps, "db": db},
                    fh,
                    protocol=pickle.HIGHEST_PROTOCOL,
                )
            tmp.replace(cache_p)
        except OSError:
            pass
    return db
