"""从项目根目录 ``.vscode/launch.json`` 读取 GDB 调试配置。

SmartCode 浏览器在本机跑时，用户往往已在 VS Code 里配好了 ``cppdbg`` /
``lldb`` 启动项（含 AM native 的 ``handle SIGUSR1...`` 等）。本模块把这些
配置抽成统一结构，供前端生成 GDB 断点脚本或后续 GDB/MI 桥接使用。

设计：纯只读、可缺省——没有 launch.json 时返回空列表，不影响浏览功能。
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass, field
from pathlib import Path

# VS Code 变量：仅展开 workspace 根，其余 ${input:...} 保留占位
_VAR_WS = re.compile(r"\$\{(?:workspaceFolder|workspaceRoot)\}")


@dataclass
class DebugProfile:
    """一条可启动 GDB 的调试配置。"""

    id: str
    name: str
    program: str
    cwd: str
    gdb: str = "gdb"
    args: list[str] = field(default_factory=list)
    setup: list[str] = field(default_factory=list)
    source: str = "launch.json"
    # 源码路径前缀：用于根据当前文件自动选中调试配置
    match_paths: list[str] = field(default_factory=list)
    needs_input: bool = False

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "name": self.name,
            "program": self.program,
            "cwd": self.cwd,
            "gdb": self.gdb,
            "args": self.args,
            "setup": self.setup,
            "source": self.source,
            "match_paths": self.match_paths,
            "needs_input": self.needs_input,
        }


def _expand_path(raw: str, root: Path) -> str:
    if not raw:
        return str(root)
    return _VAR_WS.sub(str(root), raw)


def _has_unexpanded_vars(s: str) -> bool:
    return "${" in s


def _slug(name: str) -> str:
    s = re.sub(r"[^\w\-]+", "-", name.strip().lower()).strip("-")
    return s or "profile"


def _norm_path(p: str) -> str:
    return p.replace("\\", "/")


def _infer_match_paths(root: Path, program: str, cwd: str) -> list[str]:
    """从 launch.json 的 program/cwd 推断源码路径前缀。"""
    prefixes: list[str] = []
    root = root.resolve()
    for raw in (cwd, program):
        if not raw or "${" in raw:
            continue
        try:
            rel = Path(raw).resolve().relative_to(root)
            s = _norm_path(str(rel))
            prefixes.append(s)
            parts = s.split("/")
            if parts and parts[0]:
                prefixes.append(parts[0] + "/")
        except ValueError:
            continue
    joined = " ".join(prefixes)
    if "rt-thread-am" in joined:
        prefixes.extend(["rt-thread-am/", "abstract-machine/"])
    elif "am-kernels" in joined or "yield-os" in joined:
        prefixes.extend(["am-kernels/", "abstract-machine/"])
    elif "nemu" in joined:
        prefixes.append("nemu/")
    return list(dict.fromkeys(prefixes))


def suggest_debug_profile(profiles: list[DebugProfile], file: str) -> DebugProfile | None:
    """按源码路径前缀匹配最合适的调试配置。"""
    file = _norm_path(file)
    best: DebugProfile | None = None
    best_len = 0
    for p in profiles:
        if p.needs_input:
            continue
        for prefix in p.match_paths:
            prefix = _norm_path(prefix)
            if file.startswith(prefix) and len(prefix) > best_len:
                best = p
                best_len = len(prefix)
    return best


def load_from_launch_json(root: Path) -> list[DebugProfile]:
    path = root / ".vscode" / "launch.json"
    if not path.is_file():
        return []
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return []

    profiles: list[DebugProfile] = []
    seen_ids: set[str] = set()
    for cfg in data.get("configurations") or []:
        if not isinstance(cfg, dict):
            continue
        if cfg.get("type") not in ("cppdbg", "lldb"):
            continue
        name = str(cfg.get("name") or "debug")
        pid = _slug(name)
        base = pid
        n = 2
        while pid in seen_ids:
            pid = f"{base}-{n}"
            n += 1
        seen_ids.add(pid)

        program = _expand_path(str(cfg.get("program") or ""), root)
        cwd = _expand_path(str(cfg.get("cwd") or str(root)), root)
        gdb = str(cfg.get("miDebuggerPath") or "gdb")
        args = [str(a) for a in (cfg.get("args") or [])]
        setup: list[str] = []
        for item in cfg.get("setupCommands") or []:
            if isinstance(item, dict):
                text = item.get("text")
                if text:
                    setup.append(str(text))

        needs = _has_unexpanded_vars(program) or _has_unexpanded_vars(cwd)
        match_paths = [str(x) for x in (cfg.get("match_paths") or [])]
        if not match_paths:
            match_paths = _infer_match_paths(root, program, cwd)
        profiles.append(
            DebugProfile(
                id=pid,
                name=name,
                program=program,
                cwd=cwd,
                gdb=gdb,
                args=args,
                setup=setup,
                match_paths=match_paths,
                needs_input=needs,
            )
        )
    return profiles


def load_debug_profiles(root: Path, registry_profiles: list[dict] | None = None) -> list[DebugProfile]:
    """合并 launch.json 与 registry 里显式声明的 debug_profiles（后者追加）。"""
    out = load_from_launch_json(root)
    seen = {p.id for p in out}
    for raw in registry_profiles or []:
        if not isinstance(raw, dict):
            continue
        name = str(raw.get("name") or raw.get("id") or "debug")
        pid = str(raw.get("id") or _slug(name))
        if pid in seen:
            continue
        seen.add(pid)
        program = _expand_path(str(raw.get("program") or ""), root)
        cwd = _expand_path(str(raw.get("cwd") or str(root)), root)
        match_paths = [str(x) for x in (raw.get("match_paths") or [])]
        if not match_paths:
            match_paths = _infer_match_paths(root, program, cwd)
        out.append(
            DebugProfile(
                id=pid,
                name=name,
                program=program,
                cwd=cwd,
                gdb=str(raw.get("gdb") or "gdb"),
                args=[str(a) for a in (raw.get("args") or [])],
                setup=[str(s) for s in (raw.get("setup") or [])],
                source="registry",
                match_paths=match_paths,
                needs_input=_has_unexpanded_vars(program) or _has_unexpanded_vars(cwd),
            )
        )
    return out
