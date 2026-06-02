"""Scala / Chisel 语言适配器（Chipyard 阶段使用）。

可导航单元：def / class / object / trait。
引用：call_expression（含 a.b(x) 形式，取末段方法名）。

精度说明（务实优先）：Scala 的隐式参数、混入(trait)、Diplomacy 框架连接
等高级特性无法靠纯语法树精确解析，本适配器走「尽力而为 + 候选列表」路线，
深挖单个项目时可再叠加 Metals(LSP) 提升精度。
"""

from __future__ import annotations

import tree_sitter as ts

from ..models import Reference, Symbol
from .base import LanguageAdapter
from .treesitter_base import TreeSitterAdapter

_SCALA_DEF_NODES = {
    "function_definition": "method",
    "class_definition": "class",
    "object_definition": "object",
    "trait_definition": "trait",
    "val_definition": "val",
}


class ScalaAdapter(TreeSitterAdapter, LanguageAdapter):
    name = "scala"
    extensions = (".scala", ".sc")
    symbol_kinds = ("method", "class", "object", "trait", "val")

    def _load_language(self) -> ts.Language:
        import tree_sitter_scala

        return ts.Language(tree_sitter_scala.language())

    def extract_symbols(self, source: bytes, rel_path: str) -> list[Symbol]:
        tree = self.parse(source)
        symbols: list[Symbol] = []

        for node in self.walk(tree.root_node):
            kind = _SCALA_DEF_NODES.get(node.type)
            if kind is None:
                continue
            name_node = self._first_identifier(node)
            if name_node is None:
                continue
            symbols.append(
                Symbol(
                    name=self.node_text(source, name_node),
                    kind=kind,
                    file=rel_path,
                    start_line=node.start_point[0] + 1,
                    end_line=node.end_point[0] + 1,
                    signature=self._signature(source, node),
                    doc="",
                )
            )
        return symbols

    def extract_references(
        self, source: bytes, rel_path: str, start_line: int, end_line: int
    ) -> list[Reference]:
        tree = self.parse(source)
        refs: list[Reference] = []
        seen: set[tuple[str, int, int]] = set()

        for node in self.walk(tree.root_node):
            if node.type != "call_expression":
                continue
            if not self.overlaps(node, start_line, end_line):
                continue
            callee = node.child_by_field_name("function")
            if callee is None and node.children:
                callee = node.children[0]
            if callee is None:
                continue
            # a.b.method(x) → 取末段 identifier 作为方法名
            name_node = self._last_identifier(callee)
            if name_node is None:
                continue
            name = self.node_text(source, name_node)
            if not name:
                continue
            line = name_node.start_point[0] + 1
            col = name_node.start_point[1] + 1
            end_col = name_node.end_point[1] + 1
            key = (name, line, col)
            if key in seen:
                continue
            seen.add(key)
            refs.append(Reference(name=name, line=line, col=col, end_col=end_col))

        refs.sort(key=lambda r: (r.line, r.col))
        return refs

    def _first_identifier(self, node: ts.Node) -> ts.Node | None:
        """取定义节点的名字：第一个直接 identifier 子节点。"""
        for child in node.children:
            if child.type == "identifier":
                return child
        return None

    def _last_identifier(self, node: ts.Node) -> ts.Node | None:
        """取被调表达式中最后一个 identifier（处理 a.b.method 链式选择）。"""
        if node.type == "identifier":
            return node
        last: ts.Node | None = None
        for sub in self.walk(node):
            if sub.type == "identifier":
                last = sub
        return last

    def _signature(self, source: bytes, node: ts.Node) -> str:
        body = node.child_by_field_name("body")
        end_byte = body.start_byte if body is not None else node.end_byte
        text = source[node.start_byte : end_byte].decode("utf-8", errors="replace")
        return " ".join(text.split()).strip()[:200]
