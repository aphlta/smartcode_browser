"""基于 tree-sitter 的适配器基类。

封装与 tree-sitter 版本/语法包相关的细节，子类只需：
1) 在 ``_load_language`` 返回本语言的 ``tree_sitter.Language``
2) 用基类提供的遍历/字段访问工具实现符号与引用提取

之所以不用 tree-sitter 的 Query API，是因为其 ``captures()`` 返回结构
在不同版本间不一致（dict / list 两种）；手动遍历更稳定、跨版本可移植。
"""

from __future__ import annotations

from abc import abstractmethod
from typing import Iterator

import tree_sitter as ts


class TreeSitterAdapter:
    """tree-sitter 解析能力的薄封装（与具体语言无关的部分）。"""

    def __init__(self) -> None:
        # 解析器构造可能较重，按适配器单例缓存，避免每次请求重建
        self._language: ts.Language | None = None
        self._parser: ts.Parser | None = None

    @abstractmethod
    def _load_language(self) -> ts.Language:
        """子类返回本语言的 Language（通常来自 tree_sitter_<lang>.language()）。"""
        raise NotImplementedError

    @property
    def parser(self) -> ts.Parser:
        if self._parser is None:
            self._language = self._load_language()
            self._parser = ts.Parser(self._language)
        return self._parser

    def parse(self, source: bytes) -> ts.Tree:
        return self.parser.parse(source)

    # --- 遍历与节点工具（供子类复用） ---

    @staticmethod
    def node_text(source: bytes, node: ts.Node) -> str:
        """取节点对应的源码文本（按字节切片，避免编码歧义）。"""
        return source[node.start_byte : node.end_byte].decode("utf-8", errors="replace")

    @staticmethod
    def walk(node: ts.Node) -> Iterator[ts.Node]:
        """深度优先遍历整棵子树（含自身）。"""
        stack = [node]
        while stack:
            cur = stack.pop()
            yield cur
            # 逆序压栈以保持自然的前序遍历顺序
            stack.extend(reversed(cur.children))

    @staticmethod
    def descend_field(node: ts.Node, *fields: str) -> ts.Node | None:
        """沿一串 field 名逐层下钻，任一层缺失则返回 None。"""
        cur: ts.Node | None = node
        for f in fields:
            if cur is None:
                return None
            cur = cur.child_by_field_name(f)
        return cur

    @staticmethod
    def line_of(node: ts.Node) -> int:
        """节点起始行（转 1-based）。"""
        return node.start_point[0] + 1

    @staticmethod
    def overlaps(node: ts.Node, start_line: int, end_line: int) -> bool:
        """节点起始行是否落在 [start_line, end_line] 闭区间内（1-based）。"""
        ln = node.start_point[0] + 1
        return start_line <= ln <= end_line
