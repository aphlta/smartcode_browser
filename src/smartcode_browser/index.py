"""跨文件符号索引。

职责：扫描一个项目的源码，提取所有可导航单元（Symbol），建立两张表：
- ``by_name``：name -> [Symbol]，用于把「引用」解析到「定义」（可多候选）
- ``by_file``：file -> [Symbol]，用于反查「某一行属于哪个符号」

索引是**惰性构建 + 内存缓存**：首次访问时扫描一次，之后命中缓存。
大库（如内核全树）应通过项目的 include_paths 限定范围，避免扫描爆炸。
"""

from __future__ import annotations

import os
import re
import subprocess
import threading
from pathlib import Path

from .adapters import LanguageAdapter, get_adapter
from .models import Symbol
from .registry import Project

# 单个项目索引的文件数量上限，超过则截断并告警，防止误把超大库全量扫描
_MAX_FILES = 20000

# 全局回退搜索时，最多解析的候选文件数（grep 命中后逐个 tree-sitter 确认）
_MAX_GLOBAL_FILES = 40

# 合法标识符（防止把任意字符串拼进 grep 正则）
_IDENT_RE = re.compile(r"^[A-Za-z_]\w*$")


class SymbolIndex:
    """单个项目的符号索引。"""

    def __init__(self, project: Project) -> None:
        self.project = project
        self._adapters = self._build_adapters(project)
        self._by_name: dict[str, list[Symbol]] = {}
        self._by_file: dict[str, list[Symbol]] = {}
        self._built = False
        self._lock = threading.Lock()
        self._file_count = 0
        self._truncated = False
        # 全局回退解析的结果缓存（含负缓存：值为空列表表示确实没找到）
        self._global_cache: dict[str, list[Symbol]] = {}
        self._global_lock = threading.Lock()

    # --- 适配器选择 ---

    @staticmethod
    def _build_adapters(project: Project) -> list[LanguageAdapter]:
        """主语言 + 附加语言，去重后返回适配器列表。"""
        langs = [project.language, *project.extra_languages]
        adapters: list[LanguageAdapter] = []
        seen: set[str] = set()
        for lang in langs:
            try:
                ad = get_adapter(lang)
            except KeyError:
                continue
            if ad.name not in seen:
                seen.add(ad.name)
                adapters.append(ad)
        return adapters

    def adapter_for(self, rel_path: str) -> LanguageAdapter | None:
        """按文件后缀选择负责的适配器。"""
        for ad in self._adapters:
            if ad.handles(rel_path):
                return ad
        return None

    # --- 构建 ---

    def _iter_source_files(self):
        """遍历项目范围内、且有适配器能处理的源文件，产出相对路径。"""
        root = self.project.root
        exclude = set(self.project.exclude_dirs)
        # 限定扫描的起点目录：include_paths 为空则从根开始
        bases = self.project.include_paths or ["."]

        for base in bases:
            base_dir = (root / base).resolve()
            if not base_dir.is_dir():
                continue
            for dirpath, dirnames, filenames in os.walk(base_dir):
                # 原地裁剪被排除目录，避免深入
                dirnames[:] = [d for d in dirnames if d not in exclude]
                for fn in filenames:
                    full = Path(dirpath) / fn
                    try:
                        rel = str(full.relative_to(root))
                    except ValueError:
                        continue
                    if self.adapter_for(rel) is not None:
                        yield rel

    def build(self) -> None:
        """惰性构建索引（线程安全，幂等）。"""
        if self._built:
            return
        with self._lock:
            if self._built:
                return
            for rel in self._iter_source_files():
                if self._file_count >= _MAX_FILES:
                    self._truncated = True
                    break
                self._index_file(rel)
                self._file_count += 1
            self._built = True

    def _index_file(self, rel_path: str) -> None:
        adapter = self.adapter_for(rel_path)
        if adapter is None:
            return
        full = self.project.root / rel_path
        try:
            source = full.read_bytes()
        except OSError:
            return
        try:
            symbols = adapter.extract_symbols(source, rel_path)
        except Exception:
            # 单文件解析失败不应中断整体索引（语法极端的文件容忍跳过）
            return
        if not symbols:
            return
        self._by_file.setdefault(rel_path, []).extend(symbols)
        for sym in symbols:
            self._by_name.setdefault(sym.name, []).append(sym)

    # --- 查询 ---

    def lookup(self, name: str) -> list[Symbol]:
        """按精确名取所有候选定义。"""
        self.build()
        return list(self._by_name.get(name, []))

    def symbols_in_file(self, rel_path: str) -> list[Symbol]:
        self.build()
        return list(self._by_file.get(rel_path, []))

    def symbol_at(self, rel_path: str, line: int) -> Symbol | None:
        """返回包含指定行的符号（取范围最小、最贴近的一个）。"""
        self.build()
        best: Symbol | None = None
        for sym in self._by_file.get(rel_path, []):
            if sym.start_line <= line <= sym.end_line:
                if best is None or (sym.end_line - sym.start_line) < (
                    best.end_line - best.start_line
                ):
                    best = sym
        return best

    def search(self, query: str, limit: int = 40) -> list[Symbol]:
        """按名称模糊搜索符号：前缀优先，其次子串。"""
        self.build()
        q = query.strip()
        if not q:
            return []
        ql = q.lower()
        exact: list[Symbol] = []
        prefix: list[Symbol] = []
        substr: list[Symbol] = []
        for name, syms in self._by_name.items():
            nl = name.lower()
            if nl == ql:
                exact.extend(syms)
            elif nl.startswith(ql):
                prefix.extend(syms)
            elif ql in nl:
                substr.extend(syms)
        ranked = exact + prefix + substr
        return ranked[:limit]

    # --- 全局按需回退解析 ---

    def global_lookup(self, name: str) -> list[Symbol]:
        """当范围内索引找不到某符号时，在整个项目根下按需搜索其定义。

        这是「无需手工调 include_paths」的关键：用 grep 快速定位**定义样式**的行，
        再用 tree-sitter 解析候选文件确认，避免把调用点误当定义。结果（含负结果）
        缓存，故同一符号只搜一次。
        """
        if not _IDENT_RE.match(name):
            return []
        if name in self._global_cache:
            return self._global_cache[name]
        with self._global_lock:
            if name in self._global_cache:
                return self._global_cache[name]
            result = self._grep_definitions(name)
            self._global_cache[name] = result
            return result

    def _grep_patterns(self, name: str) -> str:
        """构造「定义样式」的 ERE：

        1) 行首即出现 `type ... name(`（函数定义通常顶格写，调用则缩进）
        2) 顶格 K&R 风格 `name(`
        3) 宏定义 `#define name` / `#define name(`
        4) 结构体/联合/枚举 **字段**、文件级变量、枚举常量（缩进行）
        命中后仍会经 tree-sitter 确认，故允许少量误命中。
        """
        n = name
        return (
            # 函数定义（顶格 type ... name( ）
            rf"^([A-Za-z_].*[^A-Za-z0-9_])?{n}[[:space:]]*\("
            # 宏定义
            rf"|^[[:space:]]*#[[:space:]]*define[[:space:]]+{n}([[:space:]]|\(|$)"
            # 结构体/联合/枚举类型定义： [typedef] struct|union|enum NAME {
            rf"|^[[:space:]]*(typedef[[:space:]]+)?(struct|union|enum)[[:space:]]+{n}[[:space:]]*\{{"
            # typedef ... NAME;
            rf"|^[[:space:]]*typedef[[:space:]].*[^A-Za-z0-9_]{n}[[:space:]]*;"
            # 结构体字段 / 文件级变量（缩进 type ... name; 或 name =）
            rf"|^[[:space:]]+[A-Za-z_][A-Za-z0-9_[:space:]\*]*[[:space:]]+{n}[[:space:]]*[;=]"
            # 枚举常量：  NAME,  或  NAME =
            rf"|^[[:space:]]+{n}[[:space:]]*[,=]"
        )

    def _grep_definitions(self, name: str) -> list[Symbol]:
        root = self.project.root
        include_args: list[str] = []
        for ad in self._adapters:
            for ext in ad.extensions:
                include_args += ["--include", "*" + ext]
        exclude_args: list[str] = []
        for d in self.project.exclude_dirs:
            exclude_args += ["--exclude-dir", d]

        cmd = [
            "grep", "-rInE", self._grep_patterns(name),
            *include_args, *exclude_args, str(root),
        ]
        try:
            proc = subprocess.run(
                cmd, capture_output=True, text=True, timeout=20, check=False
            )
        except (subprocess.TimeoutExpired, FileNotFoundError):
            return []

        # 收集候选文件（去重，限量），逐个用适配器解析确认
        candidate_files: list[str] = []
        seen_files: set[str] = set()
        for line in proc.stdout.splitlines():
            parts = line.split(":", 2)
            if len(parts) < 3:
                continue
            try:
                rel = str(Path(parts[0]).relative_to(root))
            except ValueError:
                continue
            if rel in seen_files:
                continue
            seen_files.add(rel)
            candidate_files.append(rel)
            if len(candidate_files) >= _MAX_GLOBAL_FILES:
                break

        results: list[Symbol] = []
        seen_defs: set[tuple[str, int]] = set()
        for rel in candidate_files:
            adapter = self.adapter_for(rel)
            if adapter is None:
                continue
            full = root / rel
            try:
                source = full.read_bytes()
            except OSError:
                continue
            try:
                symbols = adapter.extract_symbols(source, rel)
            except Exception:
                continue
            for sym in symbols:
                if sym.name != name:
                    continue
                key = (sym.file, sym.start_line)
                if key in seen_defs:
                    continue
                seen_defs.add(key)
                results.append(sym)
        return results

    def grep_word(self, name: str, limit: int = 200) -> list[tuple[str, int, str]]:
        """全词搜索 name 的所有出现（用于「查找用法」），返回 (相对路径, 行号, 行文本)。

        命中可能很多（如常见变量名），故按 limit 截断；调用方再按所属函数聚合。
        """
        if not _IDENT_RE.match(name):
            return []
        root = self.project.root
        include_args: list[str] = []
        for ad in self._adapters:
            for ext in ad.extensions:
                include_args += ["--include", "*" + ext]
        exclude_args: list[str] = []
        for d in self.project.exclude_dirs:
            exclude_args += ["--exclude-dir", d]
        cmd = ["grep", "-rInw", name, *include_args, *exclude_args, str(root)]
        try:
            proc = subprocess.run(
                cmd, capture_output=True, text=True, timeout=25, check=False
            )
        except (subprocess.TimeoutExpired, FileNotFoundError):
            return []

        out: list[tuple[str, int, str]] = []
        for line in proc.stdout.splitlines():
            parts = line.split(":", 2)
            if len(parts) < 3:
                continue
            try:
                rel = str(Path(parts[0]).relative_to(root))
                ln = int(parts[1])
            except ValueError:
                continue
            out.append((rel, ln, parts[2]))
            if len(out) >= limit:
                break
        return out

    # --- 诊断信息 ---

    @property
    def stats(self) -> dict:
        self.build()
        return {
            "files_indexed": self._file_count,
            "symbols": sum(len(v) for v in self._by_name.values()),
            "unique_names": len(self._by_name),
            "truncated": self._truncated,
            "adapters": [a.name for a in self._adapters],
        }
