"""C / 内核风格 C 的语言适配器。

负责从 C 源码提取：
- 函数定义（function_definition）作为可导航单元
- 函数体内的调用点（call_expression）作为引用

针对内核常见写法做了处理：static/inline 修饰、返回指针类型
（pointer_declarator 包裹 function_declarator）、紧邻上方的 /** */ 文档注释。
"""

from __future__ import annotations

import tree_sitter as ts

from ..models import Reference, Symbol
from .base import LanguageAdapter
from .treesitter_base import TreeSitterAdapter

# 这些名字虽然语法上像调用，但其实是控制流/运算符关键字，需从引用中剔除，
# 否则 if()/while()/sizeof() 会被误当成可点击的函数调用。
_C_NON_CALLS = frozenset(
    {
        "if", "while", "for", "switch", "return", "sizeof", "typeof",
        "defined", "likely", "unlikely", "alignof", "static_assert",
        "__builtin_expect", "case", "do", "else", "goto",
    }
)


class CAdapter(TreeSitterAdapter, LanguageAdapter):
    name = "c"
    extensions = (".c", ".h", ".cc", ".cpp", ".hpp", ".cxx")
    symbol_kinds = ("function",)

    def _load_language(self) -> ts.Language:
        import tree_sitter_c

        return ts.Language(tree_sitter_c.language())

    # --- 符号提取 ---

    def extract_symbols(self, source: bytes, rel_path: str) -> list[Symbol]:
        tree = self.parse(source)
        symbols: list[Symbol] = []

        for node in self.walk(tree.root_node):
            if node.type == "function_definition":
                sym = self._symbol_from_function(source, rel_path, node)
                if sym is not None:
                    symbols.append(sym)
            elif node.type in ("preproc_function_def", "preproc_def"):
                # #define FOO ... / #define FOO(x) ... —— 内核大量函数其实是宏
                sym = self._symbol_from_macro(source, rel_path, node)
                if sym is not None:
                    symbols.append(sym)
            elif node.type == "declaration" and node.parent is not None and \
                    node.parent.type == "translation_unit":
                # 文件级声明 → 全局/静态变量（排除函数原型）
                symbols.extend(self._symbols_from_global_decl(source, rel_path, node))
            elif node.type == "field_declaration":
                # 结构体/联合体字段
                symbols.extend(self._symbols_from_field(source, rel_path, node))
            elif node.type == "enumerator":
                # 枚举常量
                ident = node.child_by_field_name("name") or (
                    node.children[0] if node.children else None
                )
                if ident is not None and ident.type == "identifier":
                    symbols.append(
                        Symbol(
                            name=self.node_text(source, ident),
                            kind="enum_const",
                            file=rel_path,
                            start_line=node.start_point[0] + 1,
                            end_line=node.start_point[0] + 1,
                            signature=self._signature_first_line(source, node),
                        )
                    )
            elif node.type in ("struct_specifier", "union_specifier", "enum_specifier"):
                # 类型名定义（仅当带定义体，前向声明 `struct foo;` 不算）
                sym = self._symbol_from_type(source, rel_path, node)
                if sym is not None:
                    symbols.append(sym)
            elif node.type == "type_definition":
                # typedef ... NAME;
                sym = self._symbol_from_typedef(source, rel_path, node)
                if sym is not None:
                    symbols.append(sym)
        return symbols

    def _symbol_from_type(self, source, rel_path, node) -> Symbol | None:
        has_body = any(
            c.type in ("field_declaration_list", "enumerator_list")
            for c in node.children
        )
        if not has_body:
            return None
        name_node = node.child_by_field_name("name")
        if name_node is None:
            for c in node.children:
                if c.type == "type_identifier":
                    name_node = c
                    break
        if name_node is None:
            return None
        kind = {
            "struct_specifier": "struct",
            "union_specifier": "union",
            "enum_specifier": "enum",
        }[node.type]
        return Symbol(
            name=self.node_text(source, name_node),
            kind=kind,
            file=rel_path,
            start_line=node.start_point[0] + 1,
            end_line=node.end_point[0] + 1,
            signature=self._signature_first_line(source, node),
        )

    def _symbol_from_typedef(self, source, rel_path, node) -> Symbol | None:
        # 新类型名通常是 typedef 里最后一个 type_identifier
        name_node = None
        for c in self.walk(node):
            if c.type == "type_identifier":
                name_node = c
        if name_node is None:
            return None
        return Symbol(
            name=self.node_text(source, name_node),
            kind="typedef",
            file=rel_path,
            start_line=node.start_point[0] + 1,
            end_line=node.end_point[0] + 1,
            signature=self._signature_first_line(source, node),
        )

    def _symbols_from_global_decl(self, source, rel_path, node) -> list[Symbol]:
        """从文件级 declaration 提取全局/静态变量（跳过函数原型）。"""
        # 含 function_declarator 的是函数原型，不是变量
        for sub in self.walk(node):
            if sub.type == "function_declarator":
                return []
        out: list[Symbol] = []
        for child in node.children:
            ident = self._declared_identifier(child)
            if ident is not None:
                out.append(
                    Symbol(
                        name=self.node_text(source, ident),
                        kind="variable",
                        file=rel_path,
                        start_line=node.start_point[0] + 1,
                        end_line=node.end_point[0] + 1,
                        signature=self._signature_first_line(source, node),
                    )
                )
        return out

    def _symbols_from_field(self, source, rel_path, node) -> list[Symbol]:
        out: list[Symbol] = []
        for child in node.children:
            ident = self._declared_identifier(child, field=True)
            if ident is not None:
                out.append(
                    Symbol(
                        name=self.node_text(source, ident),
                        kind="field",
                        file=rel_path,
                        start_line=node.start_point[0] + 1,
                        end_line=node.start_point[0] + 1,
                        signature=self._signature_first_line(source, node),
                    )
                )
        return out

    def _declared_identifier(self, node, field: bool = False):
        """从 declarator 子树里取被声明的标识符。

        处理 init_declarator / pointer_declarator / array_declarator 等包裹。
        field=True 时取 field_identifier，否则取 identifier。
        """
        target = "field_identifier" if field else "identifier"
        wrappers = {
            "init_declarator", "pointer_declarator", "array_declarator",
            "parenthesized_declarator",
        }
        cur = node
        # init_declarator 的 declarator 字段优先
        if cur.type == target:
            return cur
        if cur.type in wrappers or cur.type == "function_declarator":
            d = cur.child_by_field_name("declarator")
            if d is not None:
                return self._declared_identifier(d, field=field)
            for ch in cur.children:
                r = self._declared_identifier(ch, field=field)
                if r is not None:
                    return r
        return None

    def find_local_declaration(
        self, source: bytes, start_line: int, end_line: int, name: str
    ) -> int | None:
        """在 [start_line, end_line] 的函数体内查找 name 的参数/局部声明，返回行号。"""
        tree = self.parse(source)
        best: int | None = None
        for node in self.walk(tree.root_node):
            ln = node.start_point[0] + 1
            if ln < start_line or ln > end_line:
                continue
            if node.type not in ("parameter_declaration", "declaration"):
                continue
            for child in node.children:
                ident = self._declared_identifier(child)
                if ident is not None and self.node_text(source, ident) == name:
                    if best is None or ln < best:
                        best = ln
        return best

    def _symbol_from_function(
        self, source: bytes, rel_path: str, node
    ) -> Symbol | None:
        name_node = self._function_name_node(node)
        if name_node is None:
            return None
        name = self.node_text(source, name_node)
        if not name or name in _C_NON_CALLS:
            return None
        return Symbol(
            name=name,
            kind="function",
            file=rel_path,
            start_line=node.start_point[0] + 1,
            end_line=node.end_point[0] + 1,
            signature=self._signature(source, node),
            doc=self._doc_comment(source, node),
            empty=self._is_empty_body(node),
        )

    def _is_empty_body(self, func_def: ts.Node) -> bool:
        """判断函数体是否为空（即 `{ }`，典型的 #ifdef 空桩）。

        空实现对追踪调用链没有价值，解析时应让位给真正的实现，故在此标记。
        """
        body = func_def.child_by_field_name("body")
        if body is None or body.type != "compound_statement":
            return False
        # 仅含 '{' 与 '}' 两个 token，无任何语句 → 空实现
        meaningful = [c for c in body.children if c.type not in ("{", "}", "comment")]
        return len(meaningful) == 0

    def _symbol_from_macro(self, source: bytes, rel_path: str, node) -> Symbol | None:
        name_node = node.child_by_field_name("name")
        if name_node is None:
            # 退回取第一个 identifier 子节点
            for child in node.children:
                if child.type == "identifier":
                    name_node = child
                    break
        if name_node is None:
            return None
        name = self.node_text(source, name_node)
        if not name:
            return None
        return Symbol(
            name=name,
            kind="macro",
            file=rel_path,
            start_line=node.start_point[0] + 1,
            end_line=node.end_point[0] + 1,
            signature=self._signature_first_line(source, node),
            doc="",
        )

    # --- 引用提取 ---

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
            fn = node.child_by_field_name("function")
            # 只处理「直接具名调用」foo()；a->b()/结构体成员调用解析意义有限，跳过
            if fn is None or fn.type != "identifier":
                continue
            name = self.node_text(source, fn)
            if not name or name in _C_NON_CALLS:
                continue
            line = fn.start_point[0] + 1
            col = fn.start_point[1] + 1
            end_col = fn.end_point[1] + 1
            key = (name, line, col)
            if key in seen:
                continue
            seen.add(key)
            refs.append(Reference(name=name, line=line, col=col, end_col=end_col))

        refs.sort(key=lambda r: (r.line, r.col))
        return refs

    # --- 内部工具 ---

    def _function_name_node(self, func_def: ts.Node) -> ts.Node | None:
        """从 function_definition 找到函数名 identifier。

        难点：内核常见 ``void __weak foo(void)`` / ``static __always_inline T foo()``，
        其中 ``__weak`` 等宏会让 tree-sitter 产生 ERROR 节点，导致 declarator 字段缺失。
        因此不依赖字段，而是在「函数体之前」的子树里定位 function_declarator，
        再取其内的第一个 identifier 作为函数名。限定在体之前可避免误取体内的
        函数指针声明。
        """
        body = func_def.child_by_field_name("body")
        body_start = body.start_byte if body is not None else func_def.end_byte

        for node in self.walk(func_def):
            if node.start_byte >= body_start:
                continue
            if node.type != "function_declarator":
                continue
            ident = node.child_by_field_name("declarator")
            if ident is not None and ident.type == "identifier":
                return ident
            target = ident if ident is not None else node
            for sub in self.walk(target):
                if sub.type == "identifier":
                    return sub
        return None

    def _signature_first_line(self, source: bytes, node: ts.Node) -> str:
        """宏的签名：取其首行（多行宏只展示第一行，避免过长）。"""
        text = source[node.start_byte : node.end_byte].decode("utf-8", errors="replace")
        first = text.splitlines()[0] if text else ""
        return first.strip()[:200]

    def _signature(self, source: bytes, func_def: ts.Node) -> str:
        """取函数签名：从定义起点到函数体 '{' 之前，压成单行。"""
        body = func_def.child_by_field_name("body")
        end_byte = body.start_byte if body is not None else func_def.end_byte
        text = source[func_def.start_byte : end_byte].decode("utf-8", errors="replace")
        return " ".join(text.split()).strip()

    def _doc_comment(self, source: bytes, func_def: ts.Node) -> str:
        """取紧邻定义上方的块注释（内核 /** ... */ 风格）。"""
        prev = func_def.prev_sibling
        if prev is not None and prev.type == "comment":
            # 仅当注释紧贴函数（中间最多隔一行）才认为是文档
            if func_def.start_point[0] - prev.end_point[0] <= 1:
                raw = self.node_text(source, prev)
                cleaned = raw.replace("/**", "").replace("/*", "").replace("*/", "")
                lines = [ln.strip().lstrip("*").strip() for ln in cleaned.splitlines()]
                return "\n".join(ln for ln in lines if ln)[:500]
        return ""
