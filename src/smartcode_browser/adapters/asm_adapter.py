"""Linux / U-Boot 风格汇编适配器（``.S`` / ``.s``）。

- Linux：``SYM_CODE_START(foo)`` / ``SYM_FUNC_END(foo)``
- U-Boot：``ENTRY(foo)`` / ``ENDPROC(foo)``，以及 ``.globl _start`` + ``_start:`` 标签对

tree-sitter 无统一汇编 grammar 时，用正则提取比硬上通用 parser 更稳。
"""

from __future__ import annotations

import re

from ..models import Reference, Symbol
from .base import LanguageAdapter

# linkage.h 中常见的函数式入口宏（含 LOCAL / WEAK / NOALIGN 变体）
_ENTRY_MACRO_NAMES = (
    "SYM_CODE_START",
    "SYM_CODE_START_NOALIGN",
    "SYM_CODE_START_LOCAL",
    "SYM_CODE_START_LOCAL_NOALIGN",
    "SYM_FUNC_START",
    "SYM_FUNC_START_NOALIGN",
    "SYM_FUNC_START_LOCAL",
    "SYM_FUNC_START_LOCAL_NOALIGN",
    "SYM_FUNC_START_WEAK",
    "SYM_FUNC_START_WEAK_NOALIGN",
    "SYM_TYPED_FUNC_START",
)

_ENTRY_RE = re.compile(
    r"^\s*(?:"
    + "|".join(re.escape(m) for m in _ENTRY_MACRO_NAMES)
    + r")\s*\(\s*([A-Za-z_]\w*)\s*\)",
    re.MULTILINE,
)

_END_RE = re.compile(
    r"^\s*(?:SYM_CODE_END|SYM_FUNC_END|ENDPROC|END)\s*\(\s*([A-Za-z_]\w*)\s*\)",
    re.MULTILINE,
)

# U-Boot / 部分 arch 使用的 linkage.h 入口宏
_UBOOT_ENTRY_RE = re.compile(
    r"^\s*(?:ENTRY|WEAK|LENTRY)\s*\(\s*([A-Za-z_]\w*)\s*\)",
    re.MULTILINE,
)

# 裸 .globl：需在后续若干行内出现同名 ``name:`` 标签（ENTRY 展开后也会命中，靠去重跳过）
_GLOBL_RE = re.compile(r"^\s*\.(?:globl|global)\s+([A-Za-z_]\w*)\b", re.MULTILINE)
_LABEL_LINE_RE = re.compile(r"^([A-Za-z_]\w*)\s*:")

# 汇编「调用」：bl/call/jal 等直接符号；单独一行的 ``b label``（排除 b.eq 等条件分支写法）
_CALL_RE = re.compile(
    r"^\s+(?:bl|call|jal)\s+([A-Za-z_]\w*)\b",
    re.MULTILINE,
)
_BRANCH_RE = re.compile(
    r"^\s+b\s+([A-Za-z_]\w*)\b",
    re.MULTILINE,
)

# 条件分支助记符，避免误当调用（虽与 _BRANCH_RE 模式不重叠，保留作过滤）
_ASM_SKIP = frozenset(
    {
        "if", "else", "endif", "macro", "endm", "include", "section",
        "globl", "global", "type", "size", "align", "byte", "word",
        "long", "quad", "ascii", "asciz", "string", "rept", "endr",
    }
)


def _line_no(text: str, index: int) -> int:
    return text.count("\n", 0, index) + 1


def _strip_asm_comment(line: str) -> str:
    """去掉行尾 @ / // 注释，便于匹配标签行。"""
    if "@" in line:
        line = line.split("@", 1)[0]
    if "//" in line:
        line = line.split("//", 1)[0]
    return line.rstrip()


def _find_label_line(lines: list[str], name: str, from_idx: int, lookahead: int = 12) -> int | None:
    """在 .globl 之后查找 ``name:`` 标签，返回 1-based 行号。"""
    end = min(from_idx + lookahead, len(lines))
    for i in range(from_idx, end):
        stripped = _strip_asm_comment(lines[i]).strip()
        m = _LABEL_LINE_RE.match(stripped)
        if m and m.group(1) == name:
            return i + 1
    return None


class AsmAdapter(LanguageAdapter):
    name = "asm"
    extensions = (".s", ".S")
    symbol_kinds = ("function",)

    def extract_symbols(self, source: bytes, rel_path: str) -> list[Symbol]:
        text = source.decode("utf-8", errors="replace")
        lines = text.splitlines()

        ends: dict[str, int] = {}
        for m in _END_RE.finditer(text):
            ends[m.group(1)] = _line_no(text, m.start())

        entries: list[tuple[str, int, str]] = []
        seen: set[str] = set()

        def _add(name: str, line: int, sig: str) -> None:
            if name in seen:
                return
            seen.add(name)
            entries.append((name, line, sig))

        for m in _ENTRY_RE.finditer(text):
            _add(m.group(1), _line_no(text, m.start()), m.group(0).strip())
        for m in _UBOOT_ENTRY_RE.finditer(text):
            _add(m.group(1), _line_no(text, m.start()), m.group(0).strip())
        for m in _GLOBL_RE.finditer(text):
            name = m.group(1)
            if name in seen:
                continue
            globl_idx = _line_no(text, m.start()) - 1
            label_line = _find_label_line(lines, name, globl_idx)
            if label_line:
                _add(name, label_line, f".globl {name}")

        # 按行号排序，便于无显式 END 时推断结束行
        entries.sort(key=lambda x: x[1])
        entry_lines = [e[1] for e in entries]

        symbols: list[Symbol] = []
        for i, (name, start, sig) in enumerate(entries):
            end = ends.get(name)
            if end is None:
                if i + 1 < len(entry_lines):
                    end = max(start, entry_lines[i + 1] - 1)
                else:
                    end = len(lines) if lines else start
            symbols.append(
                Symbol(
                    name=name,
                    kind="function",
                    file=rel_path,
                    start_line=start,
                    end_line=end,
                    signature=sig[:160],
                    doc="",
                )
            )
        return symbols

    def extract_references(
        self, source: bytes, rel_path: str, start_line: int, end_line: int
    ) -> list[Reference]:
        text = source.decode("utf-8", errors="replace")
        lines = text.splitlines()
        if not lines:
            return []

        # 只解析目标行区间，保留全局行号
        chunk_start = max(0, start_line - 1)
        chunk_end = min(len(lines), end_line)
        refs: list[Reference] = []
        seen: set[tuple[str, int, int]] = set()

        def _scan_line(line: str, line_no: int, pattern: re.Pattern[str]) -> None:
            for m in pattern.finditer(line):
                name = m.group(1)
                if not name or name in _ASM_SKIP:
                    continue
                col = m.start(1) + 1
                key = (name, line_no, col)
                if key in seen:
                    continue
                seen.add(key)
                refs.append(
                    Reference(
                        name=name,
                        line=line_no,
                        col=col,
                        end_col=col + len(name),
                        ref_kind="direct",
                        receiver="",
                    )
                )

        for i in range(chunk_start, chunk_end):
            line = lines[i]
            line_no = i + 1
            _scan_line(line, line_no, _CALL_RE)
            _scan_line(line, line_no, _BRANCH_RE)

        return refs
