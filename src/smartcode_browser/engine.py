"""代码浏览器引擎：串联注册表、适配器、索引，向 Web API 暴露语言无关方法。

这是 API 唯一需要打交道的对象。它的方法对应前端的核心动作：
- ``list_projects``     顶部项目下拉
- ``search``            符号搜索框
- ``open_symbol``       打开一个函数/方法 → Panel 内容（源码 + 可点击引用）
- ``resolve``           点击某个引用 → 候选定义（供级联开新 Panel）

引擎本身不感知任何具体语言；语言差异全部封装在适配器里。
"""

from __future__ import annotations

from .index import SymbolIndex
from .models import Definition, ResolvedReference, Symbol, SymbolDetail
from .registry import Project, ProjectRegistry


class CodeEngine:
    """多项目代码导航引擎（每个项目一份惰性索引，进程内缓存）。"""

    def __init__(self, registry: ProjectRegistry | None = None) -> None:
        self.registry = registry or ProjectRegistry()
        self._indexes: dict[str, SymbolIndex] = {}

    # --- 索引获取 ---

    def _index(self, project_id: str) -> SymbolIndex:
        if project_id not in self._indexes:
            project = self.registry.get(project_id)
            self._indexes[project_id] = SymbolIndex(project)
        return self._indexes[project_id]

    # --- 项目 ---

    def list_projects(self) -> list[dict]:
        return [p.to_dict() for p in self.registry.list()]

    def project_stats(self, project_id: str) -> dict:
        return self._index(project_id).stats

    # --- 搜索 ---

    def search(self, project_id: str, query: str, limit: int = 40) -> list[dict]:
        index = self._index(project_id)
        return [s.to_dict() for s in index.search(query, limit)]

    # --- 打开符号 ---

    def open_symbol(
        self,
        project_id: str,
        file: str,
        name: str | None = None,
        line: int | None = None,
    ) -> SymbolDetail | None:
        """打开一个符号，返回 Panel 所需的完整内容。

        定位方式（任选）：
        - file + name：按名字在该文件里找
        - file + line：按行号反查所在符号
        """
        index = self._index(project_id)
        project = self.registry.get(project_id)

        symbol = self._locate(index, file, name, line)
        if symbol is None:
            return None

        source = self._read_bytes(project, symbol.file)
        if source is None:
            return None

        adapter = index.adapter_for(symbol.file)
        if adapter is None:
            return None

        # 源码行（按符号范围切片）
        lines = self._read_lines(project, symbol.file, symbol.start_line, symbol.end_line)

        # 提取函数体内的引用。这里**不做**逐个解析（全局回退 grep 较慢），
        # 而是标记为可点击；真正的解析推迟到用户点击时（/api/resolve），
        # 既让打开面板瞬时完成，又能在点击时合并全局结果、给出全部实现。
        raw_refs = adapter.extract_references(
            source, symbol.file, symbol.start_line, symbol.end_line
        )
        resolved_refs: list[ResolvedReference] = [
            ResolvedReference(
                name=ref.name,
                line=ref.line,
                col=ref.col,
                end_col=ref.end_col,
                resolved=True,
                candidates=[],
            )
            for ref in raw_refs
        ]

        return SymbolDetail(
            name=symbol.name,
            kind=symbol.kind,
            file=symbol.file,
            start_line=symbol.start_line,
            end_line=symbol.end_line,
            signature=symbol.signature,
            doc=symbol.doc,
            lines=lines,
            references=resolved_refs,
        )

    # --- 解析引用 ---

    def resolve(self, project_id: str, name: str, from_file: str = "") -> list[dict]:
        """把一个引用名解析为**全部**候选定义并排序。

        合并「范围内索引」与「全局回退」的结果，去重后排序，使真正的实现
        排在空桩/头文件 inline 之前——解决「跳到 #ifdef 空实现」的问题。
        """
        index = self._index(project_id)
        merged = self._merged_candidates(index, name)
        ranked = self._rank_definitions(merged, from_file)
        return [d.to_dict() for d in ranked]

    # --- 变量/标识符解析（局部优先 + 全局） ---

    def resolve_at(
        self, project_id: str, file: str, name: str, line: int, col: int = 0
    ) -> list[dict]:
        """解析「某文件某行某列的标识符」：先在所在函数找局部声明（参数/局部变量），
        再合并全局候选（全局变量、字段、枚举、函数、宏）。用于变量跳转到声明。
        """
        index = self._index(project_id)
        project = self.registry.get(project_id)
        candidates: list[Definition] = []

        # 1) 局部声明：定位 enclosing 函数，在其范围内找声明
        enclosing = self._enclosing_function(index, project, file, line)
        if enclosing is not None:
            adapter = index.adapter_for(file)
            source = self._read_bytes(project, file)
            if adapter is not None and source is not None:
                decl_line = adapter.find_local_declaration(
                    source, enclosing.start_line, enclosing.end_line, name
                )
                if decl_line is not None:
                    candidates.append(
                        Definition(name=name, file=file, line=decl_line, kind="local")
                    )

        # 2) 全局候选（去重时排除已加入的局部）
        merged = self._merged_candidates(index, name)
        ranked = self._rank_definitions(merged, file)
        seen = {(c.file, c.line) for c in candidates}
        for d in ranked:
            if (d.file, d.line) not in seen:
                candidates.append(d)
        return [c.to_dict() for c in candidates]

    def find_usages(self, project_id: str, name: str, limit: int = 200) -> list[dict]:
        """查找标识符 name 的所有使用位置，按「所属函数」聚合返回。

        返回每条：{file, line, text, enclosing(所属函数名或''), enclosing_line}
        供前端列成「用法」面板，点击跳到对应位置。
        """
        index = self._index(project_id)
        project = self.registry.get(project_id)
        hits = index.grep_word(name, limit=limit)

        # 缓存每个文件的函数符号，避免重复解析
        func_cache: dict[str, list] = {}
        results: list[dict] = []
        for rel, ln, text in hits:
            enc = self._enclosing_function_cached(index, project, rel, ln, func_cache)
            results.append({
                "file": rel,
                "line": ln,
                "text": text.strip()[:200],
                "enclosing": enc.name if enc else "",
                "enclosing_line": enc.start_line if enc else ln,
            })
        return results

    def _enclosing_function(self, index, project: Project, file: str, line: int):
        return self._enclosing_function_cached(index, project, file, line, {})

    def _enclosing_function_cached(self, index, project: Project, file: str, line: int, cache: dict):
        """返回包含指定行的函数/方法符号（按需解析文件，范围最小者优先）。"""
        if file not in cache:
            adapter = index.adapter_for(file)
            source = self._read_bytes(project, file)
            syms = []
            if adapter is not None and source is not None:
                try:
                    syms = [
                        s for s in adapter.extract_symbols(source, file)
                        if s.kind in ("function", "method", "constructor")
                    ]
                except Exception:
                    syms = []
            cache[file] = syms
        best = None
        for s in cache[file]:
            if s.start_line <= line <= s.end_line:
                if best is None or (s.end_line - s.start_line) < (best.end_line - best.start_line):
                    best = s
        return best

    # --- 内部工具 ---

    def _locate(
        self,
        index: SymbolIndex,
        file: str,
        name: str | None,
        line: int | None,
    ) -> Symbol | None:
        if name:
            file_syms = [s for s in index.symbols_in_file(file) if s.name == name]
            # 优先：请求文件内的精确行（用户从候选菜单选定的就是某文件某行）
            if line is not None:
                for s in file_syms:
                    if s.start_line == line:
                        return s
            # 文件在索引范围内且无需区分行：直接用，避免触发全局 grep
            if file_syms and line is None:
                return file_syms[0]
            # 否则合并全局候选（覆盖 include_paths 之外的 .c 实现），
            # 按 文件+行 → 文件 → 任意 的优先级匹配，确保选 .c 不会落回 .h 桩。
            merged = self._merged_candidates(index, name)
            if line is not None:
                for s in merged:
                    if s.file == file and s.start_line == line:
                        return s
            for s in merged:
                if s.file == file:
                    return s
            if file_syms:
                return file_syms[0]
            return merged[0] if merged else None
        if line is not None:
            return index.symbol_at(file, line)
        return None

    def _merged_candidates(self, index: SymbolIndex, name: str) -> list[Symbol]:
        """合并范围内索引 + 全局回退的全部定义，按 (文件, 起始行) 去重。"""
        syms = list(index.lookup(name)) + list(index.global_lookup(name))
        seen: set[tuple[str, int]] = set()
        out: list[Symbol] = []
        for s in syms:
            key = (s.file, s.start_line)
            if key in seen:
                continue
            seen.add(key)
            out.append(s)
        return out

    def _rank_definitions(
        self, syms: list[Symbol], from_file: str
    ) -> list[Definition]:
        """对候选排序：真实现优先，空桩/头文件 inline 靠后。

        排序键（小者靠前）：
        - empty：空实现排最后
        - 非 .c 文件（头文件里的 inline 多为桩）排后
        - 同文件定义略微优先（静态局部函数常见）
        """
        def sort_key(s: Symbol):
            empty = 1 if s.empty else 0
            is_header = 0 if s.file.endswith((".c", ".cc", ".cpp", ".cxx")) else 1
            same = 0 if s.file == from_file else 1
            return (empty, is_header, same, s.file, s.start_line)

        return [
            Definition(
                name=s.name,
                file=s.file,
                line=s.start_line,
                kind=s.kind,
                signature=s.signature,
                empty=s.empty,
            )
            for s in sorted(syms, key=sort_key)
        ]

    def _read_bytes(self, project: Project, rel_path: str) -> bytes | None:
        full = project.root / rel_path
        try:
            return full.read_bytes()
        except OSError:
            return None

    def _read_lines(
        self, project: Project, rel_path: str, start: int, end: int
    ) -> list[str]:
        data = self._read_bytes(project, rel_path)
        if data is None:
            return []
        all_lines = data.decode("utf-8", errors="replace").splitlines()
        return all_lines[max(0, start - 1) : end]
