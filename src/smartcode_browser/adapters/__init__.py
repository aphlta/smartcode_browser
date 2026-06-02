"""语言适配器集合。

每种语言实现 ``LanguageAdapter`` 接口，引擎据此做到语言无关。
``get_adapter`` 按语言名返回单例适配器（适配器内部缓存了解析器，复用更快）。
"""

from __future__ import annotations

from .base import LanguageAdapter

_REGISTRY: dict[str, LanguageAdapter] = {}


def get_adapter(language: str) -> LanguageAdapter:
    """按语言名取适配器单例；未知语言抛 KeyError。

    延迟导入具体适配器，避免在缺少某语言 grammar 时整体导入失败。
    """
    language = language.lower()
    if language in _REGISTRY:
        return _REGISTRY[language]

    if language in ("c", "h", "cpp", "c++", "cc"):
        from .c_adapter import CAdapter

        adapter: LanguageAdapter = CAdapter()
    elif language in ("python", "py"):
        from .python_adapter import PythonAdapter

        adapter = PythonAdapter()
    elif language == "scala":
        from .scala_adapter import ScalaAdapter

        adapter = ScalaAdapter()
    elif language == "java":
        from .java_adapter import JavaAdapter

        adapter = JavaAdapter()
    else:
        raise KeyError(f"暂不支持的语言适配器: {language}")

    _REGISTRY[language] = adapter
    return adapter


def available_languages() -> list[str]:
    """返回当前可用的语言名（用于前端/诊断）。"""
    return ["c", "python", "java", "scala"]


__all__ = ["LanguageAdapter", "get_adapter", "available_languages"]
