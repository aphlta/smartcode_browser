"""Python 语言适配器。

用于浏览 SmartCode 自身这类 Python 项目（也是最快的端到端验证场景）。
可导航单元包含函数与类；引用为函数调用与方法调用。
"""

from __future__ import annotations

import tree_sitter as ts

from ..models import Reference, Symbol
from .base import LanguageAdapter
from .treesitter_base import TreeSitterAdapter

# Python 内建/常见名，作为调用出现时跳转价值低，剔除以减少噪声
_PY_NON_CALLS = frozenset(
    {
        "print", "len", "range", "isinstance", "super", "type", "int", "str",
        "list", "dict", "set", "tuple", "bool", "float", "enumerate", "zip",
        "open", "format", "getattr", "setattr", "hasattr", "repr", "min", "max",
        "sum", "sorted", "any", "all", "map", "filter", "next", "iter",
    }
)


class PythonAdapter(TreeSitterAdapter, LanguageAdapter):
    name = "python"
    extensions = (".py", ".pyi")
    symbol_kinds = ("function", "class")

    def _load_language(self) -> ts.Language:
        import tree_sitter_python

        return ts.Language(tree_sitter_python.language())

    def extract_symbols(self, source: bytes, rel_path: str) -> list[Symbol]:
        tree = self.parse(source)
        symbols: list[Symbol] = []

        for node in self.walk(tree.root_node):
            if node.type in ("function_definition", "class_definition"):
                kind = "function" if node.type == "function_definition" else "class"
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
                        signature=self._signature(source, node, kind),
                        doc=self._docstring(source, node),
                    )
                )
            elif node.type == "assignment":
                # 仅模块级 / 类体内的赋值 → 变量/属性（不收函数内局部）
                par = node.parent
                grand = par.parent if par is not None else None
                at_module = par is not None and par.type == "module"
                at_class = (
                    par is not None and par.type == "block"
                    and grand is not None and grand.type == "class_definition"
                )
                if not (at_module or at_class):
                    continue
                left = node.child_by_field_name("left")
                if left is None or left.type != "identifier":
                    continue
                symbols.append(
                    Symbol(
                        name=self.node_text(source, left),
                        kind="field" if at_class else "variable",
                        file=rel_path,
                        start_line=node.start_point[0] + 1,
                        end_line=node.start_point[0] + 1,
                        signature=self.node_text(source, node).splitlines()[0][:200],
                    )
                )
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
            target = None
            if node.type == "identifier" and node.parent is not None and \
                    node.parent.type in ("parameters", "lambda_parameters", "default_parameter",
                                          "typed_parameter", "typed_default_parameter"):
                target = node
            elif node.type == "assignment":
                left = node.child_by_field_name("left")
                if left is not None and left.type == "identifier":
                    target = left
            if target is not None and self.node_text(source, target) == name:
                if best is None or ln < best:
                    best = ln
        return best

    def extract_references(
        self, source: bytes, rel_path: str, start_line: int, end_line: int
    ) -> list[Reference]:
        tree = self.parse(source)
        refs: list[Reference] = []
        seen: set[tuple[str, int, int]] = set()

        for node in self.walk(tree.root_node):
            if node.type != "call":
                continue
            if not self.overlaps(node, start_line, end_line):
                continue
            fn = node.child_by_field_name("function")
            if fn is None:
                continue
            # foo()  -> identifier；self.foo()/mod.foo() -> attribute 取末段方法名
            if fn.type == "identifier":
                name_node = fn
            elif fn.type == "attribute":
                name_node = fn.child_by_field_name("attribute")
            else:
                continue
            if name_node is None:
                continue
            name = self.node_text(source, name_node)
            if not name or name in _PY_NON_CALLS:
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

    def _signature(self, source: bytes, node: ts.Node, kind: str) -> str:
        if kind == "function":
            params = node.child_by_field_name("parameters")
            name = node.child_by_field_name("name")
            if name is not None and params is not None:
                return (
                    "def "
                    + self.node_text(source, name)
                    + self.node_text(source, params)
                )
        name = node.child_by_field_name("name")
        return ("class " + self.node_text(source, name)) if name is not None else ""

    def _docstring(self, source: bytes, node: ts.Node) -> str:
        """提取函数/类的首个字符串字面量作为 docstring。"""
        body = node.child_by_field_name("body")
        if body is None or not body.children:
            return ""
        first = body.children[0]
        if first.type == "expression_statement" and first.children:
            s = first.children[0]
            if s.type == "string":
                text = self.node_text(source, s)
                return text.strip("\"'").strip()[:500]
        return ""
