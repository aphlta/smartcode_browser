"""代码浏览器的语言无关数据模型。

这些 dataclass 是引擎、适配器、Web API 之间的统一契约。
之所以独立出来，是为了让「C 的函数」「Scala 的 def/class」「Verilog 的 module」
都能用同一套结构表达，从而前端和 API 完全不必感知语言差异。

所有行号均为 **1-based**（与编辑器、内核源码行号一致），列号同样 1-based。
"""

from __future__ import annotations

from dataclasses import asdict, dataclass, field


@dataclass
class Symbol:
    """一个「可导航单元」的定义。

    在不同语言里它可能是函数、方法、类、模块等，用 ``kind`` 区分。
    它是符号索引的基本条目，也是用户能在 Panel 中打开的目标。
    """

    name: str
    kind: str  # function / method / class / object / struct / module ...
    file: str  # 相对项目根的路径
    start_line: int
    end_line: int
    signature: str = ""
    # 紧邻定义上方的文档注释（如内核 /** */），便于 Panel 顶部展示
    doc: str = ""
    # 是否为「空实现/桩」（如内核 #ifndef 下的 static inline foo(void) { }）。
    # 解析候选排序时把空桩排到最后，优先指向真正的实现。
    empty: bool = False

    def to_dict(self) -> dict:
        return asdict(self)


@dataclass
class Reference:
    """函数/方法体内的一个调用点（被调符号出现的位置）。

    它只描述「在源码哪一行哪一列出现了名为 name 的调用」，
    解析到具体定义是索引层的职责（见 Definition / resolve）。
    """

    name: str
    line: int  # 出现行（1-based）
    col: int  # 起始列（1-based）
    end_col: int  # 结束列（1-based，用于前端精确高亮可点击区域）

    def to_dict(self) -> dict:
        return asdict(self)


@dataclass
class Definition:
    """引用解析后得到的候选定义位置。

    一个引用可能对应多个候选（如 C 的同名函数、Scala 的多处重载/混入），
    因此解析结果是 Definition 列表，由前端以「先选择再跳转」的方式呈现。
    """

    name: str
    file: str
    line: int
    kind: str = "function"
    signature: str = ""  # 供选择菜单展示，帮助分辨多个候选
    empty: bool = False  # 空实现/桩，菜单里标注，且排序靠后

    def to_dict(self) -> dict:
        return asdict(self)


@dataclass
class ResolvedReference:
    """一个引用 + 它的解析候选，打包发给前端。

    resolved=False 时前端应禁用点击或退化为「手动搜索」，
    绝不假装能跳转（静态解析存在天然盲区，诚实优于误导）。
    """

    name: str
    line: int
    col: int
    end_col: int
    resolved: bool
    candidates: list[Definition] = field(default_factory=list)

    def to_dict(self) -> dict:
        return {
            "name": self.name,
            "line": self.line,
            "col": self.col,
            "end_col": self.end_col,
            "resolved": self.resolved,
            "candidates": [c.to_dict() for c in self.candidates],
        }


@dataclass
class SymbolDetail:
    """打开一个符号时返回给前端的完整信息：定义元数据 + 源码 + 引用点。

    这是 Panel 渲染所需的一切：
    - 头部：name / file / signature / doc
    - 主体：lines（带绝对起始行号）
    - 可点击层：references（每个引用的位置与解析候选）
    """

    name: str
    kind: str
    file: str
    start_line: int
    end_line: int
    signature: str
    doc: str
    lines: list[str]  # 源码原始行（不含行号），前端按 start_line 叠加行号
    references: list[ResolvedReference]

    def to_dict(self) -> dict:
        return {
            "name": self.name,
            "kind": self.kind,
            "file": self.file,
            "start_line": self.start_line,
            "end_line": self.end_line,
            "signature": self.signature,
            "doc": self.doc,
            "lines": self.lines,
            "references": [r.to_dict() for r in self.references],
        }
