"""多项目注册表。

一个「项目」= 一个代码库根目录 + 主语言 + 可选索引子路径。
同一浏览器可在 Linux 内核 / Chipyard / 自研项目间切换，引擎与前端无需改动。

注册表来源（按优先级）：
1) 环境变量 SMARTCODE_BROWSER_REGISTRY 指向的 YAML
2) 当前工作目录下的 projects/registry.yaml
3) 源码/安装包旁的 projects/registry.yaml
4) /etc/smartcode/registry.yaml（常见部署路径）
5) 若都不存在，回退到「浏览本包源码」的演示项目
"""

from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path

import yaml


@dataclass
class Project:
    """单个可浏览项目的配置。"""

    id: str
    name: str
    root: Path
    language: str
    include_paths: list[str] = field(default_factory=list)
    extra_languages: list[str] = field(default_factory=list)
    exclude_dirs: list[str] = field(default_factory=list)
    # 可选：编译数据库（compile_commands.json）相对/绝对路径。
    # 配置后用于「按实际编译的翻译单元」优先解析定义、消歧多 arch 同名。
    compile_commands: str = ""

    def exists(self) -> bool:
        return self.root.is_dir()

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "name": self.name,
            "root": str(self.root),
            "language": self.language,
            "include_paths": self.include_paths,
            "extra_languages": self.extra_languages,
            "compile_commands": self.compile_commands,
            "exists": self.exists(),
        }


_DEFAULT_EXCLUDES = [
    ".git", ".hg", ".svn", "node_modules", "__pycache__", ".venv",
    "build", "out", "target", "dist", ".idea", ".vscode",
]


def _package_dir() -> Path:
    return Path(__file__).resolve().parent


def _repo_root() -> Path:
    """开发 checkout 根目录（src/smartcode_browser → 上两级）。"""
    return _package_dir().parents[1]


def _registry_candidates() -> list[Path]:
    """按优先级列出可能存在的注册表路径。"""
    env = os.environ.get("SMARTCODE_BROWSER_REGISTRY")
    paths: list[Path] = []
    if env:
        paths.append(Path(env).expanduser())
    paths.append(Path.cwd() / "projects" / "registry.yaml")
    paths.append(_repo_root() / "projects" / "registry.yaml")
    paths.append(Path("/etc/smartcode/registry.yaml"))
    return paths


def _default_registry_path() -> Path | None:
    for p in _registry_candidates():
        if p.is_file():
            return p
    return None


def _builtin_projects() -> list[Project]:
    """无配置文件时的演示：浏览本包自身 Python 源码。"""
    root = _repo_root()
    return [
        Project(
            id="self",
            name="SmartCode Browser 自身 (Python)",
            root=root,
            language="python",
            include_paths=["src/smartcode_browser"],
            exclude_dirs=list(_DEFAULT_EXCLUDES) + [".venv", "dist", "build"],
        ),
    ]


def load_projects() -> list[Project]:
    """加载全部项目配置。"""
    path = _default_registry_path()
    if path is None:
        return _builtin_projects()

    data = yaml.safe_load(path.read_text(encoding="utf-8")) or {}
    projects: list[Project] = []
    for raw in data.get("projects", []):
        projects.append(
            Project(
                id=raw["id"],
                name=raw.get("name", raw["id"]),
                root=Path(raw["root"]).expanduser(),
                language=raw["language"],
                include_paths=raw.get("include_paths", []),
                extra_languages=raw.get("extra_languages", []),
                exclude_dirs=raw.get("exclude_dirs", list(_DEFAULT_EXCLUDES)),
                compile_commands=raw.get("compile_commands", ""),
            )
        )
    return projects or _builtin_projects()


class ProjectRegistry:
    """项目注册表：加载、按 id 查找、列出。"""

    def __init__(self, projects: list[Project] | None = None) -> None:
        self._projects = {p.id: p for p in (projects or load_projects())}

    def list(self) -> list[Project]:
        return list(self._projects.values())

    def get(self, project_id: str) -> Project:
        if project_id not in self._projects:
            raise KeyError(f"未注册的项目: {project_id}")
        return self._projects[project_id]

    def __contains__(self, project_id: str) -> bool:
        return project_id in self._projects
