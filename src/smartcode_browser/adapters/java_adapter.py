"""Java 语言适配器。

可导航单元：class / interface / enum / method / constructor。
引用：方法调用（method_invocation）与对象创建（object_creation_expression，→ 类名）。
"""

from __future__ import annotations

import tree_sitter as ts

from ..models import Reference, Symbol
from .base import LanguageAdapter
from .treesitter_base import TreeSitterAdapter

_JAVA_DEF_NODES = {
    "class_declaration": "class",
    "interface_declaration": "interface",
    "enum_declaration": "enum",
    "record_declaration": "record",
    "method_declaration": "method",
    "constructor_declaration": "constructor",
}


class JavaAdapter(TreeSitterAdapter, LanguageAdapter):
    name = "java"
    extensions = (".java",)
    symbol_kinds = ("class", "interface", "enum", "record", "method", "constructor")

    def _load_language(self) -> ts.Language:
        import tree_sitter_java

        return ts.Language(tree_sitter_java.language())

    def extract_symbols(self, source: bytes, rel_path: str) -> list[Symbol]:
        tree = self.parse(source)
        symbols: list[Symbol] = []

        for node in self.walk(tree.root_node):
            kind = _JAVA_DEF_NODES.get(node.type)
            if kind is not None:
                name_node = node.child_by_field_name("name")
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
                        doc=self._doc_comment(source, node),
                        empty=self._is_empty_body(node),
                    )
                )
            elif node.type == "field_declaration":
                # 类字段：可能一行声明多个 variable_declarator
                for vd in node.children:
                    if vd.type == "variable_declarator":
                        nm = vd.child_by_field_name("name")
                        if nm is not None:
                            symbols.append(Symbol(
                                name=self.node_text(source, nm), kind="field",
                                file=rel_path, start_line=node.start_point[0] + 1,
                                end_line=node.end_point[0] + 1,
                                signature=self._signature_line(source, node),
                            ))
            elif node.type == "enum_constant":
                nm = node.child_by_field_name("name")
                if nm is not None:
                    symbols.append(Symbol(
                        name=self.node_text(source, nm), kind="enum",
                        file=rel_path, start_line=node.start_point[0] + 1,
                        end_line=node.start_point[0] + 1,
                        signature=self.node_text(source, nm),
                    ))
        return symbols

    def find_local_declaration(
        self, source: bytes, start_line: int, end_line: int, name: str
    ) -> int | None:
        tree = self.parse(source)
        best: int | None = None
        for node in self.walk(tree.root_node):
            ln = node.start_point[0] + 1
            if ln < start_line or ln > end_line:
                continue
            targets = []
            if node.type == "formal_parameter":
                nm = node.child_by_field_name("name")
                if nm is not None:
                    targets.append(nm)
            elif node.type in ("local_variable_declaration", "enhanced_for_statement"):
                for vd in self.walk(node):
                    if vd.type == "variable_declarator":
                        nm = vd.child_by_field_name("name")
                        if nm is not None:
                            targets.append(nm)
                    elif node.type == "enhanced_for_statement" and vd.type == "identifier" \
                            and vd.parent is node:
                        targets.append(vd)
            for t in targets:
                if self.node_text(source, t) == name and (best is None or ln < best):
                    best = ln
        return best

    def _signature_line(self, source: bytes, node: ts.Node) -> str:
        return self.node_text(source, node).splitlines()[0].strip()[:200]

    def extract_references(
        self, source: bytes, rel_path: str, start_line: int, end_line: int
    ) -> list[Reference]:
        tree = self.parse(source)
        refs: list[Reference] = []
        seen: set[tuple[str, int, int]] = set()

        for node in self.walk(tree.root_node):
            if not self.overlaps(node, start_line, end_line):
                continue
            name_node = None
            if node.type == "method_invocation":
                name_node = node.child_by_field_name("name")
            elif node.type == "object_creation_expression":
                # new Foo(...) → 跳到类 Foo
                type_node = node.child_by_field_name("type")
                if type_node is not None:
                    name_node = self._last_identifier(type_node)
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

    def _last_identifier(self, node: ts.Node) -> ts.Node | None:
        if node.type == "type_identifier" or node.type == "identifier":
            return node
        last: ts.Node | None = None
        for sub in self.walk(node):
            if sub.type in ("type_identifier", "identifier"):
                last = sub
        return last

    def _is_empty_body(self, node: ts.Node) -> bool:
        body = node.child_by_field_name("body")
        if body is None or body.type != "block":
            return False
        meaningful = [c for c in body.children if c.type not in ("{", "}", "line_comment", "block_comment")]
        return len(meaningful) == 0

    def _signature(self, source: bytes, node: ts.Node) -> str:
        body = node.child_by_field_name("body")
        end_byte = body.start_byte if body is not None else node.end_byte
        text = source[node.start_byte : end_byte].decode("utf-8", errors="replace")
        return " ".join(text.split()).strip()[:200]

    def _doc_comment(self, source: bytes, node: ts.Node) -> str:
        prev = node.prev_sibling
        # 跳过 modifiers，找紧邻的 Javadoc 块注释
        if prev is not None and prev.type == "modifiers":
            prev = prev.prev_sibling
        if prev is not None and prev.type == "block_comment":
            if node.start_point[0] - prev.end_point[0] <= 1:
                raw = self.node_text(source, prev)
                cleaned = raw.replace("/**", "").replace("/*", "").replace("*/", "")
                lines = [ln.strip().lstrip("*").strip() for ln in cleaned.splitlines()]
                return "\n".join(ln for ln in lines if ln)[:500]
        return ""
