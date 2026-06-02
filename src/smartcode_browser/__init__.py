"""SmartCode 级联代码浏览器 —— 语言无关、项目无关的 Web 代码导航工具。

- ``models``    符号 / 引用 / 定义
- ``adapters``  可插拔 tree-sitter 语言适配器
- ``registry``  多项目注册表
- ``index``     跨文件符号索引 + 全局 grep 回退
- ``engine``    引擎（供 Web API 调用）
- ``server``    FastAPI 后端 + 原生前端
"""

from __future__ import annotations

__version__ = "0.1.0"
__all__ = ["models", "adapters", "registry", "index", "engine"]
