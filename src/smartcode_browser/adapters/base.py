"""语言适配器接口。

这是整个浏览器「语言无关」的关键抽象：引擎只与本接口打交道，
新增一种语言 == 实现一个子类，前端 / API / 索引 / 引擎均无需改动。

适配器只负责「从源码里提取结构」，不负责跨文件解析（那是索引层的事），
职责单一便于各语言独立演进。
"""

from __future__ import annotations

from abc import ABC, abstractmethod

from ..models import Reference, Symbol


class LanguageAdapter(ABC):
    """单一语言的语法提取器。

    子类需声明：
    - ``name``：语言标识（如 "c"）
    - ``extensions``：负责的文件后缀（含点，如 ".c"）
    - ``symbol_kinds``：本语言「可导航单元」的种类，用于前端图标/说明
    并实现两个提取方法。
    """

    name: str = "base"
    extensions: tuple[str, ...] = ()
    symbol_kinds: tuple[str, ...] = ()

    def handles(self, rel_path: str) -> bool:
        """该文件是否归本适配器处理（按后缀判断）。"""
        lower = rel_path.lower()
        return any(lower.endswith(ext) for ext in self.extensions)

    @abstractmethod
    def extract_symbols(self, source: bytes, rel_path: str) -> list[Symbol]:
        """提取文件中所有顶层可导航单元（函数/类/模块等）。

        用于：
        1) 构建跨文件符号索引（name -> 定义位置）
        2) 反查「某一行属于哪个符号」
        """
        raise NotImplementedError

    @abstractmethod
    def extract_references(
        self, source: bytes, rel_path: str, start_line: int, end_line: int
    ) -> list[Reference]:
        """提取 [start_line, end_line] 行范围内的调用/引用点。

        返回的 Reference 仅含名字与位置，解析交给索引层。
        行号 1-based，闭区间。
        """
        raise NotImplementedError

    def find_local_declaration(
        self, source: bytes, start_line: int, end_line: int, name: str
    ) -> int | None:
        """在某函数体 [start_line, end_line] 内查找局部变量/参数 name 的声明行。

        默认不支持（返回 None），由各语言适配器按需覆盖。
        用于「点变量 → 跳到其局部声明」，找不到再交给全局索引。
        """
        return None
