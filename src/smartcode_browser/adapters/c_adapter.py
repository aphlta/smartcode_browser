"""C / 内核风格 C 的语言适配器。

负责从 C 源码提取：
- 函数定义（function_definition）作为可导航单元
- 函数体内的调用点（call_expression）作为引用

针对内核常见写法做了处理：static/inline 修饰、返回指针类型
（pointer_declarator 包裹 function_declarator）、紧邻上方的 /** */ 文档注释。
"""

from __future__ import annotations

import re
import subprocess
from pathlib import Path

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

        seen_funcs: set[tuple[str, int]] = set()

        def _add_function(sym: Symbol | None) -> None:
            if sym is None:
                return
            key = (sym.name, sym.start_line)
            if key in seen_funcs:
                return
            seen_funcs.add(key)
            symbols.append(sym)

        for node in self.walk(tree.root_node):
            if node.type == "function_definition":
                _add_function(self._symbol_from_function(source, rel_path, node))
            elif node.type == "ERROR":
                # 宏/IFDEF 等常使 tree-sitter 把整段函数标成 ERROR，仍需可导航
                _add_function(self._symbol_from_error_function(source, rel_path, node))
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
        name_line = name_node.start_point[0] + 1
        parser_end = node.end_point[0] + 1
        if node.type == "ERROR":
            end_line = self._function_end_line_braced(source, node, name_node)
        else:
            # INSTPAT/宏等常使 tree-sitter 提前结束函数体，用源码行界拉长范围
            extended = self._end_line_before_next_toplevel_fn(source, name_line)
            end_line = max(parser_end, extended)
        return Symbol(
            name=name,
            kind="function",
            file=rel_path,
            start_line=name_line,
            end_line=end_line,
            signature=self._signature_for_node(source, node, name_node),
            doc=self._doc_comment(source, node),
            empty=self._is_empty_body(node),
        )

    def _symbol_from_error_function(
        self, source: bytes, rel_path: str, node: ts.Node
    ) -> Symbol | None:
        """从 ERROR 节点恢复函数符号（NEMU 里 static 函数常落在此类节点）。"""
        name_node = self._function_name_node(node)
        if name_node is None:
            return None
        name = self.node_text(source, name_node)
        if not name or name in _C_NON_CALLS:
            return None
        # 必须在函数名后不远处出现 ``{``，避免把随机 ERROR 块误当函数
        after = source[name_node.end_byte : name_node.end_byte + 200]
        brace_at = after.find(b"{")
        if brace_at < 0 or brace_at > 150:
            return None
        return self._symbol_from_function(source, rel_path, node)

    @staticmethod
    def _line_at_byte(source: bytes, byte_off: int) -> int:
        return source[:byte_off].count(b"\n") + 1

    def _matching_brace_byte(
        self, source: bytes, from_byte: int, limit_byte: int
    ) -> int | None:
        """从 from_byte 起找第一个 ``{``，返回与之匹配的 ``}`` 的字节下标。"""
        chunk = source[from_byte:limit_byte]
        start = chunk.find(b"{")
        if start < 0:
            return None
        depth = 0
        for i in range(start, len(chunk)):
            b = chunk[i]
            if b == ord("{"):
                depth += 1
            elif b == ord("}"):
                depth -= 1
                if depth == 0:
                    return from_byte + i
        return None

    def _function_end_line_braced(
        self, source: bytes, node: ts.Node, name_node: ts.Node
    ) -> int:
        # ERROR 节点内常有 #ifdef，括号计数不可靠，用下一函数定义定位结尾
        if node.type != "ERROR":
            after = source[name_node.end_byte : min(name_node.end_byte + 300, node.end_byte)]
            paren = after.find(b")")
            region_start = name_node.end_byte + (paren if paren >= 0 else 0)
            close = self._matching_brace_byte(source, region_start, node.end_byte)
            if close is not None:
                return self._line_at_byte(source, close)
        name_line = name_node.start_point[0] + 1
        return self._end_line_before_next_toplevel_fn(
            source, name_line, search_until=node.end_point[0] + 1
        )

    def _end_line_before_next_toplevel_fn(
        self,
        source: bytes,
        name_line: int,
        search_until: int | None = None,
    ) -> int:
        """从 name_line 起找下一顶格函数定义，向前定位闭合 ``}`` 作为函数结束行。

        用于纠正 tree-sitter 在宏展开（INSTPAT 等）处截断 function_definition 的问题。
        """
        lines = source.decode("utf-8", errors="replace").splitlines()
        limit = min(search_until or len(lines), len(lines))
        for line_no in range(name_line + 1, min(name_line + 500, limit + 1)):
            if line_no > len(lines):
                break
            raw = lines[line_no - 1]
            if raw.startswith((" ", "\t", "#")):
                continue
            stripped = raw.lstrip()
            if not stripped.startswith(
                ("static ", "void ", "int ", "bool ", "inline ")
            ):
                continue
            if "(" not in raw:
                continue
            for back in range(line_no - 1, name_line, -1):
                if lines[back - 1].strip() == "}":
                    return back
            return line_no - 1
        return min(name_line + 80, limit)

    def _signature_for_node(
        self, source: bytes, node: ts.Node, name_node: ts.Node
    ) -> str:
        body = node.child_by_field_name("body")
        if body is not None:
            return self._signature(source, node)
        close = self._matching_brace_byte(
            source, name_node.end_byte, node.end_byte
        )
        end_byte = (close + 1) if close is not None else node.end_byte
        text = source[node.start_byte : end_byte].decode("utf-8", errors="replace")
        return " ".join(text.split()).strip()[:200]

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
            if fn is None:
                continue
            ref_kind = "direct"
            receiver = ""
            name_node = fn
            if fn.type == "identifier":
                name = self.node_text(source, fn)
            elif fn.type == "field_expression":
                # cmd_table[i].handler(args)：函数指针成员调用
                field = fn.child_by_field_name("field")
                if field is None:
                    continue
                name_node = field
                name = self.node_text(source, field)
                recv = self._root_identifier_from_expr(
                    fn.child_by_field_name("argument"), source
                )
                if not recv:
                    continue
                ref_kind = "member"
                receiver = recv
            else:
                continue
            if not name or name in _C_NON_CALLS:
                continue
            line = name_node.start_point[0] + 1
            col = name_node.start_point[1] + 1
            end_col = name_node.end_point[1] + 1
            key = (name, line, col, ref_kind, receiver)
            if key in seen:
                continue
            seen.add(key)
            refs.append(
                Reference(
                    name=name,
                    line=line,
                    col=col,
                    end_col=end_col,
                    ref_kind=ref_kind,
                    receiver=receiver,
                )
            )

        refs.sort(key=lambda r: (r.line, r.col))
        return refs

    def find_table_field_targets(
        self, source: bytes, rel_path: str, table_name: str, field_name: str
    ) -> list[str]:
        """从单文件 ``table[] = { ... }`` 初始化中提取字段上的函数名。"""
        tree = self.parse(source)
        root = tree.root_node
        field_idx = self._field_index_in_table_declaration(
            root, source, table_name, field_name
        )
        init_list = self._initializer_list_for_table(root, source, table_name)
        if init_list is None:
            return []
        out: list[str] = []
        for child in init_list.children:
            if child.type not in ("initializer", "initializer_list"):
                continue
            fn = self._value_at_initializer_index(source, child, field_idx)
            if fn and fn not in out:
                out.append(fn)
        return out

    def find_table_field_targets_scoped(
        self,
        project_root: Path,
        table_name: str,
        field_name: str,
        *,
        prefer_file: str = "",
        exclude_dirs: list[str] | None = None,
        max_files: int = 40,
    ) -> list[str]:
        """在项目内查找 ``table_name`` 的定义并提取字段上的函数指针目标。

        调用点与表定义常在不同 .c 文件：先查 ``prefer_file``（当前面板），
        再用 grep 扫项目里 ``table[] = {`` 的其它文件并 tree-sitter 解析。
        """
        exclude = exclude_dirs or []
        to_scan: list[str] = []
        if prefer_file:
            to_scan.append(prefer_file)
        for rel in self._grep_table_initializer_files(
            project_root, table_name, exclude, max_files
        ):
            if rel not in to_scan:
                to_scan.append(rel)

        merged: list[str] = []
        for rel in to_scan:
            full = project_root / rel
            try:
                source = full.read_bytes()
            except OSError:
                continue
            for fn in self.find_table_field_targets(
                source, rel, table_name, field_name
            ):
                if fn not in merged:
                    merged.append(fn)
        return merged

    def _grep_table_initializer_files(
        self,
        project_root: Path,
        table_name: str,
        exclude_dirs: list[str],
        max_files: int,
    ) -> list[str]:
        """grep 含 ``table_name[] =`` 的源文件（表初始化通常在定义处）。"""
        # 不用 \\b：行首常有 ``} cmd_table[] =``，\\b 在部分 grep 下匹配失败
        pat = rf"{re.escape(table_name)}\s*\[.*\]\s*="
        exclude_args: list[str] = []
        for d in exclude_dirs:
            exclude_args += ["--exclude-dir", d]
        cmd = [
            "grep", "-rIlE", pat,
            "--include=*.c", "--include=*.h",
            "--include=*.cc", "--include=*.cpp",
            *exclude_args,
            str(project_root),
        ]
        try:
            proc = subprocess.run(
                cmd, capture_output=True, text=True, timeout=15, check=False
            )
        except (subprocess.TimeoutExpired, FileNotFoundError):
            return []
        rels: list[str] = []
        for line in proc.stdout.splitlines():
            try:
                rel = str(Path(line).relative_to(project_root))
            except ValueError:
                continue
            rels.append(rel)
            if len(rels) >= max_files:
                break
        return rels

    def _root_identifier_from_expr(self, node: ts.Node | None, source: bytes) -> str:
        """从 ``cmd_table[i]`` / ``p->x`` 等表达式取出根变量名。"""
        if node is None:
            return ""
        if node.type == "identifier":
            return self.node_text(source, node)
        if node.type == "subscript_expression":
            return self._root_identifier_from_expr(
                node.child_by_field_name("argument"), source
            )
        if node.type in ("field_expression", "pointer_expression"):
            return self._root_identifier_from_expr(
                node.child_by_field_name("argument"), source
            )
        if node.type == "parenthesized_expression" and node.children:
            return self._root_identifier_from_expr(node.children[1], source)
        return ""

    def _declarator_identifier(self, node: ts.Node, source: bytes) -> str:
        """从 declarator 子树取变量名（含 array_declarator）。"""
        if node.type == "identifier":
            return self.node_text(source, node)
        if node.type == "array_declarator":
            inner = node.child_by_field_name("declarator")
            return self._declarator_identifier(inner, source) if inner else ""
        if node.type == "pointer_declarator":
            inner = node.child_by_field_name("declarator")
            return self._declarator_identifier(inner, source) if inner else ""
        for ch in node.children:
            t = self._declarator_identifier(ch, source)
            if t:
                return t
        return ""

    def _field_index_in_table_declaration(
        self, root: ts.Node, source: bytes, table_name: str, field_name: str
    ) -> int:
        """在 table 前的匿名 struct 里定位字段下标；找不到则 -1（用行内最后一个标识符）。"""
        for node in self.walk(root):
            if node.type != "declaration":
                continue
            has_table = False
            field_list: ts.Node | None = None
            for ch in node.children:
                if ch.type == "struct_specifier":
                    body = ch.child_by_field_name("body")
                    if body is not None:
                        field_list = body
                if ch.type == "init_declarator":
                    decl = ch.child_by_field_name("declarator")
                    if decl and self._declarator_identifier(decl, source) == table_name:
                        has_table = True
            if not has_table or field_list is None:
                continue
            idx = 0
            for fd in field_list.children:
                if fd.type != "field_declaration":
                    continue
                for sub in self.walk(fd):
                    if sub.type == "field_identifier":
                        if self.node_text(source, sub) == field_name:
                            return idx
                idx += 1
        return -1

    def _initializer_list_for_table(
        self, root: ts.Node, source: bytes, table_name: str
    ) -> ts.Node | None:
        for node in self.walk(root):
            if node.type == "declaration":
                for ch in node.children:
                    if ch.type != "init_declarator":
                        continue
                    decl = ch.child_by_field_name("declarator")
                    if decl is None or self._declarator_identifier(decl, source) != table_name:
                        continue
                    init = ch.child_by_field_name("value")
                    if init is not None and init.type == "initializer_list":
                        return init
        return None

    def _value_at_initializer_index(
        self, source: bytes, init_node: ts.Node, field_idx: int
    ) -> str:
        """取 ``{a, b, fn}`` 中第 field_idx 个元素；field_idx<0 时取行内最后一个函数名标识符。"""
        value = init_node
        if value.type == "initializer" and value.children:
            if value.children[0].type == "=" and len(value.children) > 1:
                value = value.children[1]
        if value.type != "initializer_list":
            return self._expr_as_function_name(value, source)
        # 表项常为 { "name", "desc", cmd_fn }，tree-sitter 标成 initializer_list
        elems = [
            c for c in value.children
            if c.type not in (",", "{", "}", "(", ")", "comment")
        ]
        if field_idx >= 0 and field_idx < len(elems):
            return self._expr_as_function_name(elems[field_idx], source)
        for it in reversed(elems):
            t = self._expr_as_function_name(it, source)
            if t:
                return t
        return ""

    def _expr_as_function_name(self, node: ts.Node, source: bytes) -> str:
        if node.type == "identifier":
            return self.node_text(source, node)
        if node.type == "initializer":
            return self._expr_as_function_name(
                node.children[-1] if node.children else node, source
            )
        if node.type == "initializer_list":
            return self._value_at_initializer_index(source, node, -1)
        for ch in node.children:
            t = self._expr_as_function_name(ch, source)
            if t:
                return t
        return ""

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
